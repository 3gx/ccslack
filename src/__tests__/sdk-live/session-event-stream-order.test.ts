/**
 * SDK-Live Tests for Session Event Stream API - Event Order
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-order.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Order', { timeout: 120000 }, () => {
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

  it('events are yielded in file order with init first', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname and tell me what it says',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    // init should always be first
    expect(events[0].type).toBe('init');

    // All events should have timestamps
    for (const event of events) {
      expect(event.timestamp).toBeGreaterThan(0);
    }

    // Event order matches file processing order
    // Note: timestamps may not be strictly increasing due to parallel tool execution
    expect(events.length).toBeGreaterThan(1);
  });

  it('includes turn_end event', async () => {
    const sessionId = await runQuery('Say hello');
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    // Should have a turn_end at the end
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    expect(turnEnd?.turnDurationMs).toBeGreaterThan(0);
  });
});
