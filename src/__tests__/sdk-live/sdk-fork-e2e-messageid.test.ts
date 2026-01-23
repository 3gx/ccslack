/**
 * SDK Fork E2E Test - Message ID Fails
 *
 * Documents that message.id does NOT work for resumeSessionAt.
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/sdk-fork-e2e-messageid.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Fork E2E - Message ID', { timeout: 120000 }, () => {
  it('fork using message.id FAILS (documents correct behavior)', async () => {
    const q1 = query({
      prompt: 'Say hello',
      options: { maxTurns: 1 },
    });

    let sessionId: string | null = null;
    let messageId: string | null = null;

    for await (const msg of q1) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
      }
      if (msg.type === 'assistant' && (msg as any).message?.id) {
        messageId = (msg as any).message.id;
      }
    }

    expect(sessionId).not.toBeNull();
    expect(messageId).not.toBeNull();
    expect(messageId).toMatch(/^msg_/);

    let errorOccurred = false;
    let errorMessage = '';

    try {
      const q2 = query({
        prompt: 'test',
        options: {
          maxTurns: 1,
          resume: sessionId!,
          forkSession: true,
          resumeSessionAt: messageId!,
        },
      });

      for await (const msg of q2) {
        // If we get here, it didn't fail as expected
      }
    } catch (e: any) {
      errorOccurred = true;
      errorMessage = e.message || String(e);
    }

    expect(errorOccurred).toBe(true);
    console.log(`Expected error: ${errorMessage}`);
  });
});
