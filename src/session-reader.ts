/**
 * Session file reader for parsing Claude SDK JSONL session files.
 * Used by terminal-watcher.ts to sync terminal activity to Slack.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Content block types found in JSONL files (verified from actual data).
 */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  thinking?: string;  // For thinking blocks
}

/**
 * Message structure in session JSONL files.
 * Note: Files contain 26+ types including queue-operation, progress,
 * file-history-snapshot, etc. We only care about user/assistant.
 */
export interface SessionFileMessage {
  type: string;  // 'user' | 'assistant' | 'queue-operation' | 'progress' | ...
  uuid: string;
  timestamp: string;
  sessionId: string;
  message?: {
    role: string;
    content: string | ContentBlock[];  // string for user, array for assistant
  };
  toolUseResult?: {
    type?: string;
    content?: string;
    filePath?: string;
    file?: {
      filePath?: string;
      content?: string;
    };
  };
}

/**
 * Get the path to a session's JSONL file.
 * Path format: ~/.claude/projects/{workingDirEncoded}/{sessionId}.jsonl
 */
export function getSessionFilePath(sessionId: string, workingDir: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

/**
 * Check if session file exists.
 */
export function sessionFileExists(sessionId: string, workingDir: string): boolean {
  const filePath = getSessionFilePath(sessionId, workingDir);
  return fs.existsSync(filePath);
}

/**
 * Find a session file by ID across all project directories.
 * Searches ~/.claude/projects/*\/{sessionId}.jsonl
 * Extracts working directory from first user message's `cwd` field.
 * Also extracts the LAST plan file path from assistant messages.
 *
 * The `cwd` field is 100% reliable and immutable:
 * - Present in every user message entry
 * - Never changes throughout a session (even if user runs `cd` commands)
 * - Always reflects the original working directory at session creation time
 *
 * @returns Object with filePath, workingDir, and planFilePath, or null if not found
 */
export function findSessionFile(sessionId: string): { filePath: string; workingDir: string; planFilePath: string | null } | null {
  const projectsDir = path.join(os.homedir(), '.claude/projects');

  // Check if projects directory exists
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  // Search all project directories for the session file
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionFilePath = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (!fs.existsSync(sessionFilePath)) continue;

    // Found the session file - extract cwd and plan file path
    try {
      const content = fs.readFileSync(sessionFilePath, 'utf-8');
      const lines = content.split('\n');

      let workingDir: string | null = null;
      let lastPlanFilePath: string | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          // Extract cwd from first user message
          if (parsed.type === 'user' && parsed.cwd && !workingDir) {
            workingDir = parsed.cwd;
          }

          // Track last plan file path from assistant messages
          if (parsed.type === 'assistant') {
            const planPath = extractPlanFilePathFromMessage(parsed);
            if (planPath) lastPlanFilePath = planPath;
          }
        } catch {
          // Skip malformed lines
          continue;
        }
      }

      // Session file exists but no user message with cwd found
      if (!workingDir) return null;

      return {
        filePath: sessionFilePath,
        workingDir,
        planFilePath: lastPlanFilePath,
      };
    } catch {
      // File read error
      return null;
    }
  }

  // Session file not found in any project directory
  return null;
}

/**
 * Get current file size (for initial offset).
 * Returns 0 if file doesn't exist.
 */
export function getFileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Read new messages from session file starting at byte offset.
 * Returns new messages and updated byte offset.
 *
 * IMPORTANT: Only returns complete lines to avoid partial JSON.
 * Handles race conditions by only consuming fully-parsed lines.
 */
export async function readNewMessages(
  filePath: string,
  fromOffset: number
): Promise<{ messages: SessionFileMessage[]; newOffset: number }> {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    return { messages: [], newOffset: fromOffset };
  }

  const stat = await fs.promises.stat(filePath);

  // No new data
  if (stat.size <= fromOffset) {
    return { messages: [], newOffset: fromOffset };
  }

  // Read only new bytes
  const bytesToRead = stat.size - fromOffset;
  const buffer = Buffer.alloc(bytesToRead);

  const fd = await fs.promises.open(filePath, 'r');
  try {
    await fd.read(buffer, 0, bytesToRead, fromOffset);
  } finally {
    await fd.close();
  }

  // Parse complete lines only
  const content = buffer.toString('utf-8');
  const lines = content.split('\n');
  const messages: SessionFileMessage[] = [];
  let bytesConsumed = 0;

  let isFirstLine = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) {
      bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
      continue;
    }

    try {
      const parsed = JSON.parse(line) as SessionFileMessage;

      // FILTER: Only user and assistant messages with content
      // Skip: queue-operation, progress, file-history-snapshot, etc.
      if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.message?.content) {
        messages.push(parsed);
      }

      bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
      isFirstLine = false;
    } catch {
      if (isFirstLine) {
        // First line may be partial (offset landed mid-line) - skip it
        bytesConsumed += Buffer.byteLength(line + '\n', 'utf-8');
        isFirstLine = false;
        continue;
      }
      // Incomplete JSON at end of file - stop here, don't consume
      break;
    }
  }

  return { messages, newOffset: fromOffset + bytesConsumed };
}

/**
 * Extract plan content from message if it's a plan file operation.
 * Checks tool inputs (Write, ExitPlanMode) and tool results (Read, Write).
 */
function extractPlanContent(msg: SessionFileMessage): string | null {
  // 1. Check toolUseResult for user messages (Read/Write results)
  if (msg.toolUseResult) {
    const tur = msg.toolUseResult;
    const filePath = tur.filePath || tur.file?.filePath;
    if (filePath?.includes('.claude/plans/')) {
      if (tur.content) return tur.content;
      if (tur.file?.content) return tur.file.content;
    }
  }

  // 2. Check tool_use inputs for assistant messages
  if (msg.message?.content && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.input) {
        const input = block.input as Record<string, unknown>;
        const filePath = (input.file_path || input.path) as string | undefined;

        // ExitPlanMode: input.plan
        if (block.name === 'ExitPlanMode' && input.plan) {
          return input.plan as string;
        }

        // Write to plans dir: input.content
        if (filePath?.includes('.claude/plans/') && input.content) {
          return input.content as string;
        }
      }
    }
  }
  return null;
}

/**
 * Extract text content from message, handling all content block types.
 */
export function extractTextContent(msg: SessionFileMessage): string {
  // Check for plan content first
  const planContent = extractPlanContent(msg);
  if (planContent) {
    return planContent;
  }

  if (!msg.message?.content) return '';

  // User messages have content as string, assistant messages have array
  if (typeof msg.message.content === 'string') {
    return msg.message.content;
  }

  const parts: string[] = [];

  for (const block of msg.message.content) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'tool_use':
        // Optionally show tool usage
        if (block.name) {
          parts.push(`[Tool: ${block.name}]`);
        }
        break;
      case 'thinking':
        // Skip thinking blocks - internal to Claude
        break;
      case 'tool_result':
        // Skip tool results - verbose
        break;
    }
  }

  return parts.join('\n');
}

/**
 * Find the index of a message by its UUID in a list of session messages.
 * Used by /ff command to determine where to start syncing missed messages.
 *
 * @returns Index of the message with matching UUID, or -1 if not found
 */
export function findMessageIndexByUuid(
  messages: SessionFileMessage[],
  uuid: string
): number {
  return messages.findIndex(m => m.uuid === uuid);
}

/**
 * Activity entry for /ff import - compatible with ActivityEntry in session-manager.ts
 */
export interface ImportedActivityEntry {
  timestamp: number;
  type: 'thinking' | 'tool_start' | 'generating';
  tool?: string;
  thinkingContent?: string;
  thinkingTruncated?: string;
  generatingChars?: number;
}

// Truncate length for thinking preview (matches blocks.ts)
const THINKING_TRUNCATE_LENGTH = 500;

/**
 * Build activity entries from a session file message.
 * Converts content blocks (thinking, tool_use, text) into ActivityEntry format
 * for display in activity log.
 *
 * @returns Array of activity entries (may be empty for user messages or messages with no activity)
 */
/**
 * Read the last user message UUID from a session file.
 * Used to capture the real SDK-assigned UUID for user messages,
 * which is needed for /ff to correctly filter out Slack-originated messages.
 *
 * @param sessionFilePath Path to the session JSONL file
 * @returns The UUID of the last user message, or null if not found
 */
export function readLastUserMessageUuid(sessionFilePath: string): string | null {
  if (!fs.existsSync(sessionFilePath)) return null;

  try {
    const content = fs.readFileSync(sessionFilePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Search from end to find last user TEXT input (not tool_result)
    // Tool results are also type: 'user' but have content[0].type === 'tool_result'
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === 'user' && parsed.uuid && parsed.message?.content) {
          // Check if this is actual user text input, not a tool_result
          const content = parsed.message.content;
          const isTextInput = typeof content === 'string' ||
            (Array.isArray(content) && content.length > 0 && content[0].type === 'text');
          if (isTextInput) {
            return parsed.uuid;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // File read error
    return null;
  }
  return null;
}

// ============================================================================
// Turn Grouping for /ff Fidelity
// ============================================================================

/**
 * A segment represents one activity→output pair within a turn.
 * Multiple text outputs in one turn create multiple segments.
 */
export interface TurnSegment {
  activityMessages: SessionFileMessage[];  // Activity before this text output
  textOutput: SessionFileMessage;          // Text that closes this segment
}

/**
 * A turn represents one user input and all associated Claude responses.
 * Used by /ff to post messages in the same pattern as the bot.
 * Supports multiple text outputs per turn (think → text → think → tools → text).
 */
export interface Turn {
  userInput: SessionFileMessage;           // User message that started turn
  segments: TurnSegment[];                 // Completed activity→output pairs
  trailingActivity: SessionFileMessage[];  // Activity after last text (in-progress)
  allMessageUuids: string[];               // ALL UUIDs in this turn (for deduplication)
}

/**
 * Check if turn is complete (no trailing activity - all segments closed).
 * In-progress turns have trailingActivity (activity after last text).
 */
export function isTurnComplete(turn: Turn): boolean {
  return turn.trailingActivity.length === 0 && turn.segments.length > 0;
}

/**
 * Check if user message content is actual user input (not tool_result).
 * User input: string content OR array with 'text' blocks
 * Tool result: array with 'tool_result' blocks
 */
function isUserTextInput(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return true;
  if (Array.isArray(content) && content.length > 0) {
    return content[0].type === 'text';
  }
  return false;
}

/**
 * Check if assistant message contains only activity (thinking/tools, no text).
 */
function isActivityOnlyMessage(msg: SessionFileMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.every(b => b.type === 'thinking' || b.type === 'tool_use');
}

/**
 * Check if assistant message contains text output.
 */
function hasTextOutput(msg: SessionFileMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(b => b.type === 'text' && b.text);
}

/**
 * Group messages into turns for turn-based posting.
 * A new turn starts at each user text input (not tool_result).
 * When text output is seen, a segment closes and a new one starts.
 *
 * @param messages - Array of session file messages
 * @returns Array of turns with chronological segments
 */
export function groupMessagesByTurn(messages: SessionFileMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let currentSegmentActivity: SessionFileMessage[] = [];

  for (const msg of messages) {
    if (msg.type === 'user' && msg.message?.content) {
      if (isUserTextInput(msg.message.content)) {
        // New turn starts - save previous turn if exists
        if (currentTurn) {
          // Move any remaining activity to trailingActivity
          currentTurn.trailingActivity = currentSegmentActivity;
          turns.push(currentTurn);
        }
        currentTurn = {
          userInput: msg,
          segments: [],
          trailingActivity: [],
          allMessageUuids: [msg.uuid],
        };
        currentSegmentActivity = [];
      }
      // tool_result messages don't start new turn - they're part of current turn
    } else if (msg.type === 'assistant' && currentTurn) {
      currentTurn.allMessageUuids.push(msg.uuid);

      if (isActivityOnlyMessage(msg)) {
        // Activity-only message - add to current segment's activity
        currentSegmentActivity.push(msg);
      } else if (hasTextOutput(msg)) {
        // Text output closes current segment
        currentTurn.segments.push({
          activityMessages: currentSegmentActivity,
          textOutput: msg,
        });
        currentSegmentActivity = []; // Start fresh for next segment
      }
    }
  }

  // Don't forget the last turn
  if (currentTurn) {
    // Move any remaining activity to trailingActivity
    currentTurn.trailingActivity = currentSegmentActivity;
    turns.push(currentTurn);
  }

  return turns;
}

// ============================================================================
// Plan File Path Detection (shared by @bot and /watch)
// ============================================================================

/**
 * Extract plan file path from tool input.
 * Works for ANY tool - Write, Edit, Read, Grep, Glob, etc.
 * Single source of truth for both @bot and /watch.
 */
export function extractPlanFilePathFromInput(
  input: Record<string, unknown> | undefined
): string | null {
  if (!input) return null;
  const planPath = (input.file_path || input.path) as string | undefined;
  // Must be a file (ends with .md), not a directory
  if (typeof planPath === 'string' &&
      planPath.includes('.claude/plans/') &&
      planPath.endsWith('.md')) {
    return planPath;
  }
  return null;
}

/**
 * Extract plan file path from a session message.
 * Scans all tool_use blocks for plan file paths.
 */
export function extractPlanFilePathFromMessage(
  msg: SessionFileMessage
): string | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      const path = extractPlanFilePathFromInput(block.input as Record<string, unknown>);
      if (path) return path;
    }
  }
  return null;
}

/**
 * Check if message contains ExitPlanMode tool call.
 */
export function hasExitPlanMode(msg: SessionFileMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(b => b.type === 'tool_use' && b.name === 'ExitPlanMode');
}

export function buildActivityEntriesFromMessage(msg: SessionFileMessage): ImportedActivityEntry[] {
  const entries: ImportedActivityEntry[] = [];
  const timestamp = new Date(msg.timestamp).getTime();

  // User messages don't generate activity entries
  if (msg.type !== 'assistant') {
    return entries;
  }

  const content = msg.message?.content;
  if (!content || typeof content === 'string') {
    return entries;
  }

  for (const block of content) {
    switch (block.type) {
      case 'thinking': {
        const thinkingContent = block.thinking || '';
        const thinkingTruncated = thinkingContent.length > THINKING_TRUNCATE_LENGTH
          ? thinkingContent.substring(0, THINKING_TRUNCATE_LENGTH) + '...'
          : thinkingContent;
        entries.push({
          timestamp,
          type: 'thinking',
          thinkingContent,
          thinkingTruncated,
        });
        break;
      }
      case 'tool_use': {
        if (block.name) {
          entries.push({
            timestamp,
            type: 'tool_start',
            tool: block.name,
          });
        }
        break;
      }
      case 'text': {
        if (block.text) {
          entries.push({
            timestamp,
            type: 'generating',
            generatingChars: block.text.length,
          });
        }
        break;
      }
      // tool_result blocks are skipped (they're verbose and not user-facing)
    }
  }

  return entries;
}
