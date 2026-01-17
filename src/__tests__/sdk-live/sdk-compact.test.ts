import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Compact Command Test
 *
 * Tests whether passing `/compact` as a prompt to a resumed session
 * triggers the CLI's compaction feature.
 *
 * Isolated in separate file because:
 * 1. Session resume may hang on edge cases
 * 2. Compaction behavior is unknown - may have side effects
 *
 * Run with: npm run test:sdk
 */

// SDK may be configured via environment variable OR config file
// Only skip if we explicitly want to skip live tests
const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// Handler for expected SDK stream errors
const streamErrorHandler = (err: Error) => {
  if (err.message === 'write after end') {
    return;
  }
  throw err;
};

describe.skipIf(SKIP_LIVE)('SDK Compact Command (Isolated)', { timeout: 120000 }, () => {
  beforeAll(() => {
    process.on('uncaughtException', streamErrorHandler);
  });

  afterAll(() => {
    process.off('uncaughtException', streamErrorHandler);
  });

  it('TEST: /compact as prompt triggers compaction on resumed session', { timeout: 90000 }, async () => {
    // Step 1: Create a session with a simple prompt
    console.log('\n=== Step 1: Creating initial session ===');
    const q1 = query({
      prompt: 'Say "hello world" and nothing else',
      options: { maxTurns: 1 },
    });

    let sessionId: string | null = null;
    const step1Messages: any[] = [];

    for await (const msg of q1) {
      step1Messages.push({ type: msg.type, subtype: (msg as any).subtype });

      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        console.log(`Session created: ${sessionId}`);
      }

      if (msg.type === 'result') {
        console.log('Step 1 complete');
        break;
      }
    }

    expect(sessionId).not.toBeNull();
    console.log('Step 1 messages:', step1Messages.map(m => `${m.type}:${m.subtype || ''}`).join(', '));

    // Step 2: Resume session with /compact as prompt
    console.log('\n=== Step 2: Resuming with /compact ===');
    const q2 = query({
      prompt: '/compact',
      options: {
        maxTurns: 1,
        resume: sessionId!,
      },
    });

    const step2Messages: any[] = [];
    let compactBoundaryFound = false;
    let compactingStatusFound = false;
    let errorOccurred = false;
    let errorMessage = '';

    try {
      // Race against timeout - compaction or resume might hang
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 60000);
      });

      const iteratePromise = (async () => {
        for await (const msg of q2) {
          const msgInfo = {
            type: msg.type,
            subtype: (msg as any).subtype,
            status: (msg as any).status,
          };
          step2Messages.push(msgInfo);
          console.log('MSG:', JSON.stringify(msgInfo));

          // Check for compact_boundary message
          if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
            compactBoundaryFound = true;
            console.log('>>> COMPACT BOUNDARY FOUND! <<<');
            console.log('Compact metadata:', JSON.stringify((msg as any).compact_metadata));
          }

          // Check for compacting status
          if ((msg as any).status === 'compacting') {
            compactingStatusFound = true;
            console.log('>>> COMPACTING STATUS FOUND! <<<');
          }

          if (msg.type === 'result') {
            console.log('Step 2 complete');
            break;
          }
        }
      })();

      await Promise.race([iteratePromise, timeoutPromise]);
    } catch (e: any) {
      errorOccurred = true;
      errorMessage = e.message || String(e);
      console.log('Error during /compact:', errorMessage);
    } finally {
      try {
        const interruptTimeout = new Promise<void>((resolve) => {
          setTimeout(resolve, 5000);
        });
        await Promise.race([q2.interrupt().catch(() => {}), interruptTimeout]);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Build results summary
    const results = {
      step2Messages: step2Messages.map(m => `${m.type}:${m.subtype || m.status || ''}`),
      compactBoundaryFound,
      compactingStatusFound,
      errorOccurred,
      errorMessage,
    };

    // Force output via expect failure message
    const summary = JSON.stringify(results, null, 2);

    // The test passes if we got ANY response (not just timeout)
    // We're testing whether /compact is recognized, not whether compaction succeeds
    if (errorOccurred && errorMessage === 'timeout') {
      expect.fail(`Test timed out. Results: ${summary}`);
    }

    // Always output results for visibility
    process.stderr.write(`\n\n=== COMPACT TEST RESULTS ===\n${summary}\n\n`);

    // Check if compaction actually happened
    if (compactBoundaryFound || compactingStatusFound) {
      // SUCCESS - compaction was triggered
      process.stderr.write('>>> SUCCESS: /compact triggered compaction! <<<\n\n');
      expect(compactBoundaryFound || compactingStatusFound).toBe(true);
    } else {
      // /compact was processed but no compaction markers found
      // This means /compact is treated as regular text, not a command
      // Fail with details so we can see what happened
      expect.fail(`/compact processed but no compaction markers found.\nResults: ${summary}`);
    }
  });
});
