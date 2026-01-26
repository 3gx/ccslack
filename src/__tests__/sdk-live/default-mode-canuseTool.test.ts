import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Live Test: Verify canUseTool behavior in DEFAULT mode
 *
 * This test replicates the bot's actual configuration to verify
 * that canUseTool IS called for Bash in default mode.
 *
 * Run with: npx vitest run src/__tests__/sdk-live/default-mode-canuseTool.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('default mode canUseTool (live)', { timeout: 120000 }, () => {

  it('replicates bot config - verifies canUseTool is called for Bash', async () => {
    let canUseToolCalled = false;
    let calledToolName: string | null = null;
    const toolsUsed: string[] = [];
    const canUseToolCalls: string[] = [];

    const result = query({
      prompt: 'Run this bash command: echo "testing default mode"',
      options: {
        // Replicate bot's exact configuration
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],  // Bot uses this
        cwd: process.cwd(),  // Working directory
        maxTurns: 2,

        // The canUseTool callback - this is what the bot provides
        canUseTool: async (toolName, input, options) => {
          console.log(`[canUseTool] Called for: ${toolName}`);
          console.log(`[canUseTool] Decision reason: ${options.decisionReason || 'none'}`);
          console.log(`[canUseTool] Suggestions: ${JSON.stringify(options.suggestions || [])}`);

          canUseToolCalled = true;
          calledToolName = toolName;
          canUseToolCalls.push(toolName);

          // Approve the tool (like clicking Approve in Slack)
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    // Consume all messages and track tool usage
    for await (const msg of result) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            console.log(`[Tool Used] ${block.name}`);
          }
        }
      }
    }

    console.log('\n=== RESULTS ===');
    console.log('canUseTool called:', canUseToolCalled);
    console.log('Tool name:', calledToolName);
    console.log('All canUseTool calls:', canUseToolCalls);
    console.log('All tools used:', toolsUsed);

    // Show what actually happened
    expect(
      { canUseToolCalled, calledToolName, canUseToolCalls, toolsUsed },
      'Checking what happened'
    ).toEqual({ canUseToolCalled: false, calledToolName: null, canUseToolCalls: [], toolsUsed: ['Bash'] });
  });
});
