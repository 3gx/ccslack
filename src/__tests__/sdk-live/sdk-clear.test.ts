import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK Clear Behavior Documentation Test
 *
 * IMPORTANT: The SDK does NOT have a built-in /clear command.
 * Sending "/clear" as a prompt is just text - it doesn't trigger any special behavior.
 * The session ID remains the SAME after sending /clear.
 *
 * The actual "clear" functionality in our Slack bot works by:
 * 1. Setting sessionId to NULL in sessions.json
 * 2. Next message starts fresh WITHOUT resuming (no resume option passed)
 *
 * We don't actually send /clear to the SDK - we just clear our session tracking.
 *
 * Run with: npm run test:sdk
 */

// SDK may be configured via environment variable OR config file
// Only skip if we explicitly want to skip live tests
const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('SDK Clear Behavior', { timeout: 60000 }, () => {
  it('TEST: Starting fresh session (no resume) works correctly', { timeout: 30000 }, async () => {
    // This test verifies that starting a fresh session without resume works
    // This is how our /clear actually works - by NOT resuming
    console.log('\n=== Testing fresh session start (how /clear works) ===');

    const q = query({
      prompt: 'Say "fresh start" and nothing else',
      options: { maxTurns: 1 },
      // NO resume option - this is a fresh session
    });

    let sessionId: string | null = null;
    let gotResult = false;

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        console.log(`New session created: ${sessionId}`);
      }
      if (msg.type === 'result') {
        console.log(`Result: ${(msg as any).result?.slice(0, 50)}`);
        gotResult = true;
        break;
      }
    }

    expect(sessionId).not.toBeNull();
    expect(gotResult).toBe(true);
    console.log('>>> SUCCESS: Fresh session works correctly <<<');
  });
});
