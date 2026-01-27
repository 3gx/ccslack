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
      view(pattern: string | RegExp, handler: any) {
        const key = pattern instanceof RegExp ? pattern.source : pattern;
        registeredHandlers[`view_${key}`] = handler;
      }
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

vi.mock('../../streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({
    ts: 'upload-success-ts',
    uploadSucceeded: true,
  }),
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';
import { uploadMarkdownAndPngWithResponse } from '../../streaming.js';
import fs from 'fs';

// Will be populated dynamically after module import
let busyConversations: Set<string>;

describe('slack-bot button handlers', () => {
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
    const slackBot = await import('../../slack-bot.js');
    busyConversations = slackBot.busyConversations;
  });

  describe('SDK question abort button handler', () => {
    it('should open confirmation modal', async () => {
      const handler = registeredHandlers['action_^sdkq_abort_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_abort_q_sdk_123' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            callback_id: 'abort_confirmation_modal',
            type: 'modal',
          }),
        })
      );
    });

    it('should post ephemeral error when trigger_id is missing', async () => {
      const handler = registeredHandlers['action_^sdkq_abort_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_abort_q_sdk_123' },
        ack,
        body: {
          // No trigger_id
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).not.toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith({
        channel: 'C123',
        user: 'U456',
        text: ':warning: Failed to open abort confirmation. Please try again.',
      });
    });
  });

  describe('abort confirmation modal handler', () => {
    it('should register abort_confirmation_modal handler', async () => {
      const handler = registeredHandlers['view_abort_confirmation_modal'];
      expect(handler).toBeDefined();
    });

    it('should update message for SDK question abort type', async () => {
      const handler = registeredHandlers['view_abort_confirmation_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        ack,
        body: {},
        view: {
          callback_id: 'abort_confirmation_modal',
          private_metadata: JSON.stringify({
            abortType: 'sdk_question',
            key: 'sdk_q_456',
            channelId: 'C123',
            messageTs: 'msg789',
          }),
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // SDK question abort doesn't write to file, it resolves the pending promise
      // and updates the message - verify no file write for this type
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('abort query handler', () => {
    it('should register abort_query handler', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should acknowledge and open confirmation modal', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'abort_query_C123_thread456' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            callback_id: 'abort_confirmation_modal',
            type: 'modal',
          }),
        })
      );
    });
  });

  describe('mode button handler', () => {
    it('should register mode button handler', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      expect(handler).toBeDefined();
    });

    it('should save to main session when not in thread', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'mode_bypassPermissions' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'bypassPermissions' });
      expect(saveThreadSession).not.toHaveBeenCalled();
    });

    it('should save to thread session when in thread context', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'mode_plan' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123', thread_ts: '1234567890.123456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { mode: 'plan' });
      expect(saveSession).not.toHaveBeenCalled();
    });

    it('should update message to confirm selection', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'mode_plan' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: 'Mode set to `plan`',
        })
      );
    });
  });

  describe('model button handler', () => {
    it('should register model button handler', async () => {
      const handler = registeredHandlers['action_^model_select_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should save to main session when not in thread', async () => {
      const handler = registeredHandlers['action_^model_select_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'model_select_claude-opus-4-20250514' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { model: 'claude-opus-4-20250514' });
      expect(saveThreadSession).not.toHaveBeenCalled();
    });

    it('should save to thread session when in thread context', async () => {
      const handler = registeredHandlers['action_^model_select_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'model_select_claude-opus-4-20250514' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123', thread_ts: '1234567890.123456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { model: 'claude-opus-4-20250514' });
      expect(saveSession).not.toHaveBeenCalled();
    });
  });

  describe('plan approval button handlers - thread awareness', () => {
    it('plan_clear_bypass should save to main session when not in thread', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock getSession for handleMessage flow
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null,
      });

      await handler({
        action: { action_id: 'plan_clear_bypass_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { sessionId: null, mode: 'bypassPermissions', previousSessionIds: ['test-session'] });
      expect(saveThreadSession).not.toHaveBeenCalled();
    });

    it('plan_clear_bypass should save to thread session when in thread', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null,
      });

      await handler({
        action: { action_id: 'plan_clear_bypass_C123_1234567890.123456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { sessionId: null, mode: 'bypassPermissions', previousSessionIds: [] });
      expect(saveSession).not.toHaveBeenCalledWith('C123', { sessionId: null, mode: 'bypassPermissions', previousSessionIds: [] });
    });

    it('plan_accept_edits should save to thread session when in thread', async () => {
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null,
      });

      await handler({
        action: { action_id: 'plan_accept_edits_C123_1234567890.123456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { mode: 'acceptEdits' });
      expect(saveSession).not.toHaveBeenCalledWith('C123', { mode: 'acceptEdits' });
    });

    it('plan_bypass should save to thread session when in thread', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null,
      });

      await handler({
        action: { action_id: 'plan_bypass_C123_1234567890.123456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { mode: 'bypassPermissions' });
      expect(saveSession).not.toHaveBeenCalledWith('C123', { mode: 'bypassPermissions' });
    });

    it('plan_manual should save to thread session when in thread', async () => {
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: null,
      });

      await handler({
        action: { action_id: 'plan_manual_C123_1234567890.123456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { mode: 'default' });
      expect(saveSession).not.toHaveBeenCalledWith('C123', { mode: 'default' });
    });
  });

  describe('ack() failure resilience', () => {
    it('should still try to open modal when abort_query ack() throws', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('Slack API error'));

      // Handler should not throw when ack fails
      await handler({
        action: { action_id: 'abort_query_C123_thread456' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Handler should still try to open the modal
      expect(mockClient.views.open).toHaveBeenCalled();
    });
  });

  describe('retry_upload button handler', () => {
    it('should show ephemeral error that activity logs are not persisted', async () => {
      const handler = registeredHandlers['action_^retry_upload_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'retry_upload_status-ts-123',
        },
        ack,
        body: { channel: { id: 'C123' }, user: { id: 'U789' } },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          user: 'U789',
          text: expect.stringContaining('no longer available'),
        })
      );
      // Should NOT attempt upload since activity logs are not persisted
      expect(uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();
    });
  });
});
