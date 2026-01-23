/**
 * SDK Fork E2E Test - Fork Preserves Context
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/sdk-fork-e2e-context.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Fork E2E - Context', { timeout: 120000 }, () => {
  it('fork using uuid succeeds and preserves context', async () => {
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

    const q2 = query({
      prompt: 'What was the secret code I told you?',
      options: {
        maxTurns: 1,
        resume: sessionId!,
        forkSession: true,
        resumeSessionAt: messageUuid!,
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

    expect(forkedSessionId).not.toBeNull();
    expect(forkedSessionId).not.toBe(sessionId);
    expect(response.toLowerCase()).toContain('alpha');
    console.log(`Forked session: ${forkedSessionId}`);
    console.log(`Response: ${response}`);
  });
});
