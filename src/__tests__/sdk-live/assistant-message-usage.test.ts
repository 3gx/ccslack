/**
 * SDK-Live Test: Assistant Message Usage Availability
 *
 * Verifies when .message.usage (token counts) is available on assistant messages
 * during streaming with includePartialMessages: true.
 *
 * Key findings this test validates:
 * - Assistant messages have .message.usage available during streaming
 * - The result message always has .usage with input/output tokens
 * - Extended thinking produces thinking stream events
 *
 * This behavior is important for live UI updates - usage data is available
 * on assistant messages during streaming for real-time token tracking.
 *
 * Run with: npx vitest run src/__tests__/sdk-live/assistant-message-usage.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Assistant Message Usage Availability', { timeout: 120000 }, () => {
  it('assistant messages have .message.usage during streaming', async () => {
    const assistantMessages: Array<{
      index: number;
      hasUsage: boolean;
    }> = [];

    let messageIndex = 0;

    const q = query({
      prompt: 'Think step by step about what 2+2 equals, then give me the answer.',
      options: {
        maxTurns: 1,
        maxThinkingTokens: 2000,
        includePartialMessages: true,
      },
    });

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const assistantMsg = msg as any;
        assistantMessages.push({
          index: messageIndex,
          hasUsage: !!assistantMsg.message?.usage,
        });
      }
      messageIndex++;
      if (msg.type === 'result') break;
    }

    // Should have at least one assistant message
    expect(assistantMessages.length).toBeGreaterThan(0);

    // All assistant messages should have usage available
    for (const am of assistantMessages) {
      expect(am.hasUsage).toBe(true);
    }
  });

  it('result message always has .usage with token counts', async () => {
    let resultUsage: any = null;

    const q = query({
      prompt: 'Say hello.',
      options: {
        maxTurns: 1,
        includePartialMessages: true,
      },
    });

    for await (const msg of q) {
      if (msg.type === 'result') {
        resultUsage = (msg as any).usage;
        break;
      }
    }

    expect(resultUsage).not.toBeNull();
    expect(resultUsage).toHaveProperty('input_tokens');
    expect(resultUsage).toHaveProperty('output_tokens');
  });

  it('extended thinking produces thinking stream events', async () => {
    let hasThinkingBlockStart = false;
    let hasThinkingDelta = false;

    const q = query({
      prompt: 'Think step by step about what 2+2 equals, then give me the answer.',
      options: {
        maxTurns: 1,
        maxThinkingTokens: 2000,
        includePartialMessages: true,
      },
    });

    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const event = (msg as any).event;
        // content_block_start with type=thinking
        if (event?.type === 'content_block_start' &&
            event?.content_block?.type === 'thinking') {
          hasThinkingBlockStart = true;
        }
        // content_block_delta with delta.type=thinking_delta
        if (event?.type === 'content_block_delta' &&
            event?.delta?.type === 'thinking_delta') {
          hasThinkingDelta = true;
        }
      }
      if (msg.type === 'result') break;
    }

    // Should have both thinking block start and deltas
    expect(hasThinkingBlockStart).toBe(true);
    expect(hasThinkingDelta).toBe(true);
  });
});
