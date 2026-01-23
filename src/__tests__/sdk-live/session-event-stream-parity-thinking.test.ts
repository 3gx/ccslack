/**
 * SDK-Live Tests for Session Event Stream API - SDK Parity (Thinking)
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-parity-thinking.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Parity Thinking', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('PARITY: thinking counts match between SDK stream_event and JSONL reader', async () => {
    let thinkingBlocks = 0;

    const q = query({
      prompt: 'Think carefully about what 7 * 8 equals',
      options: {
        maxTurns: 1,
        maxThinkingTokens: 2000,
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
        if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          thinkingBlocks++;
        }
      }

      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const jsonlEvents = await readAllSessionEvents(filePath);
    const jsonlThinkingStarts = jsonlEvents.filter((e) => e.type === 'thinking_start');

    console.log(`SDK stream_event thinking count: ${thinkingBlocks}`);
    console.log(`JSONL reader thinking_start count: ${jsonlThinkingStarts.length}`);

    expect(jsonlThinkingStarts.length).toBe(thinkingBlocks);
  });
});
