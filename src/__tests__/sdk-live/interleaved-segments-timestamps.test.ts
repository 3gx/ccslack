/**
 * SDK-Live Tests for Interleaved Segments - Timestamps
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/interleaved-segments-timestamps.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readActivityLog } from '../../session-event-stream.js';
import { readNewMessages, groupMessagesByTurn } from '../../session-reader.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Interleaved Segments - Timestamps', { timeout: 180000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('segment activity timestamps align with text output timestamps', async () => {
    const q = query({
      prompt: 'Say hello, run "echo hi", say goodbye',
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

    const filePath = getSessionFilePath(sessionId!);
    const { messages } = await readNewMessages(filePath, 0);
    const turns = groupMessagesByTurn(messages);
    const activityLog = await readActivityLog(filePath);

    const turn = turns[0];
    console.log(`Turn has ${turn.segments.length} segments`);
    console.log(`Activity log has ${activityLog.length} entries`);

    if (turn.segments.length >= 2) {
      const seg1End = new Date(turn.segments[0].textOutput.timestamp).getTime();
      const seg2End = new Date(turn.segments[1].textOutput.timestamp).getTime();
      const turnStart = new Date(turn.userInput.timestamp).getTime();

      console.log(`Turn start: ${turnStart}`);
      console.log(`Segment 1 end: ${seg1End} (delta: ${seg1End - turnStart}ms)`);
      console.log(`Segment 2 end: ${seg2End} (delta: ${seg2End - turnStart}ms)`);

      const seg1Activity = activityLog.filter(e =>
        e.timestamp >= turnStart && e.timestamp <= seg1End
      );
      const seg2Activity = activityLog.filter(e =>
        e.timestamp > seg1End && e.timestamp <= seg2End
      );

      console.log(`Segment 1 activity count: ${seg1Activity.length}`);
      console.log(`Segment 2 activity count: ${seg2Activity.length}`);

      expect(seg1Activity.length).toBeGreaterThan(0);
      expect(seg2Activity.length).toBeGreaterThan(0);
    }
  });
});
