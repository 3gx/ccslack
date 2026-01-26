import { describe, it, expect, vi, beforeEach } from 'vitest';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// vi.mock calls must be at module level - Vitest hoists these
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
      message(handler: any) { registeredHandlers['message'] = handler; }
      action(pattern: RegExp, handler: any) { registeredHandlers[`action_${pattern.source}`] = handler; }
      view(pattern: RegExp, handler: any) { registeredHandlers[`view_${pattern.source}`] = handler; }
      async start() { return Promise.resolve(); }
    },
  };
});

vi.mock('../../claude-client.js', () => ({
  streamClaude: vi.fn(),
  startClaudeQuery: vi.fn(),
}));

vi.mock('../../session-manager.js', () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getOrCreateThreadSession: vi.fn().mockReturnValue({
    session: { sessionId: null, forkedFrom: null, workingDir: '/test/dir', mode: 'default',
      createdAt: Date.now(), lastActiveAt: Date.now(), pathConfigured: true,
      configuredPath: '/test/dir', configuredBy: 'U123', configuredAt: Date.now() },
    isNewFork: false,
  }),
  getThreadSession: vi.fn(),
  saveThreadSession: vi.fn(),
  saveMessageMapping: vi.fn(),
  findForkPointMessageId: vi.fn().mockReturnValue(null),
  deleteSession: vi.fn(),
  saveActivityLog: vi.fn().mockResolvedValue(undefined),
  getActivityLog: vi.fn().mockResolvedValue(null),
  getSegmentActivityLog: vi.fn().mockReturnValue(null),
  saveSegmentActivityLog: vi.fn(),
  updateSegmentActivityLog: vi.fn(),
  generateSegmentKey: vi.fn((channelId, messageTs) => `${channelId}_${messageTs}_seg_mock-uuid`),
  clearSegmentActivityLogs: vi.fn(),
}));

vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
}));

vi.mock('../../model-cache.js', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([
    { value: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', description: 'Fast' },
    { value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', description: 'Smart' },
  ]),
  isModelAvailable: vi.fn().mockResolvedValue(true),
  refreshModelCache: vi.fn().mockResolvedValue(undefined),
  getModelInfo: vi.fn().mockResolvedValue({ value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' }),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: { readFile: vi.fn().mockResolvedValue('# Test Plan Content') },
  },
}));

vi.mock('../../session-reader.js', () => ({
  getSessionFilePath: vi.fn().mockReturnValue('/test/session.jsonl'),
  sessionFileExists: vi.fn().mockReturnValue(false),
  readLastUserMessageUuid: vi.fn().mockReturnValue(null),
  extractPlanFilePathFromInput: vi.fn((input) => {
    if (!input) return null;
    const planPath = (input.file_path || input.path) as string | undefined;
    if (typeof planPath === 'string' &&
        planPath.includes('.claude/plans/') &&
        planPath.endsWith('.md')) {
      return planPath;
    }
    return null;
  }),
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('auto-compact notification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Test response' };
      },
      interrupt: vi.fn(),
    } as any);

    vi.resetModules();
    await import('../../slack-bot.js');
  });

  it('should notify user when auto-compaction triggers', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock SDK to emit status:compacting (START) before compact_boundary (END)
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };  // END
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should post auto-compact notification on status:compacting
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Auto-compacting context'),
      })
    );
    // Token count now appears in final checkered_flag, not initial gear message
  });

  it('should not notify when status:compacting is not received (backward compat)', async () => {
    // When SDK only sends compact_boundary without preceding status:compacting,
    // no gear message should be posted (backward compatibility with older SDK)
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock SDK to return compact_boundary WITHOUT status:compacting
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        // No status:compacting message - simulates older SDK behavior
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50000 } };
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should NOT post auto-compact notification without status:compacting
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    expect(autoCompactCalls.length).toBe(0);
  });

  it('should only notify once per query', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock SDK to return multiple status:compacting messages (edge case)
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // First
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // Duplicate (should be ignored)
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should only post auto-compact notification once (duplicates ignored)
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    expect(autoCompactCalls.length).toBe(1);
  });

  it('should post auto-compact message with gear emoji (no spinner, no token info)', async () => {
    // Token info now only appears in the final checkered_flag message,
    // since pre_tokens comes from compact_boundary which arrives AFTER status:compacting
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START - posts gear message
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };  // END
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should post auto-compact message with gear emoji (no spinner, no token info initially)
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    expect(autoCompactCalls.length).toBe(1);
    // Verify gear emoji is present
    expect(autoCompactCalls[0][0].text).toContain(':gear:');
    // Token info now only in checkered_flag, not in initial message
    expect(autoCompactCalls[0][0].text).not.toContain('tokens');
    // Verify no spinner character
    expect(autoCompactCalls[0][0].text).not.toMatch(/◐|◓|◑|◒/);
  });

  it('should show completion message with checkered_flag after auto-compact', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Track the auto-compact message ts
    let autoCompactMsgTs = 'autocompact123';
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 187802 } };  // END
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should update auto-compact message with checkered_flag on completion
    const checkeredFlagCalls = mockClient.chat.update.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes(':checkered_flag:') && call[0]?.text?.includes('Auto-compacted')
    );
    expect(checkeredFlagCalls.length).toBeGreaterThanOrEqual(1);
    // Verify it updates the correct message
    expect(checkeredFlagCalls[0][0].ts).toBe(autoCompactMsgTs);
    // Verify token count and duration format
    expect(checkeredFlagCalls[0][0].text).toContain('187,802 tokens');
    expect(checkeredFlagCalls[0][0].text).toMatch(/\d+\.\d+s/);
  });

  it('should detect completion exactly once (not on every stream_event)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    let autoCompactMsgTs = 'autocompact123';
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    // SDK emits: status:compacting → compact_boundary → stream_event → result
    // Completion fires on compact_boundary; stream_events and result do not re-trigger it
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };  // END
        // stream_event should NOT trigger completion
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } };
        // Only result should trigger completion
        yield { type: 'result', result: 'Hello' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Completion should be called exactly once (on compact_boundary, not on stream_events)
    // Filter for completion calls that update the auto-compact message
    const checkeredFlagCalls = mockClient.chat.update.mock.calls.filter(
      (call: any[]) => call[0]?.ts === autoCompactMsgTs && call[0]?.text?.includes(':checkered_flag:')
    );
    expect(checkeredFlagCalls.length).toBe(1);
  });

  it('should retry auto-compact notification on rate limit', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock SDK to emit status:compacting and compact_boundary
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };  // END
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    // Track call count to simulate rate limit on first auto-compact attempt
    let postMessageCallCount = 0;
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      postMessageCallCount++;
      // Rate limit the auto-compact notification on first attempt (call 3 = status, activity, then auto-compact)
      if (params.text?.includes('Auto-compacting context') && postMessageCallCount <= 3) {
        const rateLimitError = new Error('ratelimited') as any;
        rateLimitError.data = { error: 'ratelimited' };
        throw rateLimitError;
      }
      return { ts: `msg${postMessageCallCount}`, channel: 'C123' };
    });

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should have retried and eventually posted auto-compact notification
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    // At least 2 calls: first failed (rate limited), second succeeded (retry)
    expect(autoCompactCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should send checkered_flag update after timer is stopped (race-free)', async () => {
    // The checkered_flag update fires on compact_boundary (before timer could interfere),
    // and the timer only operates on statusMsgTs, never compactMsgTs
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    const autoCompactMsgTs = 'autocompact-race-test';
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    // Track the order of updates to detect race condition
    const updateOrder: string[] = [];
    mockClient.chat.update.mockImplementation(async (params: any) => {
      if (params.ts === autoCompactMsgTs) {
        if (params.text?.includes(':checkered_flag:')) {
          updateOrder.push('checkered_flag');
        } else if (params.text?.includes(':gear:')) {
          updateOrder.push('gear_spinner');
        }
      }
      return { ok: true };
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };  // END
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // The checkered_flag should be the LAST update to the auto-compact message
    // With the robust fix, no timer updates can happen after checkered_flag
    const lastAutoCompactUpdate = updateOrder[updateOrder.length - 1];
    expect(lastAutoCompactUpdate).toBe('checkered_flag');
  });

  it('should update checkered_flag with correct ts even when processingState is cleared', async () => {
    // This test ensures the checkered_flag update uses the captured ts value
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    const autoCompactMsgTs = 'autocompact-captured-ts';
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 50000 } };  // END
        yield { type: 'result', result: 'Done' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Verify the checkered_flag update used the correct ts
    const checkeredFlagCalls = mockClient.chat.update.mock.calls.filter(
      (call: any[]) => call[0]?.ts === autoCompactMsgTs && call[0]?.text?.includes(':checkered_flag:')
    );
    expect(checkeredFlagCalls.length).toBe(1);
    expect(checkeredFlagCalls[0][0].text).toContain('Auto-compacted context');
  });

  it('should guarantee checkered_flag is final state even with delayed messages', async () => {
    // Simulate a more realistic scenario with delays between messages
    // The checkered_flag must be the final state regardless of timing
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
      updateRateSeconds: 1,  // Fast timer for testing
    });

    const autoCompactMsgTs = 'autocompact-delayed';
    let updateCount = 0;
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    // Track all updates with their content
    const allUpdates: { ts: string; text: string }[] = [];
    mockClient.chat.update.mockImplementation(async (params: any) => {
      updateCount++;
      if (params.ts === autoCompactMsgTs) {
        allUpdates.push({ ts: params.ts, text: params.text });
      }
      return { ok: true };
    });

    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 200000 } };  // END
        // Simulate SDK processing time (timer might fire during this)
        await wait(50);
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
        await wait(50);
        yield { type: 'result', result: 'Done after delay' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // The LAST update to the auto-compact message must be checkered_flag
    const lastUpdate = allUpdates[allUpdates.length - 1];
    expect(lastUpdate).toBeDefined();
    expect(lastUpdate.text).toContain(':checkered_flag:');
    expect(lastUpdate.text).toContain('200,000 tokens');
  });

  it('should update checkered_flag immediately on compact_boundary (not wait for result)', async () => {
    // Verifies that checkered_flag fires at compact_boundary time, not at query end.
    // The wait(100) gap between compact_boundary and subsequent events proves the
    // update happened before the rest of the query continued.
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'existing-session',
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    const autoCompactMsgTs = 'autocompact-immediate';
    mockClient.chat.postMessage.mockImplementation(async (params: any) => {
      if (params.text?.includes('Auto-compacting context')) {
        return { ts: autoCompactMsgTs, channel: 'C123' };
      }
      return { ts: 'msg123', channel: 'C123' };
    });

    // Track all updates to the compact message in order
    const compactUpdates: { text: string; order: number }[] = [];
    let updateCounter = 0;
    mockClient.chat.update.mockImplementation(async (params: any) => {
      updateCounter++;
      if (params.ts === autoCompactMsgTs) {
        compactUpdates.push({ text: params.text, order: updateCounter });
      }
      return { ok: true };
    });

    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'status', status: 'compacting' };  // START
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 120000 } };  // END - should trigger checkered_flag here
        // Gap to prove checkered_flag happened before these events
        await wait(100);
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } };
        yield { type: 'result', result: 'Hello' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // checkered_flag should have fired exactly once
    expect(compactUpdates.length).toBe(1);
    expect(compactUpdates[0].text).toContain(':checkered_flag:');
    expect(compactUpdates[0].text).toContain('120,000 tokens');
    // No further updates to compact message after checkered_flag
    // (the result-time handleCompactionEnd is a no-op since fields are cleared)
  });
});
