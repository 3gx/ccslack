import { describe, it, expect } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Live Test: Verify if PermissionRequest hook fires in acceptEdits mode
 *
 * Critical question: The SDK has two permission mechanisms:
 * 1. canUseTool callback - we know this is NOT called in acceptEdits mode
 * 2. PermissionRequest hook - does THIS fire for Bash in acceptEdits mode?
 *
 * Run with: npx vitest run src/__tests__/sdk-live/acceptedits-hook.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('acceptEdits mode PermissionRequest hook (live)', { timeout: 120000 }, () => {
  it('verifies if PermissionRequest hook fires for Bash in acceptEdits mode', async () => {
    let permissionRequestHookFired = false;
    let hookToolName: string | null = null;
    const hookEvents: string[] = [];

    const result = query({
      prompt: 'Run this exact bash command: echo "hello from hook test"',
      options: {
        permissionMode: 'acceptEdits',
        maxTurns: 2,
        // Register PermissionRequest hook
        hooks: {
          PermissionRequest: [{
            hooks: [async (input, toolUseID, options) => {
              console.log('[Test] PermissionRequest hook fired!');
              console.log('[Test] Hook input:', JSON.stringify(input, null, 2));

              permissionRequestHookFired = true;
              hookToolName = (input as any).tool_name;
              hookEvents.push(`PermissionRequest:${hookToolName}`);

              // Approve the tool
              return {
                decision: 'approve',
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: {
                    behavior: 'allow',
                    updatedInput: (input as any).tool_input,
                  },
                },
              };
            }],
          }],
        },
        // Also provide canUseTool to see which one fires
        canUseTool: async (toolName, input, _options) => {
          console.log('[Test] canUseTool callback fired for:', toolName);
          hookEvents.push(`canUseTool:${toolName}`);
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    // Consume all messages and track what tools were used
    const toolsUsed: string[] = [];
    for await (const msg of result) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
          }
        }
      }
    }
    console.log('Tools used:', toolsUsed);

    console.log('\n=== RESULTS ===');
    console.log('PermissionRequest hook fired:', permissionRequestHookFired);
    console.log('Hook tool name:', hookToolName);
    console.log('All hook events:', hookEvents);

    // Force failure to see what happened in output
    expect(
      { permissionRequestHookFired, hookToolName, hookEvents, toolsUsed },
      'Checking what fired'
    ).toEqual({ permissionRequestHookFired: false, hookToolName: null, hookEvents: [], toolsUsed: ['Bash'] });
  });

  it('verifies canUseTool fires when Bash NOT in allowedTools', async () => {
    let canUseToolFired = false;
    let canUseToolToolName: string | null = null;
    const toolsUsed: string[] = [];

    const result = query({
      prompt: 'Run this exact bash command: echo "hello with restricted allowedTools"',
      options: {
        permissionMode: 'default',
        maxTurns: 2,
        // IMPORTANT: Only allow Read and Glob, NOT Bash
        // This should force canUseTool to be called for Bash
        allowedTools: ['Read', 'Glob', 'Grep'],
        canUseTool: async (toolName, input, _options) => {
          console.log('[Test-Restricted] canUseTool fired for:', toolName);
          canUseToolFired = true;
          canUseToolToolName = toolName;
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    for await (const msg of result) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
          }
        }
      }
    }

    // Force failure to see what happened
    expect(
      { canUseToolFired, canUseToolToolName, toolsUsed },
      'RESTRICTED allowedTools - Checking if canUseTool fires for Bash'
    ).toEqual({ canUseToolFired: false, canUseToolToolName: null, toolsUsed: ['Bash'] });
  });
});
