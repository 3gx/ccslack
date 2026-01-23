/**
 * SDK-Live Tests for Session Event Stream API - Text Events
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-text.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Text', { timeout: 120000 }, () => {
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

  it('yields text event with content', async () => {
    const sessionId = await runQuery('Say exactly: "test output"');
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.charCount).toBeGreaterThan(0);
    expect(textEvent?.textContent).toBeDefined();
  });

  it('handles session with only text response (no tools)', async () => {
    const sessionId = await runQuery('What is 2+2? Answer with just the number.');
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    // Should have init, text, turn_end
    expect(events.some((e) => e.type === 'init')).toBe(true);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);

    // Should NOT have tool events
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(events.some((e) => e.type === 'tool_complete')).toBe(false);
  });
});
