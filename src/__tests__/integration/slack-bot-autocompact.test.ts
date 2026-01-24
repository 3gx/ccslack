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

    // Mock SDK to return auto-triggered compact_boundary
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should post auto-compact notification
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Auto-compacting context'),
      })
    );
    // Should include token count
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('150,000 tokens'),
      })
    );
  });

  it('should not notify for manual compaction in regular flow', async () => {
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

    // Mock SDK to return manual-triggered compact_boundary
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50000 } };
        yield { type: 'result', result: 'Response after manual compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should NOT post auto-compact notification for manual trigger
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

    // Mock SDK to return multiple compact_boundary messages
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should only post auto-compact notification once
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    expect(autoCompactCalls.length).toBe(1);
  });

  it('should post auto-compact message with spinner character', async () => {
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
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
        yield { type: 'result', result: 'Response after compaction' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should post auto-compact message with spinner and elapsed time format
    const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
    );
    expect(autoCompactCalls.length).toBe(1);
    // Verify spinner character is present
    expect(autoCompactCalls[0][0].text).toMatch(/◐|◓|◑|◒/);
    // Verify elapsed time format
    expect(autoCompactCalls[0][0].text).toContain('(0.0s)');
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
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 187802 } };
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

  it('should detect completion only on result message (not stream_event)', async () => {
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

    // SDK emits: compact_boundary → stream_event → result
    // Completion should NOT trigger on stream_event
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };
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

    // Completion should be called exactly once (on result, not on stream_events)
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

    // Mock SDK to return auto-triggered compact_boundary
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
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
});
