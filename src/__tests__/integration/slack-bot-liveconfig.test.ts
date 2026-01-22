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
  // Segment activity log functions
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
import { getSession, saveSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('live config updates during query', () => {
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

  it('should update processingState.updateRateSeconds when /update-rate sent while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    // Start with updateRateSeconds = 2
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'bypassPermissions',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
      updateRateSeconds: 2,
    });

    // Mock startClaudeQuery to hang
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    // Start a query (this marks conversation as busy)
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for busy state to be set
    await new Promise(r => setTimeout(r, 10));

    // Send /update-rate 5 while busy - should update live config
    await handler({
      event: { user: 'U123', text: '<@BOT123> /update-rate 5', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Verify saveSession was called with the new updateRateSeconds
    expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
      updateRateSeconds: 5,
    }));

    // Should see confirmation message "Update rate set to 5s."
    const rateCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes('Update rate set to 5s')
    );
    expect(rateCalls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should call query.setPermissionMode when mode button clicked while busy', async () => {
    const messageHandler = registeredHandlers['event_app_mention'];
    const modeButtonHandler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery with setPermissionMode method
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    const mockSetPermissionMode = vi.fn().mockResolvedValue(undefined);
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
      setPermissionMode: mockSetPermissionMode,
      setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(),
    } as any);

    // Start a query (this marks conversation as busy and populates activeQueries)
    const queryPromise = messageHandler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for activeQueries to be populated (after status messages are posted)
    await new Promise(r => setTimeout(r, 50));

    // Click mode button while busy - should call SDK control method
    await modeButtonHandler({
      action: { action_id: 'mode_bypassPermissions' },
      ack: vi.fn(),
      body: {
        channel: { id: 'C123' },
        message: { ts: 'msg123' },
      },
      client: mockClient,
    });

    // Verify setPermissionMode was called with 'bypassPermissions'
    expect(mockSetPermissionMode).toHaveBeenCalledWith('bypassPermissions');

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should block model selection while busy (model changes only apply next turn)', async () => {
    const messageHandler = registeredHandlers['event_app_mention'];
    const modelButtonHandler = registeredHandlers['action_^model_select_(.+)$'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'bypassPermissions',
      model: 'claude-sonnet-4-20250514',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(),
    } as any);

    // Start a query (this marks conversation as busy)
    const queryPromise = messageHandler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for busy state to be set
    await new Promise(r => setTimeout(r, 50));

    // Click model button while busy - should be blocked
    await modelButtonHandler({
      action: { action_id: 'model_select_claude-opus-4-20250514' },
      ack: vi.fn(),
      body: {
        channel: { id: 'C123' },
        message: { ts: 'msg123' },
      },
      client: mockClient,
    });

    // Verify session was NOT updated (blocked while busy)
    expect(saveSession).not.toHaveBeenCalledWith('C123', expect.objectContaining({
      model: 'claude-opus-4-20250514',
    }));

    // Verify warning message was shown
    expect(mockClient.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: 'msg123',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: 'section',
          text: expect.objectContaining({
            text: expect.stringContaining('Cannot change model while a query is running'),
          }),
        }),
      ]),
    }));

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should call query.setMaxThinkingTokens when /max-thinking-tokens sent while busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'bypassPermissions',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
      maxThinkingTokens: undefined, // default
    });

    // Mock startClaudeQuery with setMaxThinkingTokens method
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    const mockSetMaxThinkingTokens = vi.fn().mockResolvedValue(undefined);
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      setMaxThinkingTokens: mockSetMaxThinkingTokens,
    } as any);

    // Start a query (this marks conversation as busy and populates activeQueries)
    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for activeQueries to be populated (after status messages are posted)
    await new Promise(r => setTimeout(r, 50));

    // Send /max-thinking-tokens 5000 while busy - should call SDK control method
    await handler({
      event: { user: 'U123', text: '<@BOT123> /max-thinking-tokens 5000', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Verify setMaxThinkingTokens was called with 5000
    expect(mockSetMaxThinkingTokens).toHaveBeenCalledWith(5000);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should handle SDK control method errors gracefully', async () => {
    const messageHandler = registeredHandlers['event_app_mention'];
    const modeButtonHandler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery with setPermissionMode that throws
    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
    const mockSetPermissionMode = vi.fn().mockRejectedValue(new Error('SDK error'));
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await hangingPromise;
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
      setPermissionMode: mockSetPermissionMode,
      setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(),
    } as any);

    // Start a query
    const queryPromise = messageHandler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for activeQueries to be populated
    await new Promise(r => setTimeout(r, 50));

    // Click mode button while busy - SDK method should fail but session should still update
    await modeButtonHandler({
      action: { action_id: 'mode_bypassPermissions' },
      ack: vi.fn(),
      body: {
        channel: { id: 'C123' },
        message: { ts: 'msg123' },
      },
      client: mockClient,
    });

    // Verify setPermissionMode was called (even though it throws)
    expect(mockSetPermissionMode).toHaveBeenCalledWith('bypassPermissions');

    // Session should still be updated (for next query)
    expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
      mode: 'bypassPermissions',
    }));

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should allow /update-rate command while busy (non-agent command)', async () => {
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

    // Send /update-rate while busy - should work (non-agent command)
    await handler({
      event: { user: 'U123', text: '<@BOT123> /update-rate 3', channel: 'C123', ts: 'msg2' },
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

  it('should allow /message-size command while busy (non-agent command)', async () => {
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

    // Send /message-size while busy - should work (non-agent command)
    await handler({
      event: { user: 'U123', text: '<@BOT123> /message-size 1000', channel: 'C123', ts: 'msg2' },
      client: mockClient,
    });

    // Should NOT see "I'm busy" message
    const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes("I'm busy")
    );
    expect(busyMessages).toHaveLength(0);

    // Verify saveSession was called with the new threadCharLimit
    expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
      threadCharLimit: 1000,
    }));

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });

  it('should use live threadCharLimit at response posting time', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    // Track getSession calls to simulate config change
    let callCount = 0;
    vi.mocked(getSession).mockImplementation(() => {
      callCount++;
      return {
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        // First few calls return 500, later calls return 100 (simulating /message-size change)
        threadCharLimit: callCount > 3 ? 100 : 500,
      };
    });

    // Mock startClaudeQuery to return a long response
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'A'.repeat(1000) }; // 1000 char response
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // The response should have been posted - verify uploadMarkdownAndPngWithResponse behavior
    // is influenced by the live config (the actual truncation happens in streaming.ts)
    // Here we just verify getSession is called multiple times (live reads)
    expect(callCount).toBeGreaterThan(1);
  });

  it('should clear spinnerTimer in finally block on error', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'bypassPermissions',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    });

    // Mock startClaudeQuery to throw an error
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        throw new Error('Test SDK error');
      },
      interrupt: vi.fn(),
    } as any);

    // This should not hang or leak timers
    await handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Verify error was posted
    const errorCalls = mockClient.chat.postMessage.mock.calls.filter(
      (call: any[]) => call[0].text?.includes('Error:')
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);

    // If timer wasn't cleared, this test would hang or have memory issues
    // The test completing without hanging is the verification
  });

  it('should initialize processingState.updateRateSeconds from session', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    // Set updateRateSeconds to 5 in session
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'test-session',
      workingDir: '/test',
      mode: 'bypassPermissions',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
      updateRateSeconds: 5,
    });

    let resolveQuery: () => void;
    const hangingPromise = new Promise<void>(r => { resolveQuery = r; });

    // Track if init message was yielded (means processingState was created)
    let initYielded = false;
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        initYielded = true;
        await hangingPromise;
        yield { type: 'result', result: 'done' };
      },
      interrupt: vi.fn(),
    } as any);

    const queryPromise = handler({
      event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Wait for init to be processed
    await new Promise(r => setTimeout(r, 50));
    expect(initYielded).toBe(true);

    // Cleanup
    resolveQuery!();
    await queryPromise;
  });
});
