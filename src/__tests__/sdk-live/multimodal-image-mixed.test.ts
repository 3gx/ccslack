/**
 * SDK Live Tests for Multi-Modal Image Input - Mixed Content
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/multimodal-image-mixed.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('Multi-Modal Image - Mixed', { timeout: 60000 }, () => {
  it('accepts mixed text and image content blocks', async () => {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'I have uploaded an image.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: MINIMAL_PNG_BASE64,
            },
          },
          { type: 'text', text: 'Just say "received" to confirm.' },
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

  it('accepts image/jpeg media type', async () => {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Say "ok"' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
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

    let resultMsg: any = null;
    for await (const msg of q) {
      if (msg.type === 'result') {
        resultMsg = msg;
        break;
      }
    }

    expect(resultMsg).not.toBeNull();
  });
});
