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
 * Extract text content from message, handling all content block types.
 */
export function extractTextContent(msg: SessionFileMessage): string {
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
 * for display in View Log modal.
 *
 * @returns Array of activity entries (may be empty for user messages or messages with no activity)
 */
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
