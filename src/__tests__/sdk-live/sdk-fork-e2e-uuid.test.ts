/**
 * SDK Fork E2E Test - UUID Field Verification
 *
 * Run with: npm run sdk-test -- src/__tests__/sdk-live/sdk-fork-e2e-uuid.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Fork E2E - UUID', { timeout: 120000 }, () => {
  it('assistant message has uuid field (not just message.id)', async () => {
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

    expect(assistantMsg).not.toBeNull();
    expect(assistantMsg.uuid).toBeDefined();
    expect(typeof assistantMsg.uuid).toBe('string');
    expect(assistantMsg.uuid).toMatch(/^[0-9a-f-]{36}$/);

    expect(assistantMsg.message?.id).toBeDefined();
    expect(assistantMsg.message.id).toMatch(/^msg_/);

    expect(assistantMsg.uuid).not.toBe(assistantMsg.message.id);

    console.log(`uuid: ${assistantMsg.uuid}`);
    console.log(`message.id: ${assistantMsg.message.id}`);
  });
});
