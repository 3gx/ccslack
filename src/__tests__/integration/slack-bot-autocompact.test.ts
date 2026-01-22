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
