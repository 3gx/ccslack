/**
 * SDK-Live Tests for Session Event Stream API - Thinking Events
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-thinking.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Thinking', { timeout: 120000 }, () => {
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

  it('captures thinking events when model uses extended thinking', async () => {
    const sessionId = await runQuery('Think step by step about what 2+2 equals', {
      maxThinkingTokens: 1000,
    });
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    // May or may not have thinking depending on model decision
    const thinkingEvents = events.filter(
      (e) => e.type === 'thinking_start' || e.type === 'thinking_complete'
    );

    // Log what we found for debugging
    console.log(`Thinking events found: ${thinkingEvents.length}`);

    // If thinking occurred, should have complete event with content
    if (thinkingEvents.length > 0) {
      const complete = events.find((e) => e.type === 'thinking_complete');
      expect(complete?.thinkingContent).toBeDefined();
      expect(complete!.thinkingContent!.length).toBeGreaterThan(0);
    }
  });

  it('thinking_start count equals thinking_complete count', async () => {
    const sessionId = await runQuery('Think about the meaning of life', {
      maxThinkingTokens: 500,
    });
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const thinkingStarts = events.filter((e) => e.type === 'thinking_start');
    const thinkingCompletes = events.filter((e) => e.type === 'thinking_complete');

    expect(thinkingStarts.length).toBe(thinkingCompletes.length);
  });
});
