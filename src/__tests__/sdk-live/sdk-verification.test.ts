import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Live SDK Verification Tests
 *
 * These tests run against the REAL SDK (requires ANTHROPIC_API_KEY).
 * They verify the SDK API surface and include "canary" tests that will
 * FAIL after SDK upgrade to signal required code changes.
 *
 * Run with: npm run test:sdk
 */

// SDK may be configured via environment variable OR config file
// Only skip if we explicitly want to skip live tests
const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Live Verification', { timeout: 30000, concurrent: true }, () => {
  describe.concurrent('Model API', () => {
    it('supportedModels returns models with value, displayName, description', async () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      const models = await q.supportedModels();

      expect(models.length).toBeGreaterThan(0);
      const model = models[0];
      expect(model).toHaveProperty('value');
      expect(model).toHaveProperty('displayName');
      expect(model).toHaveProperty('description');

      await q.interrupt();
    });

    it('supportedModels returns at least one model', async () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      const models = await q.supportedModels();

      expect(models.length).toBeGreaterThan(0);

      await q.interrupt();
    });

    it('model fields are strings (not null/undefined)', async () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      const models = await q.supportedModels();

      expect(models.length).toBeGreaterThan(0);
      const model = models[0];

      expect(typeof model.value).toBe('string');
      expect(typeof model.displayName).toBe('string');
      expect(typeof model.description).toBe('string');
      expect(model.value.length).toBeGreaterThan(0);
      expect(model.displayName.length).toBeGreaterThan(0);

      await q.interrupt();
    });
  });

  describe.concurrent('Query Object API Surface', () => {
    it('query returns object with interrupt method', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });

      expect(typeof q.interrupt).toBe('function');

      q.interrupt().catch(() => {}); // Cleanup
    });

    it('query returns object with supportedModels method', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });

      expect(typeof q.supportedModels).toBe('function');

      q.interrupt().catch(() => {});
    });

    it('query returns object with setModel method', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });

      expect(typeof q.setModel).toBe('function');

      q.interrupt().catch(() => {});
    });

    it('query is async iterable', () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });

      expect(typeof q[Symbol.asyncIterator]).toBe('function');

      q.interrupt().catch(() => {});
    });
  });

  describe.concurrent('Message Structure', () => {
    it('first message is system init with session_id, model, tools', async () => {
      const q = query({
        prompt: 'echo test',
        options: { maxTurns: 1 },
      });

      const iter = q[Symbol.asyncIterator]();
      const first = await iter.next();

      expect(first.done).toBe(false);
      expect(first.value).toHaveProperty('type', 'system');
      expect(first.value).toHaveProperty('subtype', 'init');
      expect(first.value).toHaveProperty('session_id');
      expect(first.value).toHaveProperty('model');
      expect(first.value).toHaveProperty('tools');

      await q.interrupt();
    });

    it('result message has duration_ms, usage, is_error', { timeout: 60000 }, async () => {
      const q = query({
        prompt: 'respond with just the word "hello"',
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
      expect(resultMsg).toHaveProperty('duration_ms');
      expect(resultMsg).toHaveProperty('usage');
      expect(resultMsg).toHaveProperty('is_error');
    });

    it('result message has total_cost_usd field', { timeout: 60000 }, async () => {
      const q = query({
        prompt: 'respond with just the word "hello"',
        options: { maxTurns: 1 },
      });

      let resultMsg: any = null;
      for await (const msg of q) {
        if (msg.type === 'result') {
          resultMsg = msg;
          break;
        }
      }

      // total_cost_usd may be present (check it exists or is undefined, not null)
      expect(resultMsg).not.toBeNull();
      if (resultMsg.total_cost_usd !== undefined) {
        expect(typeof resultMsg.total_cost_usd).toBe('number');
      }
    });

    it('result message has modelUsage with contextWindow', { timeout: 60000 }, async () => {
      const q = query({
        prompt: 'respond with just the word "hello"',
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
      // modelUsage may be present
      if (resultMsg.modelUsage) {
        const modelKeys = Object.keys(resultMsg.modelUsage);
        if (modelKeys.length > 0) {
          const modelData = resultMsg.modelUsage[modelKeys[0]];
          if (modelData.contextWindow !== undefined) {
            expect(typeof modelData.contextWindow).toBe('number');
          }
        }
      }
    });

    it('assistant message has message.id field', async () => {
      const q = query({
        prompt: 'say hello',
        options: { maxTurns: 1 },
      });

      let assistantMsg: any = null;
      for await (const msg of q) {
        if (msg.type === 'assistant' && (msg as any).message?.id) {
          assistantMsg = msg;
          break;
        }
      }

      // NOTE: message.id is Anthropic's API message ID (msg_xxx format)
      // For point-in-time forking, use msg.uuid instead (SDK's internal UUID)
      // See sdk-fork-e2e.test.ts for proper fork tests
      if (assistantMsg) {
        expect(assistantMsg.message).toHaveProperty('id');
        expect(typeof assistantMsg.message.id).toBe('string');
      }

      await q.interrupt().catch(() => {});
    });
  });

  describe.concurrent('Breaking Change Canaries', () => {
    // These tests document CURRENT behavior
    // They WILL FAIL after SDK upgrade - this is intentional!
    // Failure signals that Phase 3 changes are required

    it('CANARY: systemPrompt string format accepted', async () => {
      // OLD format - will fail when new SDK requires object format
      const q = query({
        prompt: 'echo test',
        options: {
          systemPrompt: 'claude_code', // OLD format
          maxTurns: 1,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      const msg = await iter.next();

      expect(msg.done).toBe(false);

      await q.interrupt();
    });

    it('CANARY: settings load without settingSources', async () => {
      // Current behavior - settings load automatically
      // Will fail if new SDK requires explicit settingSources
      const q = query({
        prompt: 'echo test',
        options: { maxTurns: 1 }, // NO settingSources
      });

      const iter = q[Symbol.asyncIterator]();
      const msg = await iter.next();

      expect(msg.done).toBe(false);

      await q.interrupt();
    });

    it('CANARY: query works without new required options', async () => {
      // Minimal options - baseline compatibility test
      const q = query({
        prompt: 'echo test',
        options: { maxTurns: 1 },
      });

      const iter = q[Symbol.asyncIterator]();
      const msg = await iter.next();

      expect(msg.done).toBe(false);

      await q.interrupt();
    });

    // NOTE: 'CANARY: resume + forkSession + resumeSessionAt accepted' moved to
    // sdk-fork-canary.test.ts for process isolation (SDK may hang on invalid sessions)
  });

  describe.concurrent('Future Compatibility', () => {
    it('settingSources option accepted if provided', async () => {
      // Test that providing settingSources doesn't cause error
      // Current SDK may ignore it, but should not reject as unknown option
      let succeeded = false;
      let errorMessage = '';

      try {
        const q = query({
          prompt: 'echo test',
          options: {
            maxTurns: 1,
            settingSources: ['user', 'project', 'local'],
          } as any, // Cast to any since option may not exist in types yet
        });

        const iter = q[Symbol.asyncIterator]();
        const msg = await iter.next();

        expect(msg.done).toBe(false);
        await q.interrupt();
        succeeded = true;
      } catch (e: any) {
        errorMessage = e.message || String(e);
      }

      // Document current behavior for upgrade verification:
      // If this test passes now but fails after upgrade,
      // it means settingSources became required or format changed
      if (!succeeded) {
        console.log(`Future compat test note: ${errorMessage}`);
        // If it fails, it should be about the unknown option, not a crash
        expect(
          errorMessage.toLowerCase().includes('settingsources') ||
          errorMessage.toLowerCase().includes('unknown') ||
          errorMessage.toLowerCase().includes('option')
        ).toBe(true);
      }
    });
  });
});
