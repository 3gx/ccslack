/**
 * SDK Live Test: Tool result content is available via user messages
 *
 * Verifies that tool results come via msg.type === 'user' with content array
 * containing { type: 'tool_result', content: '...', tool_use_id: '...' }
 *
 * Run with: npx vitest run src/__tests__/sdk-live/tool-result-content.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Tool Result Content', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('tool_result blocks in user messages contain actual content', async () => {
    let toolResultContent: string | null = null;
    let toolResultToolUseId: string | null = null;
    let toolUseIdFromStart: string | null = null;

    const result = query({
      prompt: 'Run this exact bash command: echo "CONTENT_TEST_ABC123"',
      options: {
        permissionMode: 'bypassPermissions' as any,
        maxTurns: 2,
        includePartialMessages: true,
      },
    });

    for await (const msg of result) {
      // Capture session for cleanup
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        createdSessions.push((msg as any).session_id);
      }

      // Capture tool_use_id from stream_event
      if (msg.type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          toolUseIdFromStart = event.content_block.id;
        }
      }

      // Check user messages for tool_result
      if (msg.type === 'user') {
        const userMsg = msg as any;
        if (Array.isArray(userMsg.message?.content)) {
          for (const block of userMsg.message.content) {
            if (block.type === 'tool_result') {
              toolResultContent = block.content;
              toolResultToolUseId = block.tool_use_id;
            }
          }
        }
      }

      if (msg.type === 'result') break;
    }

    // Verify tool_result was found in user message
    expect(toolResultContent).not.toBeNull();
    expect(typeof toolResultContent).toBe('string');
    expect(toolResultContent).toContain('CONTENT_TEST_ABC123');

    // Verify tool_use_id matches
    expect(toolResultToolUseId).toBe(toolUseIdFromStart);
  });

  it('Read tool result contains file contents for line counting', async () => {
    let toolResultContent: string | null = null;
    let toolName: string | null = null;

    const result = query({
      prompt: 'Read the file /etc/hosts',
      options: {
        permissionMode: 'bypassPermissions' as any,
        maxTurns: 2,
        includePartialMessages: true,
      },
    });

    for await (const msg of result) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        createdSessions.push((msg as any).session_id);
      }

      if (msg.type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          toolName = event.content_block.name;
        }
      }

      if (msg.type === 'user') {
        const userMsg = msg as any;
        if (Array.isArray(userMsg.message?.content)) {
          for (const block of userMsg.message.content) {
            if (block.type === 'tool_result' && !block.is_error) {
              toolResultContent = block.content;
            }
          }
        }
      }

      if (msg.type === 'result') break;
    }

    expect(toolName).toBe('Read');
    expect(toolResultContent).not.toBeNull();

    // Can count lines from result content
    const lineCount = toolResultContent!.split('\n').filter(l => l.length > 0).length;
    expect(lineCount).toBeGreaterThan(0);
  });
});
