/**
 * SDK-Live Tests for Interleaved Segments - Multi-Tool
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/interleaved-segments-multi-tool.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readNewMessages, groupMessagesByTurn } from '../../session-reader.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Interleaved Segments - Multi-Tool', { timeout: 180000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('multi-tool query produces multiple segments', async () => {
    const q = query({
      prompt: 'First say "Starting", then run "echo hello", then say "Done"',
      options: {
        maxTurns: 2,
        permissionMode: 'bypassPermissions' as any,
      },
    });

    let sessionId: string | null = null;
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        createdSessions.push(sessionId);
      }
      if (msg.type === 'result') break;
    }

    expect(sessionId).toBeTruthy();
    const filePath = getSessionFilePath(sessionId!);

    const { messages } = await readNewMessages(filePath, 0);
    const turns = groupMessagesByTurn(messages);

    expect(turns.length).toBe(1);
    const turn = turns[0];

    expect(turn.segments.length).toBeGreaterThanOrEqual(2);

    console.log(`Turn has ${turn.segments.length} segments`);
    for (let i = 0; i < turn.segments.length; i++) {
      const seg = turn.segments[i];
      const textContent = seg.textOutput.message?.content;
      const textStr = Array.isArray(textContent)
        ? textContent.find(b => b.type === 'text')?.text || ''
        : textContent;
      console.log(`Segment ${i + 1}: ${seg.activityMessages.length} activity messages, text: "${textStr?.substring(0, 50)}..."`);
    }

    const textOutputs = turn.segments.map(s => s.textOutput);
    const uniqueUuids = new Set(textOutputs.map(t => t.uuid));
    expect(uniqueUuids.size).toBe(turn.segments.length);

    if (turn.segments.length >= 2) {
      const text1 = turn.segments[0].textOutput.uuid;
      const text2 = turn.segments[1].textOutput.uuid;
      expect(text1).not.toEqual(text2);
    }
  });
});
