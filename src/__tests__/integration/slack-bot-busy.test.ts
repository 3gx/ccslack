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

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('busy state handling', () => {
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

  it('should allow /status command while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang (simulates busy)
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise; // Hang until resolved
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query (this marks conversation as busy)
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait a tick for busy state to be set
    await new Promise(r => setTimeout(r, 10));

    // Now send /status while busy - should work!
    await handler({
      event: { user: 'U123', text: '<@BOT123> /status', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should NOT see "I'm busy" message for /status
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(0);

    // Should see status response blocks (no separate mode header)
    const statusCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => {
        const blocks = call[0].blocks;
        // Look for status blocks (has 'Session Status' header)
        return blocks?.some((b: any) =>
          b.type === 'header' && b.text?.text === 'Session Status'
        );
      }
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should allow /help command while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Send /help while busy - should work!
    await handler({
      event: { user: 'U123', text: '<@BOT123> /help', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should NOT see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(0);

    // Should see help response (contains Available Commands with asterisks for bold)
    const helpCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes('*Available Commands*')
    );
    expect(helpCalls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should allow /mode command while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Send /mode while busy - should work!
    await handler({
      event: { user: 'U123', text: '<@BOT123> /mode', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should NOT see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(0);

    // Should see mode picker (mode_selection block)
    const modeCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => {
        const blocks = call[0].blocks;
        return blocks?.some((b: any) =>
          b.block_id === 'mode_selection' ||
          b.elements?.some((e: any) => e.action_id?.startsWith('mode_'))
        );
      }
    );
    expect(modeCalls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should block regular queries while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start first query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try second query - should be blocked
    await handler({
      event: { user: 'U123', text: '<@BOT123> another question', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should block /compact while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try /compact while busy - should be blocked
    await handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should block /clear while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try /clear while busy - should be blocked
    await handler({
      event: { user: 'U123', text: '<@BOT123> /clear', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should allow /context command while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
      lastUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
        cost: '0.05',
      },
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Send /context while busy - should work!
    await handler({
      event: { user: 'U123', text: '<@BOT123> /context', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should NOT see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(0);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should block regular query when /compact is running', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang (simulates /compact running)
    let resolveCompact: () => void;
    const hangingPromise = new Promise<void>(r => { resolveCompact = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
        await hangingPromise;
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1000 } };
        yield { type: 'result', result: 'compacted' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start /compact
    const compactPromise = handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'compact-ts' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try regular query while /compact is running - should be blocked
    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'query-ts' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Cleanup
    resolveCompact!();
    await compactPromise;
  });

  it('should block concurrent /compact commands', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveCompact: () => void;
    const hangingPromise = new Promise<void>(r => { resolveCompact = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
        await hangingPromise;
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1000 } };
        yield { type: 'result', result: 'compacted' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start first /compact
    const compactPromise = handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'compact1-ts' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try second /compact while first is running - should be blocked
    await handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'compact2-ts' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Cleanup
    resolveCompact!();
    await compactPromise;
  });

  it('should remove :eyes: at end of /compact, not at start', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Track when :eyes: is removed relative to compact_boundary
    let eyesRemovedBeforeBoundary = false;
    let boundaryReached = false;
    let resolveCompact: () => void;
    const hangingPromise = new Promise<void>(r => { resolveCompact = r; });

    // Override reactions.remove to track timing
    mockClient.reactions.remove = vi.fn().mockImplementation(() => {
      if (!boundaryReached) {
        eyesRemovedBeforeBoundary = true;
      }
      return Promise.resolve({});
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
        await hangingPromise;
        boundaryReached = true;
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1000 } };
        yield { type: 'result', result: 'compacted' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start /compact
    const compactPromise = handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'compact-ts' },
      client: mockClient,
    });

    // Wait a bit for the status message to be posted
    await new Promise(r => setTimeout(r, 10));

    // At this point, :eyes: should NOT have been removed yet
    expect(eyesRemovedBeforeBoundary).toBe(false);

    // Let compaction complete
    resolveCompact!();
    await compactPromise;

    // Now :eyes: should have been removed
    expect(mockClient.reactions.remove).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'compact-ts',
      name: 'eyes',
    });
  });

  it('should add :x: emoji when query is blocked due to busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start first query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try second query - should be blocked and get :x:
    await handler({
      event: { user: 'U123', text: '<@BOT123> another question', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Should add :x: emoji to the blocked message
    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'msg2',
      name: 'x',
    });

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should add :x: emoji when /compact is blocked due to busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try /compact while busy - should be blocked and get :x:
    await handler({
      event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'compact-msg' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Should add :x: emoji to the blocked message
    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'compact-msg',
      name: 'x',
    });

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should add :x: emoji when /clear is blocked due to busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    await new Promise(r => setTimeout(r, 10));

    // Try /clear while busy - should be blocked and get :x:
    await handler({
      event: { user: 'U123', text: '<@BOT123> /clear', channel: 'C123', ts: 'clear-msg' },
      client: mockClient,
    });

    // Should see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(1);

    // Should add :x: emoji to the blocked message
    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: 'clear-msg',
      name: 'x',
    });

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });
});
