import { describe, it, expect } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Live Tests for Multi-Modal (Image) Input
 *
 * These tests verify that the AsyncIterable<SDKUserMessage> approach
 * for passing image content blocks works with the real SDK.
 *
 * This is critical for catching SDK upgrade regressions that would
 * break the file upload feature.
 *
 * Run with: npm run sdk-test
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// Minimal 1x1 red PNG image (base64 encoded)
// This is the smallest valid PNG that Claude can process
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('SDK Multi-Modal Image Input', { timeout: 60000 }, () => {
  // NOTE: Our implementation uses AsyncIterable<SDKUserMessage> ONLY when images are present.
  // For text-only messages, we use the string prompt path (existing behavior).
  // Therefore, we only test AsyncIterable with image content blocks.

  describe('Image Content Blocks', () => {
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

      // Collect messages until result
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

      // Verify we got a response
      expect(gotAssistantMessage).toBe(true);
      expect(resultMsg).not.toBeNull();
      expect(resultMsg.is_error).toBe(false);
    });

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
      // Use same base64 but with jpeg media type
      // SDK should accept without validating actual image format
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
                data: MINIMAL_PNG_BASE64,  // PNG data but jpeg type - API should handle
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
      // May error due to format mismatch, but should not crash SDK
    });
  });

  describe('Image + Fork Combination', () => {
    it('accepts image content block when forking a session', async () => {
      // First, create a session with a simple prompt
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

      // Now fork with an image - this is the combination that was failing
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
        session_id: sessionId!,  // Must use the session ID when forking
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

      // Should have created a new forked session
      expect(newSessionId).not.toBeNull();
      expect(newSessionId).not.toBe(sessionId);

      // Should complete without error
      expect(resultMsg).not.toBeNull();
      expect(resultMsg.is_error).toBe(false);
    });

    it('accepts image content block when resuming a session', async () => {
      // First, create a session
      const initialQuery = query({
        prompt: 'Remember the word "banana". Just say "remembered".',
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

      // Resume with an image
      const userMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image briefly.' },
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

      const resumeQuery = query({
        prompt: messageStream(),
        options: {
          maxTurns: 1,
          resume: sessionId!,
          // No forkSession - this is a resume
        },
      });

      let resultMsg: any = null;
      for await (const msg of resumeQuery) {
        if (msg.type === 'result') {
          resultMsg = msg;
          break;
        }
      }

      expect(resultMsg).not.toBeNull();
      expect(resultMsg.is_error).toBe(false);
    });
  });

  describe('Breaking Change Canaries', () => {
    it('CANARY: image content block structure accepted', async () => {
      // Documents the exact image content block structure
      // Will fail if SDK changes the expected format
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

      // Should complete without SDK-level errors
      expect(resultMsg).not.toBeNull();
      expect(resultMsg.is_error).toBe(false);
    });
  });
});
