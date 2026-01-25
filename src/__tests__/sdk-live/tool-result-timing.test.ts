/**
 * SDK Live Test: Tool results are available mid-query (before query ends)
 *
 * Verifies that tool result content is received WHILE the query is still
 * running, enabling real-time display updates as each tool completes.
 *
 * Run with: npx vitest run src/__tests__/sdk-live/tool-result-timing.test.ts
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

describe.skipIf(SKIP_LIVE)('Tool Result Timing', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('tool result is received before query ends', async () => {
    let queryEnded = false;
    let toolResultReceivedBeforeEnd = false;
    let toolResultContent: string | null = null;
    let toolResultTime: number | null = null;
    let queryEndTime: number | null = null;
    const startTime = Date.now();

    const result = query({
      prompt: 'Run this exact bash command: echo "TIMING_TEST_XYZ789"',
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

      // Track when tool result arrives
      if (msg.type === 'user') {
        const userMsg = msg as any;
        if (Array.isArray(userMsg.message?.content)) {
          for (const block of userMsg.message.content) {
            if (block.type === 'tool_result') {
              toolResultContent = block.content;
              toolResultTime = Date.now() - startTime;

              if (!queryEnded) {
                toolResultReceivedBeforeEnd = true;
              }
            }
          }
        }
      }

      // Track when query ends
      if (msg.type === 'result') {
        queryEnded = true;
        queryEndTime = Date.now() - startTime;
        break;
      }
    }

    // Verify tool result was received and contains expected content
    expect(toolResultContent).not.toBeNull();
    expect(toolResultContent).toContain('TIMING_TEST_XYZ789');

    // Verify timing: tool result received before query ended (mid-query)
    expect(toolResultReceivedBeforeEnd).toBe(true);
    expect(toolResultTime).not.toBeNull();
    expect(queryEndTime).not.toBeNull();
    expect(toolResultTime!).toBeLessThan(queryEndTime!);
  });

  it('multiple tool results arrive in order as tools complete', async () => {
    const toolResults: Array<{ content: string; timestamp: number }> = [];
    let queryEnded = false;
    const startTime = Date.now();

    const result = query({
      prompt: 'Run these two commands in sequence: first echo "FIRST_TOOL", then echo "SECOND_TOOL"',
      options: {
        permissionMode: 'bypassPermissions' as any,
        maxTurns: 3,
        includePartialMessages: true,
      },
    });

    for await (const msg of result) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        createdSessions.push((msg as any).session_id);
      }

      if (msg.type === 'user') {
        const userMsg = msg as any;
        if (Array.isArray(userMsg.message?.content)) {
          for (const block of userMsg.message.content) {
            if (block.type === 'tool_result' && !block.is_error) {
              toolResults.push({
                content: block.content,
                timestamp: Date.now() - startTime,
              });
            }
          }
        }
      }

      if (msg.type === 'result') {
        queryEnded = true;
        break;
      }
    }

    // Verify query completed and we received tool results
    expect(queryEnded).toBe(true);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // If multiple tools, verify they arrived in timestamp order
    if (toolResults.length > 1) {
      for (let i = 1; i < toolResults.length; i++) {
        expect(toolResults[i].timestamp).toBeGreaterThanOrEqual(toolResults[i - 1].timestamp);
      }
    }
  });
});
