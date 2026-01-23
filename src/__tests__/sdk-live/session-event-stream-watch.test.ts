/**
 * SDK-Live Tests for Session Event Stream API - Watch API
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-watch.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readAllSessionEvents,
  watchSessionEvents,
  SessionEvent,
} from '../../session-event-stream.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('Session Event Stream - Watch', { timeout: 120000 }, () => {
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

  it('watchSessionEvents yields events from completed session', async () => {
    const sessionId = await runQuery('Say hello');
    const filePath = getSessionFilePath(sessionId);

    const controller = new AbortController();
    const events: SessionEvent[] = [];

    // Abort after short delay (session is already complete)
    setTimeout(() => controller.abort(), 200);

    for await (const event of watchSessionEvents(filePath, {
      signal: controller.signal,
      pollIntervalMs: 50,
    })) {
      events.push(event);
    }

    // Should have captured events
    expect(events.some((e) => e.type === 'init')).toBe(true);
  });

  it('watch reads events from completed session file', async () => {
    // Run a query to completion
    const sessionId = await runQuery(
      'Read /etc/hostname and tell me what it contains',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    // Read events via batch API first to know what to expect
    const batchEvents = await readAllSessionEvents(filePath);
    expect(batchEvents.length).toBeGreaterThan(0);

    // Use watch with immediate abort after first poll
    const controller = new AbortController();
    const watchEvents: SessionEvent[] = [];

    // Set a timeout to abort after getting initial events
    setTimeout(() => controller.abort(), 100);

    for await (const event of watchSessionEvents(filePath, {
      signal: controller.signal,
      pollIntervalMs: 20,
    })) {
      watchEvents.push(event);
    }

    // Watch should have captured at least init and some other events
    expect(watchEvents.some((e) => e.type === 'init')).toBe(true);
    expect(watchEvents.length).toBeGreaterThan(0);
  });
});
