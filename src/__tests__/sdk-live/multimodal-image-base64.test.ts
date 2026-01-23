/**
 * SDK Live Tests for Multi-Modal Image Input - Base64
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/multimodal-image-base64.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('Multi-Modal Image - Base64', { timeout: 60000 }, () => {
  it('accepts image content block with base64 source', async () => {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this image? Reply with just the color name.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: MINIMAL_PNG_BASE64,
            },
          },
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

    let gotAssistantMessage = false;
    let resultMsg: any = null;

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        gotAssistantMessage = true;
      }
      if (msg.type === 'result') {
        resultMsg = msg;
        break;
      }
    }

    expect(gotAssistantMessage).toBe(true);
    expect(resultMsg).not.toBeNull();
    expect(resultMsg.is_error).toBe(false);
  });
});
