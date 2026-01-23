/**
 * SDK Fork E2E Test - Fork After Clear
 *
 * Simulates: user has session S1, runs /clear, then replies to old thread.
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/sdk-fork-e2e-clear.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Fork E2E - Clear', { timeout: 120000 }, () => {
  it('can fork from OLD session after main session changes', async () => {
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
    const q3 = query({
      prompt: 'What is my favorite color?',
      options: {
        maxTurns: 1,
        resume: oldSessionId!,
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

    expect(forkedSessionId).not.toBeNull();
    expect(forkedSessionId).not.toBe(oldSessionId);
    expect(forkedSessionId).not.toBe(newSessionId);

    expect(response.toLowerCase()).toContain('blue');
    expect(response.toLowerCase()).not.toContain('red');

    console.log(`Forked from S1: ${forkedSessionId}`);
    console.log(`Response (should say BLUE): ${response}`);
  });
});
