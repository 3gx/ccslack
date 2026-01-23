/**
 * SDK Live Test: Verify canUseTool is NOT called for Edit in acceptEdits mode
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/acceptedits-canuseTool-edit.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('acceptEdits canUseTool - Edit', { timeout: 120000 }, () => {
  it('verifies canUseTool is NOT called for Edit in acceptEdits mode', async () => {
    let canUseToolCalledForEdit = false;
    const toolsCalled: string[] = [];

    const result = query({
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
    expect(canUseToolCalledForEdit, 'Edit/Write should be auto-approved in acceptEdits mode').toBe(false);
  });
});
