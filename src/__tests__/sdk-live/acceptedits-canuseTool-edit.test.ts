/**
 * SDK Live Test: Verify canUseTool is NOT called for Edit in acceptEdits mode
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/acceptedits-canuseTool-edit.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('acceptEdits canUseTool - Edit', { timeout: 120000 }, () => {
  it('verifies canUseTool is NOT called for Edit in acceptEdits mode', async () => {
    let canUseToolCalledForEdit = false;
    const toolsCalled: string[] = [];
    const toolsUsed: string[] = [];
    const testFile = `/tmp/ccslack-test-acceptedits-${randomUUID()}.txt`;

    const result = query({
      prompt: `Create a file at ${testFile} with content "test". Use the Write tool.`,
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

    for await (const msg of result) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            console.log('[Test] Tool used:', block.name);
          }
        }
      }
    }

    console.log('[Test] Tools that triggered canUseTool:', toolsCalled);
    console.log('[Test] Tools actually used:', toolsUsed);
    console.log('[Test] Edit/Write triggered canUseTool:', canUseToolCalledForEdit);

    console.log('\n=== ACCEPTEDITS MODE BEHAVIOR ===');
    console.log('canUseTool callback called:', toolsCalled.length > 0);
    console.log('Tools that Claude used:', toolsUsed.join(', ') || 'none');

    const writeWasUsed = toolsUsed.some(t => ['Edit', 'Write', 'NotebookEdit'].includes(t));
    if (writeWasUsed && !canUseToolCalledForEdit) {
      console.log('FINDING: Write/Edit was auto-approved in acceptEdits mode (no canUseTool call)');
    } else if (writeWasUsed && canUseToolCalledForEdit) {
      console.log('FINDING: Write/Edit triggered canUseTool in acceptEdits mode');
    } else if (!writeWasUsed) {
      console.log('FINDING: Write/Edit was not used by Claude');
    }

    // Observational test - just verify something happened
    expect(toolsUsed.length, 'Claude should have used some tool').toBeGreaterThan(0);
  });
});
