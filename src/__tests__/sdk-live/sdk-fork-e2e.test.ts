import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

/**
 * End-to-End Fork Tests
 *
 * These tests verify that point-in-time forking ACTUALLY works with real sessions.
 * Unlike the canary test, these use real session IDs and UUIDs.
 */
describe.skipIf(SKIP_LIVE)('SDK Fork E2E', { timeout: 120000 }, () => {

  describe.concurrent('uuid field verification', () => {
    it('assistant message has uuid field (not just message.id)', async () => {
      // This test ensures we're capturing the RIGHT field for forking
      const q = query({
        prompt: 'say "hello world"',
        options: { maxTurns: 1 },
      });

      let assistantMsg: any = null;
      let sessionId: string | null = null;

      for await (const msg of q) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          sessionId = (msg as any).session_id;
        }
        if (msg.type === 'assistant') {
          assistantMsg = msg;
        }
      }

      // CRITICAL: Both fields must exist
      expect(assistantMsg).not.toBeNull();
      expect(assistantMsg.uuid).toBeDefined();
      expect(typeof assistantMsg.uuid).toBe('string');
      expect(assistantMsg.uuid).toMatch(/^[0-9a-f-]{36}$/); // UUID format

      // message.id also exists but is NOT what resumeSessionAt needs
      expect(assistantMsg.message?.id).toBeDefined();
      expect(assistantMsg.message.id).toMatch(/^msg_/); // Anthropic format

      // They should be DIFFERENT
      expect(assistantMsg.uuid).not.toBe(assistantMsg.message.id);

      console.log(`uuid: ${assistantMsg.uuid}`);
      console.log(`message.id: ${assistantMsg.message.id}`);
    });
  });

  describe.concurrent('actual fork with resumeSessionAt', () => {
    it('fork using uuid succeeds and preserves context', async () => {
      // Step 1: Create session with memorable context
      const q1 = query({
        prompt: 'Remember this secret code: ALPHA-7749. Just confirm you remembered it.',
        options: { maxTurns: 1 },
      });

      let sessionId: string | null = null;
      let messageUuid: string | null = null;

      for await (const msg of q1) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          sessionId = (msg as any).session_id;
        }
        if (msg.type === 'assistant' && (msg as any).uuid) {
          messageUuid = (msg as any).uuid;
        }
      }

      expect(sessionId).not.toBeNull();
      expect(messageUuid).not.toBeNull();
      console.log(`Session: ${sessionId}, UUID: ${messageUuid}`);

      // Step 2: Fork from that message using UUID
      const q2 = query({
        prompt: 'What was the secret code I told you?',
        options: {
          maxTurns: 1,
          resume: sessionId!,
          forkSession: true,
          resumeSessionAt: messageUuid!,  // Using UUID, not message.id
        },
      });

      let forkedSessionId: string | null = null;
      let response = '';

      for await (const msg of q2) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          forkedSessionId = (msg as any).session_id;
        }
        if (msg.type === 'assistant' && (msg as any).message?.content) {
          const content = (msg as any).message.content;
          if (Array.isArray(content)) {
            response += content.map((c: any) => c.text || '').join('');
          }
        }
      }

      // Verify fork created new session
      expect(forkedSessionId).not.toBeNull();
      expect(forkedSessionId).not.toBe(sessionId);

      // Verify context was preserved - should know the secret code
      expect(response.toLowerCase()).toContain('alpha');
      console.log(`Forked session: ${forkedSessionId}`);
      console.log(`Response: ${response}`);
    });

    it('fork using message.id FAILS (documents correct behavior)', async () => {
      // This test documents that message.id does NOT work for resumeSessionAt
      // If this test starts passing, the SDK behavior changed

      const q1 = query({
        prompt: 'Say hello',
        options: { maxTurns: 1 },
      });

      let sessionId: string | null = null;
      let messageId: string | null = null;  // Anthropic's message.id

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

      // Try to fork using message.id (WRONG) - should fail
      let errorOccurred = false;
      let errorMessage = '';

      try {
        const q2 = query({
          prompt: 'test',
          options: {
            maxTurns: 1,
            resume: sessionId!,
            forkSession: true,
            resumeSessionAt: messageId!,  // Using message.id (WRONG)
          },
        });

        for await (const msg of q2) {
          // If we get here, it didn't fail as expected
        }
      } catch (e: any) {
        errorOccurred = true;
        errorMessage = e.message || String(e);
      }

      // Should fail because message.id is not a valid UUID
      expect(errorOccurred).toBe(true);
      console.log(`Expected error: ${errorMessage}`);
    });
  });

  describe.concurrent('fork after /clear simulation', () => {
    it('can fork from OLD session after main session changes', async () => {
      // Simulates: user has session S1, runs /clear, then replies to old thread

      // Step 1: Create "old" session S1 with context
      const q1 = query({
        prompt: 'Remember: my favorite color is BLUE. Confirm.',
        options: { maxTurns: 1 },
      });

      let oldSessionId: string | null = null;
      let oldMessageUuid: string | null = null;

      for await (const msg of q1) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          oldSessionId = (msg as any).session_id;
        }
        if (msg.type === 'assistant' && (msg as any).uuid) {
          oldMessageUuid = (msg as any).uuid;
        }
      }

      console.log(`Old session (S1): ${oldSessionId}`);

      // Step 2: Create "new" session S2 (simulates /clear creating fresh session)
      const q2 = query({
        prompt: 'Remember: my favorite color is RED. Confirm.',
        options: { maxTurns: 1 },
      });

      let newSessionId: string | null = null;

      for await (const msg of q2) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          newSessionId = (msg as any).session_id;
        }
      }

      console.log(`New session (S2): ${newSessionId}`);
      expect(newSessionId).not.toBe(oldSessionId);

      // Step 3: Fork from OLD session S1 (simulates reply to old thread)
      // This is the critical test - after /clear, we must be able to fork from S1
      const q3 = query({
        prompt: 'What is my favorite color?',
        options: {
          maxTurns: 1,
          resume: oldSessionId!,  // Fork from S1, not S2
          forkSession: true,
          resumeSessionAt: oldMessageUuid!,
        },
      });

      let forkedSessionId: string | null = null;
      let response = '';

      for await (const msg of q3) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          forkedSessionId = (msg as any).session_id;
        }
        if (msg.type === 'assistant' && (msg as any).message?.content) {
          const content = (msg as any).message.content;
          if (Array.isArray(content)) {
            response += content.map((c: any) => c.text || '').join('');
          }
        }
      }

      // Should create new session (not S1 or S2)
      expect(forkedSessionId).not.toBeNull();
      expect(forkedSessionId).not.toBe(oldSessionId);
      expect(forkedSessionId).not.toBe(newSessionId);

      // Should have S1's context (BLUE), not S2's context (RED)
      expect(response.toLowerCase()).toContain('blue');
      expect(response.toLowerCase()).not.toContain('red');

      console.log(`Forked from S1: ${forkedSessionId}`);
      console.log(`Response (should say BLUE): ${response}`);
    });
  });
});
