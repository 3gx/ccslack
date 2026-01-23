/**
 * SDK-Live Tests for Session Event Stream API - Tool Events
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream-tools.test.ts
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

describe.skipIf(SKIP_LIVE)('Session Event Stream - Tools', { timeout: 120000 }, () => {
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

  it('yields tool_start and tool_complete for tool use', async () => {
    const sessionId = await runQuery(
      'Read the file /etc/hostname and tell me what it says',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolComplete = events.find((e) => e.type === 'tool_complete');

    expect(toolStart).toBeDefined();
    expect(toolStart?.toolName).toBe('Read');
    expect(toolComplete).toBeDefined();
    expect(toolComplete?.toolName).toBe('Read');
    expect(toolComplete?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('calculates correct tool duration', async () => {
    const sessionId = await runQuery(
      'Use the Bash tool to run: sleep 0.3 && echo done',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const toolComplete = events.find(
      (e) => e.type === 'tool_complete' && e.toolName === 'Bash'
    );
    // Sleep is 0.3s = 300ms, allow some tolerance
    expect(toolComplete?.durationMs).toBeGreaterThanOrEqual(200);
  });

  it('matches multiple tool_start/tool_complete pairs via FIFO', async () => {
    const sessionId = await runQuery(
      'First read /etc/hostname, then read /etc/os-release, tell me both',
      { permissionMode: 'bypassPermissions' }
    );
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    const toolCompletes = events.filter((e) => e.type === 'tool_complete');

    // Should have equal number of starts and completes
    expect(toolStarts.length).toBeGreaterThanOrEqual(2);
    expect(toolCompletes.length).toBe(toolStarts.length);

    // Each complete should have a duration
    for (const tc of toolCompletes) {
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
