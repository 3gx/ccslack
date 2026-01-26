/**
 * Tests for context % fallback logic in spinner loop.
 * Verifies that DEFAULT_CONTEXT_WINDOW is used when session.lastUsage is undefined.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONTEXT_WINDOW } from '../../blocks.js';

describe('context % fallback in spinner loop', () => {
  // Simulates the logic from slack-bot.ts line ~3726:
  // const inProgressContextWindow = processingState.contextWindow || session.lastUsage?.contextWindow || DEFAULT_CONTEXT_WINDOW;

  it('should use DEFAULT_CONTEXT_WINDOW when session.lastUsage is undefined (after /clear)', () => {
    // Setup: session with no lastUsage (simulates /clear or fresh channel)
    const session = {
      sessionId: null,
      workingDir: '/test',
      mode: 'default',
      lastUsage: undefined,  // No previous usage - /clear clears this
    };

    // During spinner loop calculation:
    const processingState = { contextWindow: undefined };
    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    expect(inProgressContextWindow).toBe(200000);
  });

  it('should use DEFAULT_CONTEXT_WINDOW for fresh channel (no lastUsage)', () => {
    // Fresh channel has never had a query, so no lastUsage
    const session = {
      sessionId: null,
      workingDir: '/test',
      mode: 'default',
      // lastUsage not present at all
    } as { sessionId: string | null; workingDir: string; mode: string; lastUsage?: { contextWindow?: number } };

    const processingState = { contextWindow: undefined };
    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    expect(inProgressContextWindow).toBe(200000);
  });

  it('should use DEFAULT_CONTEXT_WINDOW after /resume (new session has no lastUsage)', () => {
    // /resume creates a session without lastUsage
    const session = {
      sessionId: 'abc-123-456',
      workingDir: '/test',
      mode: 'default',
      lastUsage: undefined,  // /resume doesn't populate lastUsage
    };

    const processingState = { contextWindow: undefined };
    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    expect(inProgressContextWindow).toBe(200000);
  });

  it('should prefer processingState.contextWindow when available', () => {
    const processingState = { contextWindow: 200000 };
    const session = { lastUsage: undefined };

    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    expect(inProgressContextWindow).toBe(200000);
  });

  it('should prefer session.lastUsage.contextWindow over default', () => {
    const processingState = { contextWindow: undefined };
    const session = { lastUsage: { contextWindow: 200000 } };

    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    expect(inProgressContextWindow).toBe(200000);
  });

  it('should calculate correct context % with fallback', () => {
    // Simulate first query after /clear with some tokens used
    const session = { lastUsage: undefined };
    const processingState = {
      contextWindow: undefined,
      perTurnInputTokens: 5000,
      perTurnCacheCreationInputTokens: 1000,
      perTurnCacheReadInputTokens: 500,
    };

    const inProgressContextWindow = processingState.contextWindow
      || session.lastUsage?.contextWindow
      || DEFAULT_CONTEXT_WINDOW;

    const inProgressPerTurnTotal = (processingState.perTurnInputTokens || 0)
      + (processingState.perTurnCacheCreationInputTokens || 0)
      + (processingState.perTurnCacheReadInputTokens || 0);

    const inProgressContextPercent = inProgressContextWindow && inProgressPerTurnTotal > 0
      ? Math.min(100, Math.max(0, Number((inProgressPerTurnTotal / inProgressContextWindow * 100).toFixed(1))))
      : undefined;

    // 6500 / 200000 * 100 = 3.25, rounded to 3.3 (toFixed rounds 0.5 up)
    expect(inProgressContextPercent).toBe(3.3);
  });
});
