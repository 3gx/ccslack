/**
 * SDK-Live Tests for Session Event Stream API - SDK Parity (Tools)
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-parity-tools.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Parity Tools', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('PARITY: tool_use counts match between SDK stream_event and JSONL reader', async () => {
    const sdkCounts = { toolUseBlocks: 0, toolNames: [] as string[] };

    const q = query({
      prompt: 'Read /etc/hostname, then read /etc/os-release, explain both',
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
          sdkCounts.toolUseBlocks++;
          if (event.content_block.name) {
            sdkCounts.toolNames.push(event.content_block.name);
          }
        }
      }

      if (msg.type === 'result') break;
    }

    const filePath = getSessionFilePath(sessionId!);
    const jsonlEvents = await readAllSessionEvents(filePath);
    const jsonlToolStarts = jsonlEvents.filter((e) => e.type === 'tool_start');

    console.log(`SDK stream_event tool_use count: ${sdkCounts.toolUseBlocks}`);
    console.log(`JSONL reader tool_start count: ${jsonlToolStarts.length}`);

    expect(jsonlToolStarts.length).toBe(sdkCounts.toolUseBlocks);

    const sdkToolSet = new Set(sdkCounts.toolNames);
    const jsonlToolSet = new Set(jsonlToolStarts.map((e) => e.toolName));
    expect(jsonlToolSet).toEqual(sdkToolSet);
  });
});
