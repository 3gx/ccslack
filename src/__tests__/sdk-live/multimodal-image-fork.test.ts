/**
 * SDK Live Tests for Multi-Modal Image Input - Fork
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/multimodal-image-fork.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('Multi-Modal Image - Fork', { timeout: 60000 }, () => {
  it('accepts image content block when forking a session', async () => {
    const initialQuery = query({
      prompt: 'Say "session started" and nothing else.',
      options: { maxTurns: 1 },
    });

    let sessionId: string | null = null;
    for await (const msg of initialQuery) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
      }
      if (msg.type === 'result') {
        break;
      }
    }

    expect(sessionId).not.toBeNull();

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this pixel? Just say the color.' },
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
      session_id: sessionId!,
    };

    async function* messageStream(): AsyncIterable<SDKUserMessage> {
      yield userMessage;
    }

    const forkQuery = query({
      prompt: messageStream(),
      options: {
        maxTurns: 1,
        resume: sessionId!,
        forkSession: true,
      },
    });

    let resultMsg: any = null;
    let newSessionId: string | null = null;

    for await (const msg of forkQuery) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
      }
      if (msg.type === 'result') {
        resultMsg = msg;
        break;
      }
    }

    expect(newSessionId).not.toBeNull();
    expect(newSessionId).not.toBe(sessionId);
    expect(resultMsg).not.toBeNull();
    expect(resultMsg.is_error).toBe(false);
  });
});
