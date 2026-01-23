/**
 * Live SDK Test: ExitPlanMode without allowedPrompts
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/exit-plan-mode-no-prompts.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('ExitPlanMode - No Prompts', { timeout: 120000 }, () => {
  it('detects ExitPlanMode tool without allowedPrompts', async () => {
    let exitPlanModeFound = false;
    let exitPlanModeIndex: number | null = null;
    let accumulatedJson = '';

    const result = query({
      prompt: 'Make a simple plan to say hello. Use ExitPlanMode when ready.',
      options: {
        permissionMode: 'plan',
        includePartialMessages: true,
        maxTurns: 2,
      },
    });

    for await (const msg of result) {
      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;

        if (event?.type === 'content_block_start' &&
            event.content_block?.type === 'tool_use' &&
            event.content_block?.name === 'ExitPlanMode') {
          exitPlanModeFound = true;
          exitPlanModeIndex = event.index;
        }

        if (event?.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            exitPlanModeIndex === event.index) {
          accumulatedJson += event.delta.partial_json || '';
        }
      }
    }

    console.log('[Test] ExitPlanMode found (no prompts):', exitPlanModeFound);
    console.log('[Test] Accumulated JSON:', accumulatedJson);

    expect(exitPlanModeFound).toBe(true);

    if (accumulatedJson) {
      const parsed = JSON.parse(accumulatedJson);
      expect(typeof parsed).toBe('object');
    }
  });
});
