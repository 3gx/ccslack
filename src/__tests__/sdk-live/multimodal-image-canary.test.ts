/**
 * SDK Live Tests for Multi-Modal Image Input - Canary
 *
 * Documents the exact image content block structure.
 * Will fail if SDK changes the expected format.
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/multimodal-image-canary.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('Multi-Modal Image - Canary', { timeout: 60000 }, () => {
  it('CANARY: image content block structure accepted', async () => {
    const imageBlock = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png',
        data: MINIMAL_PNG_BASE64,
      },
    };

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe briefly.' },
          imageBlock,
        ],
      },
      parent_tool_use_id: null,
      session_id: '',
    };

    async function* messageStream(): AsyncIterable<SDKUserMessage> {
      yield userMessage;
    }

    const q = query({
      prompt: messageStream(),
      options: { maxTurns: 1 },
    });

    let resultMsg: any = null;
    for await (const msg of q) {
      if (msg.type === 'result') {
        resultMsg = msg;
        break;
      }
    }

    expect(resultMsg).not.toBeNull();
    expect(resultMsg.is_error).toBe(false);
  });
});
