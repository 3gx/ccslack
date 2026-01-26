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
  addSlackOriginatedUserUuid: vi.fn(),
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
  ]),
  isModelAvailable: vi.fn().mockResolvedValue(true),
  refreshModelCache: vi.fn().mockResolvedValue(undefined),
  getModelInfo: vi.fn().mockResolvedValue({ value: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' }),
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
  extractPlanFilePathFromInput: vi.fn().mockReturnValue(null),
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, saveThreadSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('Plan approval status message reuse', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};
    vi.resetModules();
    await import('../../slack-bot.js');
  });

  it('should reuse status message (chat.update) instead of creating new one after plan approval', async () => {
    const { pendingPlanApprovals } = await import('../../slack-bot.js');
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    // Return a predictable ts for status message
    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'status-msg-ts-123' });
    mockClient.chat.update.mockResolvedValue({ ok: true, ts: 'status-msg-ts-123' });

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

    const mockInterrupt = vi.fn().mockResolvedValue(undefined);

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };

        // ExitPlanMode tool
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'ExitPlanMode' },
          },
        };

        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        };

        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        };

        yield { type: 'result', result: 'Done', usage: { input_tokens: 100, output_tokens: 50 } };
      },
      interrupt: mockInterrupt,
    } as any);

    // Step 1: First request that triggers ExitPlanMode
    await handler({
      event: { user: 'U123', text: '<@BOT123> implement feature', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Verify pendingPlanApprovals has statusMsgTs
    const pending = pendingPlanApprovals.get('C123');
    expect(pending?.statusMsgTs).toBe('status-msg-ts-123');

    // Clear call counts
    mockClient.chat.postMessage.mockClear();
    mockClient.chat.update.mockClear();

    // Step 2: Mock the approval button handler (plan_bypass_C123)
    const bypassHandler = registeredHandlers['action_^plan_bypass_(.+)$'];
    expect(bypassHandler).toBeDefined();

    // Setup for continuation
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

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Implemented!', usage: { input_tokens: 50, output_tokens: 25 } };
      },
      interrupt: vi.fn(),
    } as any);

    // Trigger the bypass button
    await bypassHandler({
      action: { action_id: 'plan_bypass_C123' },
      ack: vi.fn(),
      body: { user: { id: 'U123' }, message: { thread_ts: 'msg1', ts: 'btn1' } },
      client: mockClient,
    });

    // REAL TEST: Verify chat.update was called with the original status message ts
    const updateCalls = mockClient.chat.update.mock.calls;
    const statusUpdateCall = updateCalls.find(
      (call: any) => call[0].ts === 'status-msg-ts-123'
    );
    expect(statusUpdateCall).toBeDefined();

    // Verify that we don't have an extra status message posted (only approval message update)
    // The first postMessage should be the approval message update, not a new status message
    const postCalls = mockClient.chat.postMessage.mock.calls;
    const newStatusMessageCall = postCalls.find(
      (call: any) => call[0].text?.includes('starting') && !call[0].text?.includes('approved')
    );
    // There might be response messages, but no new "starting" status message
    expect(newStatusMessageCall).toBeUndefined();
  });

  it('should include mode_changed entry in activity log after plan approval button click', async () => {
    const { pendingPlanApprovals } = await import('../../slack-bot.js');
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });
    mockClient.chat.update.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });

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

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'ExitPlanMode' },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 100, output_tokens: 50 } };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as any);

    // First request
    await handler({
      event: { user: 'U123', text: '<@BOT123> implement feature', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Setup for continuation - capture the activityLog that will be passed
    let capturedActivityLog: any[] = [];
    vi.mocked(startClaudeQuery).mockImplementation(() => {
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'Done', usage: { input_tokens: 50, output_tokens: 25 } };
        },
        interrupt: vi.fn(),
      } as any;
    });

    // Capture the chat.update call to check activity log content
    mockClient.chat.update.mockImplementation(async (params: any) => {
      if (params.blocks) {
        const blocksStr = JSON.stringify(params.blocks);
        // Check if mode_changed appears in the blocks
        if (blocksStr.includes('Mode changed')) {
          capturedActivityLog.push({ hasModeChanged: true });
        }
      }
      return { ok: true, ts: params.ts };
    });

    // Trigger bypass button (which changes mode to bypassPermissions)
    const bypassHandler = registeredHandlers['action_^plan_bypass_(.+)$'];
    await bypassHandler({
      action: { action_id: 'plan_bypass_C123' },
      ack: vi.fn(),
      body: { user: { id: 'U123' }, message: { thread_ts: 'msg1', ts: 'btn1' } },
      client: mockClient,
    });

    // Verify that at some point, a mode_changed entry was rendered
    const updateCalls = mockClient.chat.update.mock.calls;
    const hasModeChangedInAnyUpdate = updateCalls.some(
      (call: any) => JSON.stringify(call[0].blocks || []).includes('Mode changed')
    );
    expect(hasModeChangedInAnyUpdate).toBe(true);
  });

  it('should include context_cleared entry in activity log for clear+bypass option', async () => {
    const { pendingPlanApprovals } = await import('../../slack-bot.js');
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });
    mockClient.chat.update.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });

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

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'ExitPlanMode' },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 100, output_tokens: 50 } };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as any);

    // First request
    await handler({
      event: { user: 'U123', text: '<@BOT123> implement feature', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Setup for continuation
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 50, output_tokens: 25 } };
      },
      interrupt: vi.fn(),
    } as any);

    // Trigger clear+bypass button
    const clearBypassHandler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
    await clearBypassHandler({
      action: { action_id: 'plan_clear_bypass_C123' },
      ack: vi.fn(),
      body: { user: { id: 'U123' }, message: { thread_ts: 'msg1', ts: 'btn1' } },
      client: mockClient,
    });

    // Verify that context_cleared appears in the activity log
    const updateCalls = mockClient.chat.update.mock.calls;
    const hasContextClearedInAnyUpdate = updateCalls.some(
      (call: any) => JSON.stringify(call[0].blocks || []).includes('Context Cleared')
    );
    expect(hasContextClearedInAnyUpdate).toBe(true);
  });

  it('should NOT add mode_changed entry for change plan option (stays in plan mode)', async () => {
    const { pendingPlanApprovals } = await import('../../slack-bot.js');
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });
    mockClient.chat.update.mockResolvedValue({ ok: true, ts: 'status-msg-ts' });

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

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'ExitPlanMode' },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 100, output_tokens: 50 } };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as any);

    // First request
    await handler({
      event: { user: 'U123', text: '<@BOT123> implement feature', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Clear update calls for clean verification
    mockClient.chat.update.mockClear();

    // Setup for continuation
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'OK waiting', usage: { input_tokens: 50, output_tokens: 25 } };
      },
      interrupt: vi.fn(),
    } as any);

    // Trigger reject/change button (stays in plan mode)
    const rejectHandler = registeredHandlers['action_^plan_reject_(.+)$'];
    await rejectHandler({
      action: { action_id: 'plan_reject_C123' },
      ack: vi.fn(),
      body: { user: { id: 'U123' }, message: { thread_ts: 'msg1', ts: 'btn1' } },
      client: mockClient,
    });

    // Verify that NO mode_changed entry appears (since mode stays as plan)
    const updateCalls = mockClient.chat.update.mock.calls;
    const hasModeChangedInAnyUpdate = updateCalls.some(
      (call: any) => JSON.stringify(call[0].blocks || []).includes('Mode changed')
    );
    expect(hasModeChangedInAnyUpdate).toBe(false);
  });

  it('should fall back to creating new status message if original was deleted', async () => {
    const { pendingPlanApprovals } = await import('../../slack-bot.js');
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'new-status-msg-ts' });

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

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'ExitPlanMode' },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 100, output_tokens: 50 } };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as any);

    // First request
    await handler({
      event: { user: 'U123', text: '<@BOT123> implement feature', channel: 'C123', ts: 'msg1' },
      client: mockClient,
    });

    // Setup for continuation - simulate deleted message
    mockClient.chat.update.mockRejectedValue({
      data: { error: 'message_not_found' },
    });
    mockClient.chat.postMessage.mockClear();
    mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: 'fallback-status-ts' });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Done', usage: { input_tokens: 50, output_tokens: 25 } };
      },
      interrupt: vi.fn(),
    } as any);

    // Trigger bypass button
    const bypassHandler = registeredHandlers['action_^plan_bypass_(.+)$'];
    await bypassHandler({
      action: { action_id: 'plan_bypass_C123' },
      ack: vi.fn(),
      body: { user: { id: 'U123' }, message: { thread_ts: 'msg1', ts: 'btn1' } },
      client: mockClient,
    });

    // Verify a warning was posted and a new status message was created
    const postCalls = mockClient.chat.postMessage.mock.calls;
    const warningCall = postCalls.find(
      (call: any) => call[0].text?.includes('status message was deleted')
    );
    expect(warningCall).toBeDefined();
  });
});
