import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Live SDK Test: interrupt() behavior
 *
 * Documents how the SDK behaves when interrupt() is called.
 *
 * KEY FINDING: interrupt() does NOT throw an error. The for-await loop
 * completes normally after interrupt() is called. This means:
 *
 * 1. The normal completion path in slack-bot.ts works correctly
 * 2. After interrupt(), the loop exits normally (no error)
 * 3. Code execution continues to the plan approval UI section
 *
 * The catch block detection in slack-bot.ts (checking for "exited with code 1")
 * is a safety net that typically won't trigger under normal circumstances.
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/interrupt-error-format.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK interrupt() behavior', { timeout: 120000 }, () => {
  it('interrupt() completes gracefully without throwing error', async () => {
    const q = query({
      prompt: 'Write a simple plan for saying hello',
      options: {
        permissionMode: 'plan',
        maxTurns: 2,
      },
    });

    let errorCaught = false;
    let interruptCalled = false;
    let loopCompletedNormally = false;

    try {
      for await (const msg of q) {
        // Interrupt after first meaningful message
        if (!interruptCalled && (msg.type === 'assistant' || (msg as any).type === 'stream_event')) {
          await q.interrupt();
          interruptCalled = true;
        }
      }
      loopCompletedNormally = true;
    } catch (error: any) {
      errorCaught = true;
      console.log('[Test] Unexpected error:', error.message);
    }

    // VERIFIED BEHAVIOR: interrupt() does NOT throw
    expect(interruptCalled).toBe(true);
    expect(loopCompletedNormally).toBe(true);
    expect(errorCaught).toBe(false);
  });

  it('normal query completion without interrupt does not throw', async () => {
    const q = query({
      prompt: 'Say exactly "hello"',
      options: {
        maxTurns: 1,
      },
    });

    let errorCaught = false;
    let gotResult = false;

    try {
      for await (const msg of q) {
        if (msg.type === 'result') {
          gotResult = true;
        }
      }
    } catch (error: any) {
      errorCaught = true;
    }

    expect(errorCaught).toBe(false);
    expect(gotResult).toBe(true);
  });
});
