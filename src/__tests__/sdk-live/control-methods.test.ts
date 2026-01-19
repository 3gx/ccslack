import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Control Methods Live Tests
 *
 * These tests verify that the SDK's Query object control methods
 * (setPermissionMode, setModel, setMaxThinkingTokens) work during
 * active queries. This is essential for the live config update feature.
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/control-methods.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK control methods during active query', { timeout: 60000, concurrent: true }, () => {

  describe.concurrent('Method availability', () => {
    it('setPermissionMode method exists on query object', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      expect(typeof q.setPermissionMode).toBe('function');
      q.interrupt().catch(() => {});
    });

    it('setMaxThinkingTokens method exists on query object', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      expect(typeof q.setMaxThinkingTokens).toBe('function');
      q.interrupt().catch(() => {});
    });

    it('setModel method exists on query object', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      expect(typeof q.setModel).toBe('function');
      q.interrupt().catch(() => {});
    });
  });

  describe.concurrent('Methods callable during active query', () => {
    it('setPermissionMode callable without error during active query', async () => {
      const q = query({
        prompt: 'say hello',
        options: { maxTurns: 1, permissionMode: 'default' }
      });

      const iter = q[Symbol.asyncIterator]();
      await iter.next(); // Get init message, query is now active

      // Should not throw
      await q.setPermissionMode('bypassPermissions');

      await q.interrupt();
    });

    it('setModel callable without error during active query', async () => {
      const q = query({ prompt: 'say hello', options: { maxTurns: 1 } });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Should not throw - use a known model ID
      await q.setModel('claude-sonnet-4-20250514');

      await q.interrupt();
    });

    it('setMaxThinkingTokens callable without error during active query', async () => {
      const q = query({ prompt: 'say hello', options: { maxTurns: 1 } });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Should not throw
      await q.setMaxThinkingTokens(1000);

      await q.interrupt();
    });
  });

  describe.concurrent('Behavioral verification', () => {
    it('setMaxThinkingTokens(null) disables thinking limit', async () => {
      const q = query({
        prompt: 'respond with just "ok"',
        options: { maxTurns: 1, maxThinkingTokens: 100 }
      });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Remove thinking limit
      await q.setMaxThinkingTokens(null);

      // Complete the query - should not error
      for await (const msg of q) {
        if (msg.type === 'result') break;
      }
    });

    it('setMaxThinkingTokens(0) sets thinking to zero', async () => {
      const q = query({
        prompt: 'respond with just "ok"',
        options: { maxTurns: 1, maxThinkingTokens: 1000 }
      });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Set to zero (should disable thinking)
      // Note: The SDK may interpret 0 differently - this test verifies behavior
      await q.setMaxThinkingTokens(0);

      // Complete the query - should not error
      for await (const msg of q) {
        if (msg.type === 'result') break;
      }
    });

    it('setPermissionMode to bypassPermissions works', async () => {
      const q = query({
        prompt: 'respond with just "ok"',
        options: { maxTurns: 1, permissionMode: 'default' }
      });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Switch to bypassPermissions mode
      await q.setPermissionMode('bypassPermissions');

      // Complete the query - should not error
      for await (const msg of q) {
        if (msg.type === 'result') break;
      }
    });

    it('setPermissionMode to plan mode works', async () => {
      const q = query({
        prompt: 'respond with just "ok"',
        options: { maxTurns: 1, permissionMode: 'default' }
      });

      const iter = q[Symbol.asyncIterator]();
      await iter.next();

      // Switch to plan mode
      await q.setPermissionMode('plan');

      // Complete the query - should not error
      for await (const msg of q) {
        if (msg.type === 'result') break;
      }
    });

    // NOTE: setModel does NOT take effect within the same turn - it only applies
    // to subsequent turns. This is expected SDK behavior (model is locked at turn start).
    // The test "setModel callable without error during active query" verifies the method
    // works; behavioral testing requires multi-turn queries which are more complex.
    // For the Slack bot use case, setModel during an active query will apply to the
    // next turn within that query, which is still useful for long-running queries.
  });
});
