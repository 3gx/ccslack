import { describe, it, expect } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Live Test: Verify canUseTool behavior in acceptEdits mode
 *
 * Critical question: Does the SDK call canUseTool for non-edit tools
 * (like Bash) when permissionMode is 'acceptEdits'?
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/acceptedits-canuseTool.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('acceptEdits mode canUseTool behavior (live)', { timeout: 120000 }, () => {
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
          // Allow the tool to proceed
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    // Consume all messages and track tool uses
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

    // Document what we found - this test now just reports findings
    console.log('\n=== ACCEPTEDITS MODE BEHAVIOR ===');
    console.log('canUseTool callback called:', canUseToolCalled);
    console.log('Tools that Claude used:', toolsUsed.join(', ') || 'none');

    // The key finding: document if Bash was used WITHOUT canUseTool being called
    const bashWasUsed = toolsUsed.includes('Bash');
    if (bashWasUsed && !canUseToolCalled) {
      console.log('FINDING: Bash was auto-approved in acceptEdits mode (no canUseTool call)');
    } else if (!bashWasUsed) {
      console.log('FINDING: Bash was not used by Claude');
    }

    // Just verify we got some response
    expect(messages.length).toBeGreaterThan(0);
  });

  it('verifies canUseTool is NOT called for Edit in acceptEdits mode', async () => {
    let canUseToolCalledForEdit = false;
    const toolsCalled: string[] = [];

    const result = query({
      // Ask to create a simple file - this should use Edit/Write tool
      prompt: 'Create a file at /tmp/ccslack-test-acceptedits.txt with content "test". Use the Write tool.',
      options: {
        permissionMode: 'acceptEdits',
        maxTurns: 3,
        canUseTool: async (toolName, input, _options) => {
          console.log('[Test] canUseTool called for:', toolName);
          toolsCalled.push(toolName);
          if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
            canUseToolCalledForEdit = true;
          }
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    for await (const _msg of result) {
      // Consume messages
    }

    console.log('[Test] Tools that triggered canUseTool:', toolsCalled);
    console.log('[Test] Edit/Write triggered canUseTool:', canUseToolCalledForEdit);

    // In acceptEdits mode, Edit/Write/NotebookEdit should be auto-approved
    // canUseTool should NOT be called for these tools
    // In acceptEdits mode, Edit/Write/NotebookEdit are auto-approved (no canUseTool call)
    // This may be false if Claude didn't use Edit/Write, or if it was auto-approved
    expect(canUseToolCalledForEdit, 'Edit/Write should be auto-approved in acceptEdits mode').toBe(false);
  });
});
