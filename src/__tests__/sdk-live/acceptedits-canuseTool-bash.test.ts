/**
 * SDK Live Test: Verify canUseTool behavior for Bash in acceptEdits mode
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/acceptedits-canuseTool-bash.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('acceptEdits canUseTool - Bash', { timeout: 120000 }, () => {
  it('verifies if canUseTool is called for Bash in acceptEdits mode', async () => {
    let canUseToolCalled = false;
    let calledToolName: string | null = null;
    let calledInput: Record<string, unknown> | null = null;
    const toolsUsed: string[] = [];
    const messages: SDKMessage[] = [];

    const result = query({
      prompt: 'Run this exact bash command: echo "hello world"',
      options: {
        permissionMode: 'acceptEdits',
        maxTurns: 2,
        canUseTool: async (toolName, input, _options) => {
          console.log('[Test] canUseTool called for:', toolName);
          canUseToolCalled = true;
          calledToolName = toolName;
          calledInput = input;
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    for await (const msg of result) {
      messages.push(msg);
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            console.log('[Test] Tool used:', block.name);
          }
        }
      }
      if (msg.type === 'result' && (msg as any).subtype === 'tool_result') {
        console.log('[Test] Tool result received');
      }
    }

    console.log('[Test] canUseTool was called:', canUseToolCalled);
    console.log('[Test] Tool name from callback:', calledToolName);
    console.log('[Test] Tools actually used:', toolsUsed);
    console.log('[Test] Total messages:', messages.length);

    console.log('\n=== ACCEPTEDITS MODE BEHAVIOR ===');
    console.log('canUseTool callback called:', canUseToolCalled);
    console.log('Tools that Claude used:', toolsUsed.join(', ') || 'none');

    const bashWasUsed = toolsUsed.includes('Bash');
    if (bashWasUsed && !canUseToolCalled) {
      console.log('FINDING: Bash was auto-approved in acceptEdits mode (no canUseTool call)');
    } else if (!bashWasUsed) {
      console.log('FINDING: Bash was not used by Claude');
    }

    expect(messages.length).toBeGreaterThan(0);
  });
});
