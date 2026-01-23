/**
 * SDK-Live Tests for Session Event Stream API - SDK Parity (Mixed)
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-parity-mixed.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readAllSessionEvents } from '../../session-event-stream.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Session Event Stream - Parity Mixed', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('PARITY: mixed session (tools + text + thinking) - JSONL captures all SDK events', async () => {
    const sdkCounts = { toolUseBlocks: 0, thinkingBlocks: 0, textBlocks: 0 };

    const q = query({
      prompt: 'Think about what file to read, then read /etc/hostname, explain what you found',
      options: {
        maxTurns: 1,
        permissionMode: 'bypassPermissions' as any,
        maxThinkingTokens: 1000,
        includePartialMessages: true,
      },
    });

    let sessionId: string | null = null;

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }

      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_start') {
          if (event.content_block?.type === 'thinking') sdkCounts.thinkingBlocks++;
          if (event.content_block?.type === 'tool_use') sdkCounts.toolUseBlocks++;
          if (event.content_block?.type === 'text') sdkCounts.textBlocks++;
        }
      }

      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const jsonlEvents = await readAllSessionEvents(filePath);

    const jsonlToolStarts = jsonlEvents.filter((e) => e.type === 'tool_start');
    const jsonlThinkingStarts = jsonlEvents.filter((e) => e.type === 'thinking_start');
    const jsonlTextEvents = jsonlEvents.filter((e) => e.type === 'text');

    console.log('=== SDK stream_event counts ===');
    console.log(`  tools: ${sdkCounts.toolUseBlocks}`);
    console.log(`  thinking: ${sdkCounts.thinkingBlocks}`);
    console.log(`  text: ${sdkCounts.textBlocks}`);

    console.log('=== JSONL reader counts ===');
    console.log(`  tools: ${jsonlToolStarts.length}`);
    console.log(`  thinking: ${jsonlThinkingStarts.length}`);
    console.log(`  text: ${jsonlTextEvents.length}`);

    expect(jsonlToolStarts.length).toBeGreaterThanOrEqual(sdkCounts.toolUseBlocks);
    expect(jsonlThinkingStarts.length).toBeGreaterThanOrEqual(sdkCounts.thinkingBlocks);
    expect(jsonlTextEvents.length).toBeGreaterThanOrEqual(sdkCounts.textBlocks);

    const jsonlToolCompletes = jsonlEvents.filter((e) => e.type === 'tool_complete');
    expect(jsonlToolStarts.length).toBe(jsonlToolCompletes.length);
  });
});
