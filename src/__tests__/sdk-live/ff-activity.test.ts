/**
 * SDK-Live Tests for /ff Activity Integration
 *
 * Tests that readActivityLog() produces proper tool_complete entries with duration,
 * enabling bot-like fidelity in /ff activity logs.
 *
 * Run with: npm test -- src/__tests__/sdk-live/ff-activity.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readActivityLog, ActivityEntry } from '../../session-event-stream.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';
const workingDir = process.cwd();

function getSessionFilePath(sessionId: string): string {
  const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');
  return path.join(os.homedir(), '.claude/projects', projectPath, `${sessionId}.jsonl`);
}

describe.skipIf(SKIP_LIVE)('/ff Activity Integration', { timeout: 120000 }, () => {
  const createdSessions: string[] = [];

  afterAll(() => {
    // Cleanup all test session files
    for (const sessionId of createdSessions) {
      const filePath = getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up session: ${sessionId}`);
      }
    }
  });

  // Helper to run a query and capture session ID
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

  it('readActivityLog produces tool_complete with durationMs', async () => {
    // 1. Run SDK query with Bash tool
    const sessionId = await runQuery('Run this command: echo hello', {
      permissionMode: 'bypassPermissions',
    });

    // 2. Get session file path
    const sessionFilePath = getSessionFilePath(sessionId);

    // 3. Read activity using new API
    const activityLog = await readActivityLog(sessionFilePath);

    // 4. Verify tool_complete exists with duration
    const toolCompletes = activityLog.filter((a) => a.type === 'tool_complete');
    expect(toolCompletes.length).toBeGreaterThan(0);
    expect(toolCompletes[0].tool).toBe('Bash');
    expect(toolCompletes[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tool_complete durationMs reflects actual execution time', async () => {
    // Run a command with a measurable duration
    const sessionId = await runQuery('Use Bash to run: sleep 0.3 && echo done', {
      permissionMode: 'bypassPermissions',
    });
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const bashComplete = activityLog.find(
      (a) => a.type === 'tool_complete' && a.tool === 'Bash'
    );
    expect(bashComplete).toBeDefined();
    // Sleep 0.3s = 300ms, allow tolerance for startup/cleanup
    expect(bashComplete!.durationMs).toBeGreaterThanOrEqual(200);
  });

  it('tool_start and tool_complete are both present for each tool', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname and tell me what it says',
      { permissionMode: 'bypassPermissions' }
    );
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const toolStarts = activityLog.filter((a) => a.type === 'tool_start');
    const toolCompletes = activityLog.filter((a) => a.type === 'tool_complete');

    // Both should exist
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolCompletes.length).toBeGreaterThan(0);

    // Should have equal counts
    expect(toolStarts.length).toBe(toolCompletes.length);
  });

  it('thinking entries include thinkingContent and thinkingTruncated', async () => {
    const sessionId = await runQuery('Think about what 2+2 equals', {
      maxThinkingTokens: 1000,
    });
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const thinkingEntries = activityLog.filter((a) => a.type === 'thinking');

    // May or may not have thinking depending on model decision
    if (thinkingEntries.length > 0) {
      expect(thinkingEntries[0].thinkingContent).toBeDefined();
      expect(thinkingEntries[0].thinkingTruncated).toBeDefined();
      expect(thinkingEntries[0].thinkingInProgress).toBe(false);
    }
  });

  it('generating entries include character counts', async () => {
    const sessionId = await runQuery('Say exactly: "test output"');
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    const generatingEntries = activityLog.filter((a) => a.type === 'generating');
    expect(generatingEntries.length).toBeGreaterThan(0);
    expect(generatingEntries[0].generatingChars).toBeGreaterThan(0);
  });

  it('activity log entries have proper ActivityEntry structure', async () => {
    const sessionId = await runQuery(
      'Read /etc/hostname and explain what you found',
      { permissionMode: 'bypassPermissions' }
    );
    const sessionFilePath = getSessionFilePath(sessionId);

    const activityLog = await readActivityLog(sessionFilePath);

    // All entries should have timestamp and type
    for (const entry of activityLog) {
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(['thinking', 'tool_start', 'tool_complete', 'generating']).toContain(entry.type);
    }

    // Verify tool entries have tool name
    const toolEntries = activityLog.filter(
      (a) => a.type === 'tool_start' || a.type === 'tool_complete'
    );
    for (const entry of toolEntries) {
      expect(entry.tool).toBeDefined();
    }
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

    // Should have at least 2 of each
    expect(toolStarts.length).toBeGreaterThanOrEqual(2);
    expect(toolCompletes.length).toBe(toolStarts.length);

    // All tool_complete entries should have valid durations
    for (const tc of toolCompletes) {
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Tool names should match (Read tool)
    const readCompletes = toolCompletes.filter((a) => a.tool === 'Read');
    expect(readCompletes.length).toBeGreaterThanOrEqual(2);
  });
});
