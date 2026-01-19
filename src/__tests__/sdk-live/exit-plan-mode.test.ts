import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Live SDK Test: ExitPlanMode stream events
 *
 * Verifies that ExitPlanMode tool calls are visible in stream_event messages
 * and that we can accumulate the input JSON from input_json_delta events.
 *
 * Run with: make sdk-test -- src/__tests__/sdk-live/exit-plan-mode.test.ts
 */

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('ExitPlanMode stream events (live)', { timeout: 120000 }, () => {
  it('captures ExitPlanMode tool with allowedPrompts', async () => {
    const events: any[] = [];
    let exitPlanModeFound = false;
    let exitPlanModeIndex: number | null = null;
    let accumulatedJson = '';

    const result = query({
      // Be very explicit: do NOT do any work, just create a text plan and call ExitPlanMode
      prompt: 'Write a brief 2-sentence plan (do NOT execute anything) then immediately call ExitPlanMode with allowedPrompts containing one entry: {tool: "Bash", prompt: "run tests"}. Do not use any other tools.',
      options: {
        permissionMode: 'plan',
        includePartialMessages: true,  // REQUIRED for stream_event
        maxTurns: 3,  // Give more turns in case model needs them
      },
    });

    for await (const msg of result) {
      if ((msg as any).type === 'stream_event') {
        const event = (msg as any).event;

        // Detect ExitPlanMode tool start
        if (event?.type === 'content_block_start' &&
            event.content_block?.type === 'tool_use' &&
            event.content_block?.name === 'ExitPlanMode') {
          exitPlanModeFound = true;
          exitPlanModeIndex = event.index;
          console.log('[Test] ExitPlanMode started at index:', event.index);
        }

        // Accumulate JSON from input_json_delta
        // Field is 'partial_json' (confirmed in plans/native-limit-vs-rate-summary.md:877)
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

    // Parse and verify structure
    if (accumulatedJson) {
      const parsed = JSON.parse(accumulatedJson);
      console.log('[Test] Parsed ExitPlanMode input:', JSON.stringify(parsed, null, 2));

      // allowedPrompts may be present if Claude requested permissions
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

    // Should be valid JSON (even if empty object)
    if (accumulatedJson) {
      const parsed = JSON.parse(accumulatedJson);
      expect(typeof parsed).toBe('object');
    }
  });
});
