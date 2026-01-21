/**
 * Unit tests for Session Event Stream API.
 * Uses mock JSONL data - no SDK required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readAllSessionEvents,
  watchSessionEvents,
  SessionEvent,
  sessionEventToActivityEntry,
  sessionEventsToActivityLog,
  readActivityLog,
  ActivityEntry,
} from '../../session-event-stream.js';

describe('Session Event Stream - Unit Tests', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `test-session-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  // Helper to write mock JSONL
  function writeMockSession(messages: object[]) {
    fs.writeFileSync(
      tempFile,
      messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    );
  }

  it('yields init event with sessionId from first message', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-123',
        message: { role: 'user', content: 'hello' },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    expect(events[0]).toEqual({
      type: 'init',
      timestamp: expect.any(Number),
      sessionId: 'sess-123',
    });
  });

  it('yields thinking_complete with content from thinking block', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'think about this' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think step by step...' }],
        },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const thinkingStart = events.find((e) => e.type === 'thinking_start');
    const thinkingComplete = events.find((e) => e.type === 'thinking_complete');

    expect(thinkingStart).toBeDefined();
    expect(thinkingComplete).toBeDefined();
    expect(thinkingComplete?.thinkingContent).toBe('Let me think step by step...');
  });

  it('yields tool_start from tool_use block', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'read file' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/test.txt' } },
          ],
        },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const toolStart = events.find((e) => e.type === 'tool_start');

    expect(toolStart).toBeDefined();
    expect(toolStart?.toolName).toBe('Read');
    expect(toolStart?.toolId).toBe('tool_1');
  });

  it('yields tool_complete when tool_result encountered', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'read file' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2024-01-01T00:00:02Z',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'file contents' }],
        },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const toolComplete = events.find((e) => e.type === 'tool_complete');

    expect(toolComplete).toBeDefined();
    expect(toolComplete?.toolName).toBe('Read');
    expect(toolComplete?.durationMs).toBe(1000); // 1 second between timestamps
  });

  it('matches multiple tools in FIFO order', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'do stuff' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2024-01-01T00:00:03Z',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'read result' },
            { type: 'tool_result', content: 'grep result' },
          ],
        },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const completes = events.filter((e) => e.type === 'tool_complete');

    expect(completes.length).toBe(2);
    expect(completes[0].toolName).toBe('Read'); // First tool_use → first tool_result
    expect(completes[1].toolName).toBe('Grep'); // Second tool_use → second tool_result
  });

  it('yields text event with content and charCount', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'say hello' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there!' }],
        },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const textEvent = events.find((e) => e.type === 'text');

    expect(textEvent).toBeDefined();
    expect(textEvent?.textContent).toBe('Hello there!');
    expect(textEvent?.charCount).toBe(12);
  });

  it('yields only init for file with just user message', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('init');
  });

  it('skips malformed JSON lines gracefully', async () => {
    fs.writeFileSync(
      tempFile,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'hello' },
        }),
        'this is not valid json',
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:01Z',
          sessionId: 's1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n') + '\n'
    );

    const events = await readAllSessionEvents(tempFile);

    // Should still get init and text events
    expect(events.some((e) => e.type === 'init')).toBe(true);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('yields turn_end when next user input detected', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'first question' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:05Z',
        sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2024-01-01T00:00:10Z',
        sessionId: 's1',
        message: { role: 'user', content: 'second question' },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const turnEnd = events.find((e) => e.type === 'turn_end');

    expect(turnEnd).toBeDefined();
    expect(turnEnd?.turnDurationMs).toBe(5000); // 5 seconds from user input to last assistant
  });

  it('yields final turn_end at end of file', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'question' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:03Z',
        sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);
    const lastEvent = events[events.length - 1];

    expect(lastEvent.type).toBe('turn_end');
    expect(lastEvent.turnDurationMs).toBe(3000);
  });

  it('returns empty array for non-existent file', async () => {
    const events = await readAllSessionEvents('/nonexistent/file.jsonl');
    expect(events).toEqual([]);
  });

  it('events are yielded in chronological order', async () => {
    writeMockSession([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'question' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2024-01-01T00:00:02Z',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'result' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2024-01-01T00:00:03Z',
        sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ]);

    const events = await readAllSessionEvents(tempFile);

    // Timestamps should be non-decreasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }

    // init should always be first
    expect(events[0].type).toBe('init');
  });

  describe('watchSessionEvents', () => {
    it('yields events as file grows', async () => {
      // Start with initial content
      writeMockSession([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'hello' },
        },
      ]);

      const controller = new AbortController();
      const events: SessionEvent[] = [];

      // Start watching
      const watchPromise = (async () => {
        for await (const event of watchSessionEvents(tempFile, {
          signal: controller.signal,
          pollIntervalMs: 20,
        })) {
          events.push(event);
          // Stop after we see text event
          if (event.type === 'text') {
            controller.abort();
            break;
          }
        }
      })();

      // Give watcher time to start and read initial content
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Append new content
      fs.appendFileSync(
        tempFile,
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:01Z',
          sessionId: 's1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }) + '\n'
      );

      // Wait for watcher with a reasonable timeout
      await Promise.race([
        watchPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.abort();
            resolve();
          }, 1000);
        }),
      ]);

      expect(events.some((e) => e.type === 'init')).toBe(true);
      expect(events.some((e) => e.type === 'text')).toBe(true);
    }, 5000);

    it('stops cleanly when signal is aborted', async () => {
      writeMockSession([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:01Z',
          sessionId: 's1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
      ]);

      const controller = new AbortController();
      const events: SessionEvent[] = [];

      // Abort after short delay
      setTimeout(() => controller.abort(), 100);

      // Should not throw, should exit cleanly
      for await (const event of watchSessionEvents(tempFile, {
        signal: controller.signal,
        pollIntervalMs: 50,
      })) {
        events.push(event);
      }

      // Should have captured events before abort
      expect(events.some((e) => e.type === 'init')).toBe(true);
    });

    it('starts from specified offset', async () => {
      // Write initial content
      const msg1 = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      });
      const msg2 = JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      });

      fs.writeFileSync(tempFile, msg1 + '\n' + msg2 + '\n');

      // Get offset after first two messages
      const initialSize = fs.statSync(tempFile).size;

      // Append new message
      fs.appendFileSync(
        tempFile,
        JSON.stringify({
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2024-01-01T00:00:02Z',
          sessionId: 's1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        }) + '\n'
      );

      const controller = new AbortController();
      const events: SessionEvent[] = [];

      // Start watching from offset (skipping first two messages)
      setTimeout(() => controller.abort(), 100);

      for await (const event of watchSessionEvents(tempFile, {
        signal: controller.signal,
        pollIntervalMs: 50,
        fromOffset: initialSize,
      })) {
        events.push(event);
      }

      // Should only see the second text event, not init or first text
      expect(events.some((e) => e.type === 'init')).toBe(false);
      expect(events.some((e) => e.type === 'text' && e.textContent === 'second')).toBe(
        true
      );
      expect(events.some((e) => e.type === 'text' && e.textContent === 'first')).toBe(
        false
      );
    });
  });

  describe('complex scenarios', () => {
    it('handles interleaved tool calls and text', async () => {
      writeMockSession([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'do multiple things' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:01Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me read that file.' },
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2024-01-01T00:00:02Z',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'file content' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2024-01-01T00:00:03Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Now let me search.' },
              { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u3',
          timestamp: '2024-01-01T00:00:04Z',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'search results' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2024-01-01T00:00:05Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is what I found.' }],
          },
        },
      ]);

      const events = await readAllSessionEvents(tempFile);

      // Count event types
      const toolStarts = events.filter((e) => e.type === 'tool_start');
      const toolCompletes = events.filter((e) => e.type === 'tool_complete');
      const textEvents = events.filter((e) => e.type === 'text');

      expect(toolStarts.length).toBe(2);
      expect(toolCompletes.length).toBe(2);
      expect(textEvents.length).toBe(3);

      // Verify FIFO matching
      expect(toolCompletes[0].toolName).toBe('Read');
      expect(toolCompletes[1].toolName).toBe('Grep');
    });

    it('handles multiple turns with thinking', async () => {
      writeMockSession([
        // Turn 1
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'first question' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:02Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Thinking about first...' },
              { type: 'text', text: 'First answer.' },
            ],
          },
        },
        // Turn 2
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2024-01-01T00:00:05Z',
          sessionId: 's1',
          message: { role: 'user', content: 'second question' },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2024-01-01T00:00:08Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Thinking about second...' },
              { type: 'text', text: 'Second answer.' },
            ],
          },
        },
      ]);

      const events = await readAllSessionEvents(tempFile);

      const thinkingCompletes = events.filter((e) => e.type === 'thinking_complete');
      const turnEnds = events.filter((e) => e.type === 'turn_end');

      expect(thinkingCompletes.length).toBe(2);
      expect(thinkingCompletes[0].thinkingContent).toBe('Thinking about first...');
      expect(thinkingCompletes[1].thinkingContent).toBe('Thinking about second...');

      // Should have turn_end for first turn (when second user input detected) and final
      expect(turnEnds.length).toBe(2);
    });
  });

  // ============================================================================
  // ActivityEntry Conversion Tests
  // ============================================================================

  describe('sessionEventToActivityEntry', () => {
    it('converts thinking_complete to thinking ActivityEntry', () => {
      const event: SessionEvent = {
        type: 'thinking_complete',
        timestamp: 1704067200000,
        thinkingContent: 'Let me think about this problem step by step...',
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('thinking');
      expect(entry!.timestamp).toBe(1704067200000);
      expect(entry!.thinkingContent).toBe('Let me think about this problem step by step...');
      expect(entry!.thinkingTruncated).toBe('Let me think about this problem step by step...');
      expect(entry!.thinkingInProgress).toBe(false);
    });

    it('truncates long thinking content to 500 chars', () => {
      const longContent = 'x'.repeat(600);
      const event: SessionEvent = {
        type: 'thinking_complete',
        timestamp: 1704067200000,
        thinkingContent: longContent,
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry!.thinkingContent).toBe(longContent); // Full content preserved
      expect(entry!.thinkingTruncated).toBe('x'.repeat(500) + '...'); // Truncated for display
    });

    it('converts tool_start to tool_start ActivityEntry', () => {
      const event: SessionEvent = {
        type: 'tool_start',
        timestamp: 1704067200000,
        toolName: 'Read',
        toolId: 'tool_123',
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('tool_start');
      expect(entry!.tool).toBe('Read');
      expect(entry!.timestamp).toBe(1704067200000);
    });

    it('converts tool_complete to tool_complete ActivityEntry with duration', () => {
      const event: SessionEvent = {
        type: 'tool_complete',
        timestamp: 1704067201000,
        toolName: 'Read',
        toolId: 'tool_123',
        durationMs: 150,
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('tool_complete');
      expect(entry!.tool).toBe('Read');
      expect(entry!.durationMs).toBe(150);
    });

    it('converts text to generating ActivityEntry', () => {
      const event: SessionEvent = {
        type: 'text',
        timestamp: 1704067200000,
        textContent: 'Hello, world!',
        charCount: 13,
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('generating');
      expect(entry!.generatingChars).toBe(13);
      expect(entry!.generatingChunks).toBe(1);
      expect(entry!.generatingInProgress).toBe(false);
    });

    it('includes response content in generating ActivityEntry', () => {
      const event: SessionEvent = {
        type: 'text',
        timestamp: 1704067200000,
        textContent: 'This is the full response from Claude.',
        charCount: 38,
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('generating');
      expect(entry!.generatingContent).toBe('This is the full response from Claude.');
      expect(entry!.generatingTruncated).toBe('This is the full response from Claude.');
    });

    it('truncates long response content to 500 chars', () => {
      const longContent = 'X'.repeat(600);
      const event: SessionEvent = {
        type: 'text',
        timestamp: 1704067200000,
        textContent: longContent,
        charCount: 600,
      };

      const entry = sessionEventToActivityEntry(event);

      expect(entry).not.toBeNull();
      expect(entry!.generatingContent).toBe(longContent); // Full content preserved
      expect(entry!.generatingTruncated).toBe('X'.repeat(500) + '...'); // Truncated for display
    });

    it('returns null for init event', () => {
      const event: SessionEvent = {
        type: 'init',
        timestamp: 1704067200000,
        sessionId: 'sess_123',
      };

      const entry = sessionEventToActivityEntry(event);
      expect(entry).toBeNull();
    });

    it('returns null for thinking_start event', () => {
      const event: SessionEvent = {
        type: 'thinking_start',
        timestamp: 1704067200000,
      };

      const entry = sessionEventToActivityEntry(event);
      expect(entry).toBeNull();
    });

    it('returns null for turn_end event', () => {
      const event: SessionEvent = {
        type: 'turn_end',
        timestamp: 1704067200000,
        turnDurationMs: 5000,
      };

      const entry = sessionEventToActivityEntry(event);
      expect(entry).toBeNull();
    });

    it('returns null for text event with zero chars', () => {
      const event: SessionEvent = {
        type: 'text',
        timestamp: 1704067200000,
        textContent: '',
        charCount: 0,
      };

      const entry = sessionEventToActivityEntry(event);
      expect(entry).toBeNull();
    });
  });

  describe('sessionEventsToActivityLog', () => {
    it('converts array of events to activity log, filtering non-activity events', () => {
      const events: SessionEvent[] = [
        { type: 'init', timestamp: 1000, sessionId: 's1' },
        { type: 'thinking_start', timestamp: 2000 },
        { type: 'thinking_complete', timestamp: 3000, thinkingContent: 'thought' },
        { type: 'tool_start', timestamp: 4000, toolName: 'Read' },
        { type: 'tool_complete', timestamp: 5000, toolName: 'Read', durationMs: 100 },
        { type: 'text', timestamp: 6000, textContent: 'response', charCount: 8 },
        { type: 'turn_end', timestamp: 7000, turnDurationMs: 6000 },
      ];

      const activityLog = sessionEventsToActivityLog(events);

      // Should have 4 entries: thinking, tool_start, tool_complete, generating
      expect(activityLog.length).toBe(4);
      expect(activityLog[0].type).toBe('thinking');
      expect(activityLog[1].type).toBe('tool_start');
      expect(activityLog[2].type).toBe('tool_complete');
      expect(activityLog[3].type).toBe('generating');
    });

    it('returns empty array for events with no activity', () => {
      const events: SessionEvent[] = [
        { type: 'init', timestamp: 1000, sessionId: 's1' },
        { type: 'turn_end', timestamp: 2000, turnDurationMs: 1000 },
      ];

      const activityLog = sessionEventsToActivityLog(events);
      expect(activityLog.length).toBe(0);
    });
  });

  describe('readActivityLog', () => {
    it('reads session file and returns activity log', async () => {
      writeMockSession([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          sessionId: 's1',
          message: { role: 'user', content: 'read file' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2024-01-01T00:00:01Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me read...' },
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2024-01-01T00:00:02Z',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'file content' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2024-01-01T00:00:03Z',
          sessionId: 's1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The file contains...' }],
          },
        },
      ]);

      const activityLog = await readActivityLog(tempFile);

      // Should have: thinking, tool_start, tool_complete, generating
      expect(activityLog.length).toBe(4);

      const types = activityLog.map((e) => e.type);
      expect(types).toContain('thinking');
      expect(types).toContain('tool_start');
      expect(types).toContain('tool_complete');
      expect(types).toContain('generating');

      // Verify tool info
      const toolStart = activityLog.find((e) => e.type === 'tool_start');
      expect(toolStart?.tool).toBe('Read');

      const toolComplete = activityLog.find((e) => e.type === 'tool_complete');
      expect(toolComplete?.tool).toBe('Read');
      expect(toolComplete?.durationMs).toBe(1000); // 1 second between tool_use and tool_result
    });

    it('returns empty array for non-existent file', async () => {
      const activityLog = await readActivityLog('/nonexistent/file.jsonl');
      expect(activityLog).toEqual([]);
    });
  });
});
