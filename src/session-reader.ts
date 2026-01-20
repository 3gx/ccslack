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
