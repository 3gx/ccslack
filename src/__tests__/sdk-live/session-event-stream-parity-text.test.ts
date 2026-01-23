/**
 * SDK-Live Tests for Session Event Stream API - SDK Parity (Text)
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-parity-text.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Parity Text', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('PARITY: text block counts match between SDK stream_event and JSONL reader', async () => {
    let textBlocks = 0;

    const q = query({
      prompt: 'Say exactly: "Hello World"',
      options: {
        maxTurns: 1,
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
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
          textBlocks++;
        }
      }

      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const jsonlEvents = await readAllSessionEvents(filePath);
    const jsonlTextEvents = jsonlEvents.filter((e) => e.type === 'text');

    console.log(`SDK stream_event text count: ${textBlocks}`);
    console.log(`JSONL reader text count: ${jsonlTextEvents.length}`);

    expect(jsonlTextEvents.length).toBe(textBlocks);
  });
});
