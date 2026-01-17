import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for SDK message handling robustness.
 * Verifies that various message shapes from SDK don't crash the bot.
 * These tests mock the SDK to yield different message structures
 * and verify the code handles them gracefully.
 */

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { startClaudeQuery } from '../../claude-client.js';

describe('SDK Message Handling Robustness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockQueryWithMessages = (messages: any[]) => {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const msg of messages) {
          yield msg;
        }
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    };
  };

  describe('Unknown Message Types', () => {
    it('handles unknown message type without crashing', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          { type: 'unknown_future_type', data: { foo: 'bar' } },
          { type: 'result', result: 'done' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      // Should not throw
      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('unknown_future_type');
    });

    it('handles message with missing required fields', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          { type: 'assistant' }, // No text or content
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('assistant');
    });

    it('handles null content gracefully', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          { type: 'assistant', content: null },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBeNull();
    });
  });

  describe('Content Structure Variations', () => {
    it('handles content_block without text', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          { type: 'assistant', content: [{ type: 'image', source: {} }] },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
    });

    it('handles empty content array', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          { type: 'assistant', content: [] },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toEqual([]);
    });

    it('handles nested unknown structures', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'assistant',
            content: [
              {
                type: 'unknown_block',
                nested: {
                  deep: {
                    value: 'test',
                    array: [1, 2, { more: 'nesting' }],
                  },
                },
              },
            ],
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
    });
  });

  describe('Stream Events (Critical for SDK upgrade)', () => {
    it('handles stream_event with content_block_start thinking', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking' },
            },
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('stream_event');
      expect(messages[0].event.content_block.type).toBe('thinking');
    });

    it('handles stream_event with thinking_delta', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'I am thinking...' },
            },
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].event.delta.type).toBe('thinking_delta');
      expect(messages[0].event.delta.thinking).toBe('I am thinking...');
    });

    it('handles stream_event with tool_use content_block', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'tool_123', name: 'Read' },
            },
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].event.content_block.type).toBe('tool_use');
      expect(messages[0].event.content_block.name).toBe('Read');
    });

    it('handles stream_event with content_block_stop', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].event.type).toBe('content_block_stop');
      expect(messages[0].event.index).toBe(0);
    });

    it('handles stream_event with text_delta', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello world' },
            },
          },
          { type: 'result' },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].event.delta.type).toBe('text_delta');
      expect(messages[0].event.delta.text).toBe('Hello world');
    });
  });

  describe('Result Message Fields', () => {
    it('handles result without expected fields', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([{ type: 'result' }]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('result');
    });

    it('handles result with total_cost_usd field', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'result',
            duration_ms: 1234,
            usage: { input_tokens: 100, output_tokens: 50 },
            is_error: false,
            total_cost_usd: 0.0025,
          },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].total_cost_usd).toBe(0.0025);
    });

    it('handles result with modelUsage.contextWindow', async () => {
      vi.mocked(query).mockReturnValue(
        createMockQueryWithMessages([
          {
            type: 'result',
            duration_ms: 1234,
            usage: { input_tokens: 100, output_tokens: 50 },
            is_error: false,
            modelUsage: {
              'claude-sonnet-4': {
                inputTokens: 100,
                outputTokens: 50,
                contextWindow: 200000,
              },
            },
          },
        ]) as any
      );

      const q = startClaudeQuery('test', {});
      const messages: any[] = [];

      for await (const msg of q) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      const modelKey = Object.keys(messages[0].modelUsage)[0];
      expect(messages[0].modelUsage[modelKey].contextWindow).toBe(200000);
    });
  });
});
