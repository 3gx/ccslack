/**
 * Session Event Stream API
 *
 * Reads session JSONL files and yields SDK-like events via async generator.
 * This API provides a clean interface for watching session activity in real-time
 * or reading all events from a completed session.
 */

import * as fs from 'fs';

/**
 * Event types yielded by the session event stream.
 * Mirrors SDK stream_event structure.
 */
export interface SessionEvent {
  type:
    | 'init'
    | 'thinking_start'
    | 'thinking_complete'
    | 'tool_start'
    | 'tool_complete'
    | 'text'
    | 'turn_end';
  timestamp: number;

  // For init
  sessionId?: string;

  // For thinking
  thinkingContent?: string;

  // For tool_start and tool_complete
  toolName?: string;
  toolId?: string;
  durationMs?: number; // Only on tool_complete

  // For text
  textContent?: string;
  charCount?: number;

  // For turn_end
  turnDurationMs?: number;
}

/**
 * Options for watching a session file.
 */
export interface WatchSessionOptions {
  /** Byte offset to start reading from (default: 0) */
  fromOffset?: number;
  /** Poll interval in ms (default: 500) */
  pollIntervalMs?: number;
  /** Abort signal to stop watching */
  signal?: AbortSignal;
}

/**
 * Content block types in JSONL files.
 */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  id?: string; // Present on tool_use blocks
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  thinking?: string;
}

/**
 * Message structure in session JSONL files.
 */
interface SessionFileMessage {
  type: string;
  uuid: string;
  timestamp: string;
  sessionId: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
}

/**
 * Pending tool info for FIFO matching.
 */
interface PendingTool {
  name: string;
  id?: string;
  startTimestamp: number;
}

/**
 * State for event stream processing.
 */
interface StreamState {
  initialized: boolean;
  sessionId: string | null;
  pendingTools: PendingTool[];
  turnStartTimestamp: number | null;
  lastAssistantTimestamp: number | null;
}

/**
 * Read bytes from file starting at offset.
 */
async function readBytesFromOffset(
  filePath: string,
  fromOffset: number
): Promise<{ content: string; bytesRead: number } | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = await fs.promises.stat(filePath);
  if (stat.size <= fromOffset) {
    return null;
  }

  const bytesToRead = stat.size - fromOffset;
  const buffer = Buffer.alloc(bytesToRead);

  const fd = await fs.promises.open(filePath, 'r');
  try {
    await fd.read(buffer, 0, bytesToRead, fromOffset);
  } finally {
    await fd.close();
  }

  return { content: buffer.toString('utf-8'), bytesRead: bytesToRead };
}

/**
 * Parse complete JSONL lines from content.
 * Returns parsed messages and bytes consumed.
 */
function parseJsonlLines(
  content: string,
  isFirstRead: boolean
): { messages: SessionFileMessage[]; bytesConsumed: number } {
  const lines = content.split('\n');
  const messages: SessionFileMessage[] = [];
  let bytesConsumed = 0;
  let isFirstLine = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    // Empty lines: if it's the last element from split(), it's just a trailing newline artifact
    // and doesn't represent actual bytes to consume (the newline was already counted)
    if (!line.trim()) {
      if (!isLastLine) {
        // Empty line in the middle - consume it (blank line between entries)
        bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
      }
      // For last empty line, don't add any bytes - it's just split() artifact
      continue;
    }

    try {
      const parsed = JSON.parse(line) as SessionFileMessage;

      // Only care about user and assistant messages with content
      if (
        (parsed.type === 'user' || parsed.type === 'assistant') &&
        parsed.message?.content
      ) {
        messages.push(parsed);
      }

      bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
      isFirstLine = false;
    } catch {
      if (isFirstLine && isFirstRead) {
        // First line may be partial if offset landed mid-line - skip it
        bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
        isFirstLine = false;
        continue;
      }
      if (isLastLine) {
        // Last line may be incomplete - stop here without consuming it
        break;
      }
      // Malformed JSON in middle of file - skip it and continue
      bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
    }
  }

  return { messages, bytesConsumed };
}

/**
 * Check if user message represents actual user input (not tool results).
 * In SDK JSONL files, user input can be a string OR an array with text blocks.
 * Tool results are arrays containing tool_result blocks.
 */
function isUserTextInput(content: string | ContentBlock[]): boolean {
  // Direct string content is user input
  if (typeof content === 'string') {
    return true;
  }

  // Array content: check if it's text blocks (user input) or tool_result blocks
  if (Array.isArray(content) && content.length > 0) {
    // If the first block is 'text', it's user input
    // If it's 'tool_result', it's a tool response
    const firstBlock = content[0];
    return firstBlock.type === 'text';
  }

  return false;
}

/**
 * Process a single message and yield events.
 */
function* processMessage(
  msg: SessionFileMessage,
  state: StreamState
): Generator<SessionEvent> {
  const timestamp = new Date(msg.timestamp).getTime();

  // First message initializes the stream
  if (!state.initialized) {
    state.initialized = true;
    state.sessionId = msg.sessionId;
    yield {
      type: 'init',
      timestamp,
      sessionId: msg.sessionId,
    };
  }

  // User message with string content indicates turn boundary
  if (msg.type === 'user' && msg.message?.content) {
    if (isUserTextInput(msg.message.content)) {
      // Emit turn_end for previous turn if we have one
      if (state.turnStartTimestamp !== null && state.lastAssistantTimestamp !== null) {
        yield {
          type: 'turn_end',
          timestamp: state.lastAssistantTimestamp,
          turnDurationMs: state.lastAssistantTimestamp - state.turnStartTimestamp,
        };
      }
      // Start new turn
      state.turnStartTimestamp = timestamp;
      state.lastAssistantTimestamp = null;
    } else {
      // User message with array content (tool results)
      const content = msg.message.content as ContentBlock[];
      for (const block of content) {
        if (block.type === 'tool_result') {
          // FIFO match with pending tool
          const toolInfo = state.pendingTools.shift();
          if (toolInfo) {
            yield {
              type: 'tool_complete',
              timestamp,
              toolName: toolInfo.name,
              toolId: toolInfo.id,
              durationMs: timestamp - toolInfo.startTimestamp,
            };
          }
        }
      }
    }
    return;
  }

  // Assistant message - process content blocks
  if (msg.type === 'assistant' && msg.message?.content) {
    state.lastAssistantTimestamp = timestamp;

    const content = msg.message.content;
    if (typeof content === 'string') {
      // Simple text response
      yield {
        type: 'text',
        timestamp,
        textContent: content,
        charCount: content.length,
      };
      return;
    }

    // Array of content blocks
    for (const block of content) {
      switch (block.type) {
        case 'thinking':
          // Emit both start and complete for thinking (we see the full block)
          yield {
            type: 'thinking_start',
            timestamp,
          };
          yield {
            type: 'thinking_complete',
            timestamp,
            thinkingContent: block.thinking,
          };
          break;

        case 'tool_use':
          state.pendingTools.push({
            name: block.name || 'unknown',
            id: block.id,
            startTimestamp: timestamp,
          });
          yield {
            type: 'tool_start',
            timestamp,
            toolName: block.name,
            toolId: block.id,
          };
          break;

        case 'text':
          if (block.text) {
            yield {
              type: 'text',
              timestamp,
              textContent: block.text,
              charCount: block.text.length,
            };
          }
          break;

        // tool_result blocks in assistant messages are rare but possible
        case 'tool_result':
          // Handle inline tool results (shouldn't happen often)
          break;
      }
    }
  }
}

/**
 * Create initial stream state.
 */
function createInitialState(): StreamState {
  return {
    initialized: false,
    sessionId: null,
    pendingTools: [],
    turnStartTimestamp: null,
    lastAssistantTimestamp: null,
  };
}

/**
 * Read all events from a session file (for /ff-style batch processing).
 *
 * @param sessionFilePath - Path to session JSONL file
 * @returns Array of all events in the session
 */
export async function readAllSessionEvents(
  sessionFilePath: string
): Promise<SessionEvent[]> {
  const result = await readBytesFromOffset(sessionFilePath, 0);
  if (!result) {
    return [];
  }

  const { messages } = parseJsonlLines(result.content, false);
  const events: SessionEvent[] = [];
  const state = createInitialState();

  for (const msg of messages) {
    for (const event of processMessage(msg, state)) {
      events.push(event);
    }
  }

  // Emit final turn_end if we have an incomplete turn
  if (state.turnStartTimestamp !== null && state.lastAssistantTimestamp !== null) {
    events.push({
      type: 'turn_end',
      timestamp: state.lastAssistantTimestamp,
      turnDurationMs: state.lastAssistantTimestamp - state.turnStartTimestamp,
    });
  }

  return events;
}

/**
 * Watch a session file and yield events as they occur.
 * Behaves like SDK query() - returns async generator.
 *
 * @param sessionFilePath - Path to session JSONL file
 * @param options - Watch options
 * @yields SessionEvent objects as activity occurs
 */
export async function* watchSessionEvents(
  sessionFilePath: string,
  options?: WatchSessionOptions
): AsyncGenerator<SessionEvent, void, unknown> {
  const fromOffset = options?.fromOffset ?? 0;
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const signal = options?.signal;

  let currentOffset = fromOffset;
  const state = createInitialState();
  // When starting from offset, we're resuming mid-session - don't emit init
  if (fromOffset > 0) {
    state.initialized = true;
  }
  let isFirstRead = fromOffset > 0;

  // Helper to sleep with abort support
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const timeout = setTimeout(resolve, ms);

      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
    });

  while (!signal?.aborted) {
    const result = await readBytesFromOffset(sessionFilePath, currentOffset);

    if (result) {
      const { messages, bytesConsumed } = parseJsonlLines(result.content, isFirstRead);
      isFirstRead = false;
      currentOffset += bytesConsumed;

      for (const msg of messages) {
        for (const event of processMessage(msg, state)) {
          yield event;
        }
      }
    }

    await sleep(pollIntervalMs);
  }

  // On abort, emit final turn_end if applicable
  if (state.turnStartTimestamp !== null && state.lastAssistantTimestamp !== null) {
    yield {
      type: 'turn_end',
      timestamp: state.lastAssistantTimestamp,
      turnDurationMs: state.lastAssistantTimestamp - state.turnStartTimestamp,
    };
  }
}

// ============================================================================
// Bot Integration: ActivityEntry Conversion
// ============================================================================

/**
 * Truncation length for thinking preview (matches blocks.ts THINKING_TRUNCATE_LENGTH).
 */
const THINKING_TRUNCATE_LENGTH = 500;

/**
 * ActivityEntry type compatible with session-manager.ts.
 * Used by /watch and /ff commands to display activity logs.
 */
export interface ActivityEntry {
  timestamp: number;
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'error' | 'generating' | 'aborted' | 'mode_changed' | 'context_cleared' | 'session_changed';
  tool?: string;
  durationMs?: number;
  message?: string;
  // For thinking blocks
  thinkingContent?: string;
  thinkingTruncated?: string;
  thinkingInProgress?: boolean;
  // For generating (text streaming)
  generatingChunks?: number;
  generatingChars?: number;
  generatingInProgress?: boolean;
  generatingContent?: string;   // Full response text (stored for modal/download)
  generatingTruncated?: string; // First 500 chars (for live display)
  // Tool input (populated at content_block_stop)
  toolInput?: Record<string, unknown>;
  toolUseId?: string;           // For matching with tool_result
  // Result metrics (populated when user message with tool_result arrives)
  lineCount?: number;           // Read/Write: lines in result/content
  matchCount?: number;          // Grep/Glob: number of matches/files
  linesAdded?: number;          // Edit: lines in new_string
  linesRemoved?: number;        // Edit: lines in old_string
  // Execution timing (for accurate duration display)
  toolCompleteTimestamp?: number;    // When content_block_stop fired
  toolResultTimestamp?: number;      // When tool_result arrived
  executionDurationMs?: number;      // Actual execution time
  // Tool output (populated when tool_result arrives)
  toolOutput?: string;               // Full output (up to 50KB)
  toolOutputPreview?: string;        // First 300 chars for display
  toolOutputTruncated?: boolean;     // True if output was truncated
  toolIsError?: boolean;             // True if tool returned error
  toolErrorMessage?: string;         // Error message if failed
  mode?: string;                     // For mode_changed entries
  previousSessionId?: string;        // For session_changed entries
  // Thread message linking (for clickable activity in main status)
  threadMessageTs?: string;          // Slack ts of thread message for this activity
  threadMessageLink?: string;        // Permalink URL to thread message
}

/**
 * Convert a SessionEvent to an ActivityEntry for bot integration.
 * Used by /watch and /ff commands to build activity logs from session files.
 *
 * @param event - SessionEvent from readAllSessionEvents or watchSessionEvents
 * @returns ActivityEntry compatible with session-manager.ts, or null for non-activity events
 */
export function sessionEventToActivityEntry(event: SessionEvent): ActivityEntry | null {
  switch (event.type) {
    case 'thinking_complete':
      // Only emit activity for complete thinking (has content)
      if (event.thinkingContent) {
        const thinkingTruncated =
          event.thinkingContent.length > THINKING_TRUNCATE_LENGTH
            ? event.thinkingContent.substring(0, THINKING_TRUNCATE_LENGTH) + '...'
            : event.thinkingContent;
        return {
          timestamp: event.timestamp,
          type: 'thinking',
          thinkingContent: event.thinkingContent,
          thinkingTruncated,
          thinkingInProgress: false,
        };
      }
      return null;

    case 'tool_start':
      return {
        timestamp: event.timestamp,
        type: 'tool_start',
        tool: event.toolName,
      };

    case 'tool_complete':
      return {
        timestamp: event.timestamp,
        type: 'tool_complete',
        tool: event.toolName,
        durationMs: event.durationMs,
      };

    case 'text':
      // Text events become generating entries
      if (event.charCount && event.charCount > 0) {
        const textContent = event.textContent || '';
        const generatingTruncated = textContent.length > THINKING_TRUNCATE_LENGTH
          ? textContent.substring(0, THINKING_TRUNCATE_LENGTH) + '...'
          : textContent;
        return {
          timestamp: event.timestamp,
          type: 'generating',
          generatingChars: event.charCount,
          generatingChunks: 1, // From JSONL we see complete blocks, not chunks
          generatingInProgress: false,
          generatingContent: textContent,
          generatingTruncated,
        };
      }
      return null;

    // These events don't map to ActivityEntry
    case 'init':
    case 'thinking_start':
    case 'turn_end':
      return null;

    default:
      return null;
  }
}

/**
 * Convert all SessionEvents from a session file to ActivityEntries.
 * Filters out non-activity events (init, turn_end, etc.).
 *
 * @param events - Array of SessionEvents
 * @returns Array of ActivityEntries for bot display
 */
export function sessionEventsToActivityLog(events: SessionEvent[]): ActivityEntry[] {
  const activityLog: ActivityEntry[] = [];

  for (const event of events) {
    const entry = sessionEventToActivityEntry(event);
    if (entry) {
      activityLog.push(entry);
    }
  }

  return activityLog;
}

/**
 * Read activity log directly from a session file.
 * Convenience function combining readAllSessionEvents + sessionEventsToActivityLog.
 *
 * @param sessionFilePath - Path to session JSONL file
 * @returns Array of ActivityEntries for bot display
 */
export async function readActivityLog(sessionFilePath: string): Promise<ActivityEntry[]> {
  const events = await readAllSessionEvents(sessionFilePath);
  return sessionEventsToActivityLog(events);
}
