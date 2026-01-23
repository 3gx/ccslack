/**
 * SDK-Live Tests for /ff Activity - Thinking
 *
 * Run with: npm test -- src/__tests__/sdk-live/ff-activity-thinking.test.ts
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

describe.skipIf(SKIP_LIVE)('/ff Activity - Thinking', { timeout: 120000 }, () => {
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

  it('thinking entries include thinkingContent and thinkingTruncated', async () => {
    const sessionId = await runQuery('Think about what 2+2 equals', {
      maxThinkingTokens: 1000,
    });
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const thinkingEntries = activityLog.filter((a) => a.type === 'thinking');

    if (thinkingEntries.length > 0) {
      expect(thinkingEntries[0].thinkingContent).toBeDefined();
      expect(thinkingEntries[0].thinkingTruncated).toBeDefined();
      expect(thinkingEntries[0].thinkingInProgress).toBe(false);
    }
  });
});
