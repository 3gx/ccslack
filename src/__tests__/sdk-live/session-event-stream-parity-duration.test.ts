/**
 * SDK-Live Tests for Session Event Stream API - SDK Parity (Duration)
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-parity-duration.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Parity Duration', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('PARITY: tool_complete has valid duration after tool_result', async () => {
    let toolUseBlocks = 0;

    const q = query({
      prompt: 'Use Bash to run: sleep 0.2 && echo done',
      options: {
        maxTurns: 1,
        permissionMode: 'bypassPermissions' as any,
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
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          toolUseBlocks++;
        }
      }

      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const jsonlEvents = await readAllSessionEvents(filePath);
    const toolCompletes = jsonlEvents.filter((e) => e.type === 'tool_complete');

    expect(toolCompletes.length).toBe(toolUseBlocks);

    for (const tc of toolCompletes) {
      expect(tc.durationMs).toBeDefined();
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
    }

    const bashComplete = toolCompletes.find((e) => e.toolName === 'Bash');
    if (bashComplete) {
      expect(bashComplete.durationMs).toBeGreaterThanOrEqual(150);
    }
  });
});
