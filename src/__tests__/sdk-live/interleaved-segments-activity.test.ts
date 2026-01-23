/**
 * SDK-Live Tests for Interleaved Segments - Activity Log
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/interleaved-segments-activity.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readActivityLog } from '../../session-event-stream.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Interleaved Segments - Activity', { timeout: 180000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('activity log has entries for each segment', async () => {
    const q = query({
      prompt: 'Say "First", run "echo test", say "Second"',
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
    const activityLog = await readActivityLog(filePath);

    console.log(`Activity log has ${activityLog.length} entries`);
    for (const entry of activityLog) {
      console.log(`  ${entry.type}: ${entry.type === 'tool_start' || entry.type === 'tool_complete' ? entry.toolName : ''}`);
    }

    const generatingEntries = activityLog.filter(e => e.type === 'generating' || e.type === 'text');
    expect(generatingEntries.length).toBeGreaterThanOrEqual(2);

    const toolStarts = activityLog.filter(e => e.type === 'tool_start');
    const toolCompletes = activityLog.filter(e => e.type === 'tool_complete');
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolCompletes.length).toBeGreaterThan(0);

    const types = activityLog.map(e => e.type);
    const genIndex1 = types.findIndex(t => t === 'generating' || t === 'text');
    const toolIndex = types.indexOf('tool_start');
    const genIndex2 = types.slice(toolIndex + 1).findIndex(t => t === 'generating' || t === 'text');

    if (genIndex1 !== -1 && toolIndex !== -1) {
      expect(genIndex1).toBeLessThan(toolIndex);
      console.log(`First text at index ${genIndex1}, tool at ${toolIndex}, second text at ${toolIndex + 1 + genIndex2}`);
    }
  });
});
