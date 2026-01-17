 Plan: Implement /compact Command

  Overview

  Add /compact command to Slack bot that:
  1. Validates session exists
  2. Shows progress spinner while compacting
  3. Resumes session with /compact as prompt to SDK
  4. Listens for compact_boundary message
  5. Reports success with token reduction stats

  ---
  Phase 1: Add Command Definition

  File: src/commands.ts

  1.1 Add to switch statement (line ~49)

  case 'compact':
    return handleCompact(session);

  1.2 Create handler function

  function handleCompact(session: Session): CommandResult {
    if (!session.sessionId) {
      return {
        handled: true,
        response: 'No active session to compact. Start a conversation first.',
      };
    }

    return {
      handled: true,
      compactSession: true,  // Flag for slack-bot.ts
    };
  }

  1.3 Add to help text (line ~87)

  '/compact - Compact the current session to reduce context size'

  1.4 Update CommandResult type

  compactSession?: boolean;

  ---
  Phase 2: Handle Compact in Slack Bot

  File: src/slack-bot.ts

  2.1 Add handler after commandResult checks (around line 788)

  if (commandResult.compactSession) {
    await runCompactSession(client, channelId, threadTs, userId, session);
    return;
  }

  2.2 Create runCompactSession function

  async function runCompactSession(
    client: SlackClient,
    channelId: string,
    threadTs: string | undefined,
    userId: string,
    session: Session
  ): Promise<void> {
    // 1. Post initial status message with spinner
    // 2. Start Claude query with '/compact' as prompt
    // 3. Update status on 'compacting' status messages
    // 4. Capture 'compact_boundary' message metadata
    // 5. Update status on completion with token stats
    // 6. Handle errors/abort
  }

  2.3 Status message flow

  - Initial: ◐ Compacting session... [0s]
  - During: ◓ Analyzing conversation... [2s]
  - Complete: ✓ Compacted | 5,234 → 3,123 tokens | saved 40% | 4.2s

  ---
  Phase 3: Add Block Builders (Optional Enhancement)

  File: src/blocks.ts

  3.1 Create compact-specific blocks (if needed)

  - Could reuse existing buildStatusPanelBlocks with status='compacting'
  - Or create dedicated buildCompactResultBlocks for completion

  ---
  Phase 4: Unit Tests

  File: src/__tests__/unit/commands.test.ts

  4.1 Test command parsing

  describe('/compact command', () => {
    it('should return compactSession flag when session exists', () => {
      const result = parseCommand('/compact', { sessionId: 'test-id' });
      expect(result.handled).toBe(true);
      expect(result.compactSession).toBe(true);
    });

    it('should return error when no session', () => {
      const result = parseCommand('/compact', {});
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No active session');
    });
  });

  ---
  Phase 5: Integration Tests

  File: src/__tests__/integration/slack-bot.test.ts

  5.1 Test full compact flow

  it('should show progress and complete compaction', async () => {
    // Mock SDK to return compact_boundary
    vi.mocked(startClaudeQuery).mockReturnValue(/* mock with compact_boundary */);

    // Trigger @bot /compact
    await handler({ event: { text: '@bot /compact', ... } });

    // Verify status messages posted
    // Verify final message shows token reduction
  });

  5.2 Test abort functionality

  it('should handle abort during compaction', async () => {
    // Test abort button works
  });

  ---
  Phase 6: Keep SDK Test

  File: src/__tests__/sdk-live/sdk-compact.test.ts

  - Already created ✓
  - Verifies /compact as prompt triggers real compaction
  - Documents expected SDK behavior

  ---
  Files to Modify
  ┌─────────────────────────────────────────────┬─────────────────────────────────────────────┐
  │                    File                     │                   Changes                   │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────┤
  │ src/commands.ts                             │ Add /compact case, handler, help text, type │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────┤
  │ src/slack-bot.ts                            │ Add runCompactSession function and dispatch │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────┤
  │ src/__tests__/unit/commands.test.ts         │ Add /compact command tests                  │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────┤
  │ src/__tests__/integration/slack-bot.test.ts │ Add compact flow tests                      │
  └─────────────────────────────────────────────┴─────────────────────────────────────────────┘
  Files to Keep (no changes)
  ┌────────────────────────────────────────────┬──────────────────────┐
  │                    File                    │        Status        │
  ├────────────────────────────────────────────┼──────────────────────┤
  │ src/__tests__/sdk-live/sdk-compact.test.ts │ Keep for posterity ✓ │
  └────────────────────────────────────────────┴──────────────────────┘
  ---
  User Experience

  User: @bot /compact

  Bot: [eyes reaction]

  Bot: [Status Message]
  ┌──────────────────────────────────────┐
  │ ◐ Compacting session...              │
  │ Default | claude-sonnet-4-5          │
  │                                      │
  │ [Abort]                              │
  └──────────────────────────────────────┘

  [After ~15-20 seconds]

  Bot: [Status Message Updated]
  ┌──────────────────────────────────────┐
  │ ✓ Compaction complete                │
  │ Default | claude-sonnet-4-5 | 4.2s   │
  │                                      │
  │ Tokens: 5,234 → 3,123 (saved 40%)    │
  └──────────────────────────────────────┘

  ---
  Verification Commands

  # Type check
  npx tsc --noEmit

  # Unit tests
  npm test

  # SDK live test (confirms /compact works)
  npm run test:sdk

  ---

