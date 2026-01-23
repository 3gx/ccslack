/**
 * SDK-Live Tests for /ff Activity - Tool Pairs
 *
 * Run with: npm test -- src/__tests__/sdk-live/ff-activity-tool-pairs.test.ts
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

describe.skipIf(SKIP_LIVE)('/ff Activity - Tool Pairs', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  async function runQuery(
    prompt: string,
    options: { permissionMode?: string; maxThinkingTokens?: number } = {}
  ): Promise<string> {
    const q = query({
      prompt,
      options: {
        maxTurns: 1,
        permissionMode: options.permissionMode as any,
        maxThinkingTokens: options.maxThinkingTokens,
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

    if (!sessionId) {
      throw new Error('Failed to get session ID from query');
    }

    return sessionId;
  }

  it('tool_start and tool_complete are both present for each tool', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname and tell me what it says',
      { permissionMode: 'bypassPermissions' }
    );
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const toolStarts = activityLog.filter((a) => a.type === 'tool_start');
    const toolCompletes = activityLog.filter((a) => a.type === 'tool_complete');

    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolCompletes.length).toBeGreaterThan(0);
    expect(toolStarts.length).toBe(toolCompletes.length);
  });

  it('FIFO matching handles multiple tools correctly', async () => {
    const sessionId = await runQuery(
      'First read /etc/hostname, then read /etc/os-release, explain both',
      { permissionMode: 'bypassPermissions' }
    );
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const toolStarts = activityLog.filter((a) => a.type === 'tool_start');
    const toolCompletes = activityLog.filter((a) => a.type === 'tool_complete');

    expect(toolStarts.length).toBeGreaterThanOrEqual(2);
    expect(toolCompletes.length).toBe(toolStarts.length);

    for (const tc of toolCompletes) {
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
    }

    const readCompletes = toolCompletes.filter((a) => a.tool === 'Read');
    expect(readCompletes.length).toBeGreaterThanOrEqual(2);
  });
});
