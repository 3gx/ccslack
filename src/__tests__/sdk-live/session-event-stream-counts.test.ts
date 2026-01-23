/**
 * SDK-Live Tests for Session Event Stream API - Event Counts
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-counts.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Counts', { timeout: 120000 }, () => {
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
    options: { maxTurns?: number; permissionMode?: string; maxThinkingTokens?: number } = {}
  ): Promise<string> {
    const q = query({
      prompt,
      options: {
        maxTurns: options.maxTurns ?? 1,
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

  it('tool_start count equals tool_complete count', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname, read /etc/os-release, and read /etc/hosts',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    const toolCompletes = events.filter((e) => e.type === 'tool_complete');

    expect(toolStarts.length).toBe(toolCompletes.length);
  });
});
