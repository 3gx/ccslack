/**
 * SDK-Live Tests for Session Event Stream API
 *
 * These tests run actual Claude sessions to verify the event stream
 * captures real activity correctly. Requires ANTHROPIC_API_KEY.
 *
 * Run with: npm test -- src/__tests__/sdk-live/session-event-stream.test.ts
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
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

describe.skipIf(SKIP_LIVE)('Session Event Stream API', { timeout: 120000 }, () => {
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

  it('yields init event with sessionId', async () => {
    const sessionId = await runQuery('Say "hello"');
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    expect(events[0].type).toBe('init');
    expect(events[0].sessionId).toBe(sessionId);
  });

  it('yields text event with content', async () => {
    const sessionId = await runQuery('Say exactly: "test output"');
    const filePath = getSessionFilePath(sessionId);

    const events = await readAllSessionEvents(filePath);

    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.charCount).toBeGreaterThan(0);
    expect(textEvent?.textContent).toBeDefined();
  });

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

  describe('watchSessionEvents', () => {
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

  describe('event counts match session content', () => {
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

  /**
   * CRITICAL: SDK stream_event parity tests
   * These tests verify that the simulated API (reading JSONL files) produces
   * the same events as the real SDK stream_event messages.
   */
  describe('SDK stream_event parity', () => {
    /**
     * Captures SDK stream_event messages during a query.
     * Returns counts of each event type for comparison.
     */
    interface SdkEventCounts {
      thinkingBlocks: number;
      toolUseBlocks: number;
      textBlocks: number;
      toolNames: string[];
    }

    async function runQueryWithEventCapture(
      prompt: string,
      options: { permissionMode?: string; maxThinkingTokens?: number } = {}
    ): Promise<{ sessionId: string; sdkCounts: SdkEventCounts }> {
      const sdkCounts: SdkEventCounts = {
        thinkingBlocks: 0,
        toolUseBlocks: 0,
        textBlocks: 0,
        toolNames: [],
      };

      const q = query({
        prompt,
        options: {
          maxTurns: 1,
          permissionMode: options.permissionMode as any,
          maxThinkingTokens: options.maxThinkingTokens,
          includePartialMessages: true, // Enable stream_event messages
        },
      });

      let sessionId: string | null = null;

      for await (const msg of q) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          sessionId = (msg as any).session_id;
          createdSessions.push(sessionId);
        }

        // Capture stream_event messages (real-time SDK events)
        if ((msg as any).type === 'stream_event') {
          const event = (msg as any).event;

          // Thinking block started
          if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
            sdkCounts.thinkingBlocks++;
          }

          // Tool use started
          if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            sdkCounts.toolUseBlocks++;
            if (event.content_block.name) {
              sdkCounts.toolNames.push(event.content_block.name);
            }
          }

          // Text block started
          if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
            sdkCounts.textBlocks++;
          }
        }

        if (msg.type === 'result') break;
      }

      if (!sessionId) {
        throw new Error('Failed to get session ID from query');
      }

      return { sessionId, sdkCounts };
    }

    it('PARITY: tool_use counts match between SDK stream_event and JSONL reader', async () => {
      const { sessionId, sdkCounts } = await runQueryWithEventCapture(
        'Read /etc/hostname, then read /etc/os-release, explain both',
        { permissionMode: 'bypassPermissions' }
      );
      const filePath = getSessionFilePath(sessionId);

      // Read events from JSONL file using our API
      const jsonlEvents = await readAllSessionEvents(filePath);
      const jsonlToolStarts = jsonlEvents.filter((e) => e.type === 'tool_start');

      console.log(`SDK stream_event tool_use count: ${sdkCounts.toolUseBlocks}`);
      console.log(`JSONL reader tool_start count: ${jsonlToolStarts.length}`);
      console.log(`SDK tool names: ${sdkCounts.toolNames.join(', ')}`);
      console.log(`JSONL tool names: ${jsonlToolStarts.map((e) => e.toolName).join(', ')}`);

      // CRITICAL: Tool counts must match exactly
      expect(jsonlToolStarts.length).toBe(sdkCounts.toolUseBlocks);

      // Tool names should match (order may differ due to parallel execution)
      const sdkToolSet = new Set(sdkCounts.toolNames);
      const jsonlToolSet = new Set(jsonlToolStarts.map((e) => e.toolName));
      expect(jsonlToolSet).toEqual(sdkToolSet);
    });

    it('PARITY: thinking counts match between SDK stream_event and JSONL reader', async () => {
      const { sessionId, sdkCounts } = await runQueryWithEventCapture(
        'Think carefully about what 7 * 8 equals',
        { maxThinkingTokens: 2000 }
      );
      const filePath = getSessionFilePath(sessionId);

      const jsonlEvents = await readAllSessionEvents(filePath);
      const jsonlThinkingStarts = jsonlEvents.filter((e) => e.type === 'thinking_start');

      console.log(`SDK stream_event thinking count: ${sdkCounts.thinkingBlocks}`);
      console.log(`JSONL reader thinking_start count: ${jsonlThinkingStarts.length}`);

      // Thinking counts must match
      expect(jsonlThinkingStarts.length).toBe(sdkCounts.thinkingBlocks);
    });

    it('PARITY: text block counts match between SDK stream_event and JSONL reader', async () => {
      const { sessionId, sdkCounts } = await runQueryWithEventCapture(
        'Say exactly: "Hello World"'
      );
      const filePath = getSessionFilePath(sessionId);

      const jsonlEvents = await readAllSessionEvents(filePath);
      const jsonlTextEvents = jsonlEvents.filter((e) => e.type === 'text');

      console.log(`SDK stream_event text count: ${sdkCounts.textBlocks}`);
      console.log(`JSONL reader text count: ${jsonlTextEvents.length}`);

      // Text counts must match
      expect(jsonlTextEvents.length).toBe(sdkCounts.textBlocks);
    });

    it('PARITY: mixed session (tools + text + thinking) - JSONL captures all SDK events', async () => {
      const { sessionId, sdkCounts } = await runQueryWithEventCapture(
        'Think about what file to read, then read /etc/hostname, explain what you found',
        { permissionMode: 'bypassPermissions', maxThinkingTokens: 1000 }
      );
      const filePath = getSessionFilePath(sessionId);

      const jsonlEvents = await readAllSessionEvents(filePath);

      const jsonlToolStarts = jsonlEvents.filter((e) => e.type === 'tool_start');
      const jsonlThinkingStarts = jsonlEvents.filter((e) => e.type === 'thinking_start');
      const jsonlTextEvents = jsonlEvents.filter((e) => e.type === 'text');

      console.log('=== SDK stream_event counts ===');
      console.log(`  tools: ${sdkCounts.toolUseBlocks}`);
      console.log(`  thinking: ${sdkCounts.thinkingBlocks}`);
      console.log(`  text: ${sdkCounts.textBlocks}`);

      console.log('=== JSONL reader counts ===');
      console.log(`  tools: ${jsonlToolStarts.length}`);
      console.log(`  thinking: ${jsonlThinkingStarts.length}`);
      console.log(`  text: ${jsonlTextEvents.length}`);

      // JSONL is the source of truth - it should capture at least what SDK reported
      // Note: SDK stream_event may not emit content_block_start for all blocks
      // (e.g., text blocks may be coalesced or omitted in stream_event)
      expect(jsonlToolStarts.length).toBeGreaterThanOrEqual(sdkCounts.toolUseBlocks);
      expect(jsonlThinkingStarts.length).toBeGreaterThanOrEqual(sdkCounts.thinkingBlocks);
      expect(jsonlTextEvents.length).toBeGreaterThanOrEqual(sdkCounts.textBlocks);

      // Key invariant: tool_start and tool_complete must be balanced
      const jsonlToolCompletes = jsonlEvents.filter((e) => e.type === 'tool_complete');
      expect(jsonlToolStarts.length).toBe(jsonlToolCompletes.length);
    });

    it('PARITY: tool_complete has valid duration after tool_result', async () => {
      const { sessionId, sdkCounts } = await runQueryWithEventCapture(
        'Use Bash to run: sleep 0.2 && echo done',
        { permissionMode: 'bypassPermissions' }
      );
      const filePath = getSessionFilePath(sessionId);

      const jsonlEvents = await readAllSessionEvents(filePath);
      const toolCompletes = jsonlEvents.filter((e) => e.type === 'tool_complete');

      // Should have same number of completes as SDK reported tool_use starts
      expect(toolCompletes.length).toBe(sdkCounts.toolUseBlocks);

      // Each tool_complete should have a valid duration
      for (const tc of toolCompletes) {
        expect(tc.durationMs).toBeDefined();
        expect(tc.durationMs).toBeGreaterThanOrEqual(0);
      }

      // The Bash tool with sleep should have duration >= 150ms (with some tolerance)
      const bashComplete = toolCompletes.find((e) => e.toolName === 'Bash');
      if (bashComplete) {
        expect(bashComplete.durationMs).toBeGreaterThanOrEqual(150);
      }
    });
  });
});
