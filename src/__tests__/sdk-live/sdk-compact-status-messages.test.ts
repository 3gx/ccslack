import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Compact Status Messages - Sequencing Test
 *
 * Verifies the order of SDK messages during compaction:
 * 1. {subtype: 'status', status: 'compacting'} - sent at START of compaction
 * 2. {subtype: 'compact_boundary'} - sent at END of compaction
 *
 * This is critical for showing proper UI feedback:
 * - Show :gear: "Compacting..." when status:compacting arrives (START)
 * - Show :checkered_flag: "Compacted" when compact_boundary arrives (END)
 *
 * Run with: npm run test:sdk -- src/__tests__/sdk-live/sdk-compact-status-messages.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const streamErrorHandler = (err: Error) => {
  if (err.message === 'write after end') {
    return;
  }
  throw err;
};

describe.skipIf(SKIP_LIVE)('SDK Compact Status Messages', { timeout: 180000 }, () => {
  beforeAll(() => {
    process.on('uncaughtException', streamErrorHandler);
  });

  afterAll(() => {
    process.off('uncaughtException', streamErrorHandler);
  });

  it('status:compacting arrives BEFORE compact_boundary (verifies sequencing)', { timeout: 120000 }, async () => {
    // Step 1: Create a session
    const q1 = query({
      prompt: 'hi',
      options: { maxTurns: 1 },
    });

    let sessionId: string | null = null;

    for await (const msg of q1) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
      }
      if (msg.type === 'result') break;
    }

    expect(sessionId).not.toBeNull();

    // Step 2: Run /compact and track message order
    const q2 = query({
      prompt: '/compact',
      options: {
        maxTurns: 1,
        resume: sessionId!,
      },
    });

    const startTime = Date.now();
    let statusCompactingTime: number | null = null;
    let compactBoundaryTime: number | null = null;
    let statusCompactingIndex: number | null = null;
    let compactBoundaryIndex: number | null = null;
    let messageIndex = 0;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 90000);
      });

      const iteratePromise = (async () => {
        for await (const msg of q2) {
          const now = Date.now();
          messageIndex++;

          // Detect status:compacting (START of compaction)
          if (msg.type === 'system' &&
              (msg as any).subtype === 'status' &&
              (msg as any).status === 'compacting') {
            statusCompactingTime = now;
            statusCompactingIndex = messageIndex;
          }

          // Detect compact_boundary (END of compaction)
          if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
            compactBoundaryTime = now;
            compactBoundaryIndex = messageIndex;
          }

          if (msg.type === 'result') break;
        }
      })();

      await Promise.race([iteratePromise, timeoutPromise]);
    } finally {
      try {
        await Promise.race([
          q2.interrupt().catch(() => {}),
          new Promise<void>(resolve => setTimeout(resolve, 5000))
        ]);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Output timing for debugging
    const statusTime = statusCompactingTime ? ((statusCompactingTime - startTime) / 1000).toFixed(2) : 'N/A';
    const boundaryTime = compactBoundaryTime ? ((compactBoundaryTime - startTime) / 1000).toFixed(2) : 'N/A';
    const gap = (statusCompactingTime && compactBoundaryTime)
      ? ((compactBoundaryTime - statusCompactingTime) / 1000).toFixed(2)
      : 'N/A';

    process.stderr.write(`\n=== COMPACT SEQUENCING ===\n`);
    process.stderr.write(`status:compacting at ${statusTime}s (message #${statusCompactingIndex})\n`);
    process.stderr.write(`compact_boundary at ${boundaryTime}s (message #${compactBoundaryIndex})\n`);
    process.stderr.write(`Gap: ${gap}s\n\n`);

    // Assertions
    expect(statusCompactingTime).not.toBeNull();
    expect(compactBoundaryTime).not.toBeNull();
    expect(statusCompactingIndex).not.toBeNull();
    expect(compactBoundaryIndex).not.toBeNull();

    // Critical: status:compacting must come BEFORE compact_boundary
    expect(statusCompactingIndex).toBeLessThan(compactBoundaryIndex!);
    expect(statusCompactingTime).toBeLessThan(compactBoundaryTime!);
  });

  it('compact_boundary contains trigger and pre_tokens metadata', { timeout: 120000 }, async () => {
    // Step 1: Create a session
    const q1 = query({
      prompt: 'hi',
      options: { maxTurns: 1 },
    });

    let sessionId: string | null = null;

    for await (const msg of q1) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
      }
      if (msg.type === 'result') break;
    }

    expect(sessionId).not.toBeNull();

    // Step 2: Run /compact and capture compact_boundary metadata
    const q2 = query({
      prompt: '/compact',
      options: {
        maxTurns: 1,
        resume: sessionId!,
      },
    });

    let compactMetadata: { trigger?: string; pre_tokens?: number } | null = null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 90000);
      });

      const iteratePromise = (async () => {
        for await (const msg of q2) {
          if (msg.type === 'system' && (msg as any).subtype === 'compact_boundary') {
            compactMetadata = (msg as any).compact_metadata;
          }
          if (msg.type === 'result') break;
        }
      })();

      await Promise.race([iteratePromise, timeoutPromise]);
    } finally {
      try {
        await Promise.race([
          q2.interrupt().catch(() => {}),
          new Promise<void>(resolve => setTimeout(resolve, 5000))
        ]);
      } catch {
        // Ignore cleanup errors
      }
    }

    process.stderr.write(`\n=== COMPACT METADATA ===\n`);
    process.stderr.write(`trigger: ${compactMetadata?.trigger}\n`);
    process.stderr.write(`pre_tokens: ${compactMetadata?.pre_tokens}\n\n`);

    // Assertions
    expect(compactMetadata).not.toBeNull();
    expect(compactMetadata?.trigger).toBe('manual'); // /compact is manual trigger
    expect(typeof compactMetadata?.pre_tokens).toBe('number');
    expect(compactMetadata?.pre_tokens).toBeGreaterThan(0);
  });
});
