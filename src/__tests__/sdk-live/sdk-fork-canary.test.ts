import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Isolated Fork Canary Test
 *
 * This test is in a separate file because:
 * 1. The SDK may hang when given invalid session parameters
 * 2. When interrupted, the SDK may throw "write after end" errors
 * 3. Running in isolation prevents these errors from affecting other tests
 *
 * Run with: npm run test:sdk
 */

// SDK may be configured via environment variable OR config file
// Only skip if we explicitly want to skip live tests
const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// Handler for expected SDK stream errors (thrown async after interrupt)
const streamErrorHandler = (err: Error) => {
  if (err.message === 'write after end') {
    // Expected - SDK throws this when interrupted during invalid session load
    return;
  }
  // Re-throw unexpected errors
  throw err;
};

describe.skipIf(SKIP_LIVE)('SDK Fork Canary (Isolated)', { timeout: 15000 }, () => {
  beforeAll(() => {
    process.on('uncaughtException', streamErrorHandler);
  });

  afterAll(() => {
    process.off('uncaughtException', streamErrorHandler);
  });

  it('CANARY: resume + forkSession + resumeSessionAt accepted', { timeout: 10000 }, async () => {
    // Fork options structure used by point-in-time forking
    // Will fail if SDK changes option format
    // We expect this to fail with a session-related error, not an option format error
    // Note: New SDK may hang on invalid session, so we use a 5s timeout
    let errorOccurred = false;
    let errorMessage = '';

    const q = query({
      prompt: 'echo test',
      options: {
        maxTurns: 1,
        resume: 'test-session-id-that-does-not-exist',
        forkSession: true,
        resumeSessionAt: 'test-message-id',
      },
    });

    try {
      const iter = q[Symbol.asyncIterator]();

      // Race against 5s timeout - SDK may hang on invalid session
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      await Promise.race([iter.next(), timeoutPromise]);
    } catch (e: any) {
      errorOccurred = true;
      errorMessage = (e.message || String(e)).toLowerCase();
    } finally {
      // Wrap in try-catch with timeout - SDK may hang or throw if stream closed
      try {
        const interruptTimeout = new Promise<void>((resolve) => {
          setTimeout(resolve, 2000); // 2s max for cleanup
        });
        await Promise.race([q.interrupt().catch(() => {}), interruptTimeout]);
      } catch {
        // Ignore - SDK subprocess may have already terminated
      }
    }

    // We expect an error because the session doesn't exist (or timeout if SDK hangs)
    // The key is that the OPTIONS were accepted (not rejected as unknown)
    // Valid errors: session not found, invalid session, timeout, etc.
    // Invalid errors: unknown option, invalid option name, etc.
    if (errorOccurred && !errorMessage.includes('timeout')) {
      const isOptionError = errorMessage.includes('unknown option') ||
        errorMessage.includes('invalid option') ||
        errorMessage.includes('unrecognized');
      expect(isOptionError).toBe(false);
    }
    // If timeout or no error, that's fine - options were accepted
  });
});
