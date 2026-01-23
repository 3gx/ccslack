/**
 * SDK-Live Tests for /ff Activity - Structure
 *
 * Run with: npm test -- src/__tests__/sdk-live/ff-activity-structure.test.ts
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

describe.skipIf(SKIP_LIVE)('/ff Activity - Structure', { timeout: 120000 }, () => {
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

  it('activity log entries have proper ActivityEntry structure', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname and explain what you found',
      { permissionMode: 'bypassPermissions' }
    );
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    for (const entry of activityLog) {
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(['thinking', 'tool_start', 'tool_complete', 'generating']).toContain(entry.type);
    }

    const toolEntries = activityLog.filter(
      (a) => a.type === 'tool_start' || a.type === 'tool_complete'
    );
    for (const entry of toolEntries) {
      expect(entry.tool).toBeDefined();
    }
  });
});
