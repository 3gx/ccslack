/**
 * Live SDK Test: ExitPlanMode with allowedPrompts
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/exit-plan-mode-allowed.test.ts
 */

import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('ExitPlanMode - Allowed Prompts', { timeout: 120000 }, () => {
  it('captures ExitPlanMode tool with allowedPrompts', async () => {
    const events: any[] = [];
    let exitPlanModeFound = false;
    let exitPlanModeIndex: number | null = null;
    let accumulatedJson = '';

    const result = query({
      prompt: 'Write a brief 2-sentence plan (do NOT execute anything) then immediately call ExitPlanMode with allowedPrompts containing one entry: {tool: "Bash", prompt: "run tests"}. Do not use any other tools.',
      options: {
        permissionMode: 'plan',
        includePartialMessages: true,
        maxTurns: 3,
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
          console.log('[Test] ExitPlanMode started at index:', event.index);
        }

        if (event?.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            exitPlanModeIndex === event.index) {
          accumulatedJson += event.delta.partial_json || '';
          events.push(event.delta);
        }
      }
    }

    console.log('[Test] ExitPlanMode found:', exitPlanModeFound);
    console.log('[Test] Accumulated JSON length:', accumulatedJson.length);
    console.log('[Test] Accumulated JSON:', accumulatedJson.substring(0, 500));

    expect(exitPlanModeFound).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    if (accumulatedJson) {
      const parsed = JSON.parse(accumulatedJson);
      console.log('[Test] Parsed ExitPlanMode input:', JSON.stringify(parsed, null, 2));

      if (parsed.allowedPrompts) {
        expect(Array.isArray(parsed.allowedPrompts)).toBe(true);
        if (parsed.allowedPrompts.length > 0) {
          const prompt = parsed.allowedPrompts[0];
          expect(prompt).toHaveProperty('tool');
          expect(prompt).toHaveProperty('prompt');
        }
      }
    }
  });
});
