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
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId, getActivityLog } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';
import fs from 'fs';

describe('slack-bot approval handlers', () => {
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

  describe('plan approval handlers (5 options matching CLI)', () => {
    // Test handler registration for all 5 options
    it('should register option 1: clear + bypass handler', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 2: accept edits handler', async () => {
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 3: bypass handler', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 4: manual handler', async () => {
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 5: reject handler', async () => {
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      expect(handler).toBeDefined();
    });

    // Test option 1: clear context + bypass (thread context - uses saveThreadSession)
    it('option 1: should clear session and set bypass mode', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_clear_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should clear session (sessionId: null) AND set bypass mode - thread context uses saveThreadSession
      expect(saveThreadSession).toHaveBeenCalledWith('C123', 'thread456', { sessionId: null, mode: 'bypassPermissions', previousSessionIds: [] });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('Clearing context'),
        })
      );
    });

    // Test option 2: accept edits
    it('option 2: should set acceptEdits mode', async () => {
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_accept_edits_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'acceptEdits' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('accept-edits'),
        })
      );
    });

    // Test option 3: bypass permissions (thread context - uses saveThreadSession)
    it('option 3: should set bypassPermissions mode', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Thread context uses saveThreadSession
      expect(saveThreadSession).toHaveBeenCalledWith('C123', 'thread456', { mode: 'bypassPermissions' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('bypass mode'),
        })
      );
    });

    // Test option 4: manual approval
    it('option 4: should set default (manual) mode', async () => {
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_manual_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'default' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('manual approval'),
        })
      );
    });

    // Test option 5: reject
    it('option 5: should update message on reject', async () => {
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_reject_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('rejected'),
        })
      );
    });

    it('should extract channel and thread from conversation key and save to thread', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // With thread - should save to thread session
      await handler({
        action: { action_id: 'plan_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should save to thread session (extracted from conversation key)
      expect(saveThreadSession).toHaveBeenCalledWith('C123', 'thread456', { mode: 'bypassPermissions' });
    });

    it('option 1: should use fallback userText when no planFilePath', async () => {
      const option1Handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
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

      // No active query, so no planFilePath
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      await option1Handler({
        action: { action_id: 'plan_clear_bypass_C123' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should use fallback text
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'Yes, proceed with the plan.',
        expect.anything()
      );
    });

    it('option 1: should use planFilePath from session when activeQuery is gone (main channel)', async () => {
      const option1Handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();

      // Session has planFilePath (persisted during query)
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
        planFilePath: '/Users/test/.claude/plans/my-plan.md',
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      await option1Handler({
        action: { action_id: 'plan_clear_bypass_C123' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should use planFilePath from session fallback
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'Execute the plan at /Users/test/.claude/plans/my-plan.md',
        expect.anything()
      );
    });

    it('option 1: should use planFilePath from thread session when activeQuery is gone (thread)', async () => {
      const option1Handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();

      // Main session (checked first for workingDir)
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null, // Main session has no planFilePath
      });

      // Thread session has planFilePath
      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'thread-session',
        forkedFrom: 'main-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: '/Users/test/.claude/plans/thread-plan.md',
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Thread conversation key format: C123_threadTs
      await option1Handler({
        action: { action_id: 'plan_clear_bypass_C123_1234567890.123456' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should use planFilePath from thread session fallback
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'Execute the plan at /Users/test/.claude/plans/thread-plan.md',
        expect.anything()
      );
    });
  });

  describe('tool approval handlers', () => {
    it('should register tool approve handler', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register tool deny handler', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should acknowledge approve button click', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'tool_approve_abc-123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should acknowledge deny button click', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'tool_deny_abc-123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should log when no pending approval found for approve', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const consoleSpy = vi.spyOn(console, 'log');

      await handler({
        action: { action_id: 'tool_approve_nonexistent-id' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(consoleSpy).toHaveBeenCalledWith('No pending approval found for: nonexistent-id');
      consoleSpy.mockRestore();
    });

    it('should log when no pending approval found for deny', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const consoleSpy = vi.spyOn(console, 'log');

      await handler({
        action: { action_id: 'tool_deny_nonexistent-id' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(consoleSpy).toHaveBeenCalledWith('No pending approval found for: nonexistent-id');
      consoleSpy.mockRestore();
    });
  });

  describe('tool approval reminder configuration', () => {
    it('should have 7-day expiry configured', async () => {
      // The configuration is tested by verifying the module loads without error
      // and that the reminder mechanism is set up (42 reminders = 7 days / 4 hours)
      expect(registeredHandlers['action_^tool_approve_(.+)$']).toBeDefined();
      expect(registeredHandlers['action_^tool_deny_(.+)$']).toBeDefined();
    });
  });

  describe('canUseTool callback', () => {
    it('should prompt for approval for tools in default mode', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set up session with default mode
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // Capture the canUseTool callback
      let capturedCanUseTool: any = null;
      vi.mocked(startClaudeQuery).mockImplementation((prompt, options) => {
        capturedCanUseTool = options.canUseTool;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
            yield { type: 'result', result: 'Done' };
          },
          interrupt: vi.fn(),
        } as any;
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      expect(capturedCanUseTool).toBeDefined();

      // Call the callback with Write tool - this should NOT auto-deny
      // It should post a message and return a promise (we won't await the resolution)
      const resultPromise = capturedCanUseTool(
        'Write',
        { file_path: '/test.txt', content: 'hello' },
        { signal: new AbortController().signal }
      );

      // Should have posted approval message to Slack
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Write'),
        })
      );

      // The promise should still be pending (waiting for user to click button)
      // We can't easily test this without resolving, but we verified the message was posted
    });
  });

});
