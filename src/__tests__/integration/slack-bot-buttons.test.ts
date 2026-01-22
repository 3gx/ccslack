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
    await import('../../slack-bot.js');
  });

  describe('button answer handler', () => {
    it('should write answer to file and update message', async () => {
      const handler = registeredHandlers['action_^answer_(.+)_(\\d+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'answer_q_123456_0',
          value: 'yes',
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_123456.json',
        expect.stringContaining('"answer":"yes"')
      );
      expect(mockClient.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: 'msg123',
        text: 'You selected: *yes*',
        blocks: [],
      });
    });
  });

  describe('abort button handler', () => {
    it('should write abort signal to file', async () => {
      const handler = registeredHandlers['action_^abort_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'abort_q_789' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_789.json',
        expect.stringContaining('__ABORTED__')
      );
    });
  });

  describe('freetext button handler', () => {
    it('should open modal for free text input', async () => {
      const handler = registeredHandlers['action_^freetext_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'freetext_q_456' },
        ack,
        body: {
          trigger_id: 'trigger123',
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            callback_id: 'freetext_modal_q_456',
            type: 'modal',
          }),
        })
      );
    });
  });

  describe('modal submission handler', () => {
    it('should write free text answer to file', async () => {
      const handler = registeredHandlers['view_^freetext_modal_(.+)$'];
      expect(handler).toBeDefined();

      const ack = vi.fn();

      await handler({
        ack,
        body: {},
        view: {
          callback_id: 'freetext_modal_q_789',
          state: {
            values: {
              answer_block: {
                answer_input: {
                  value: 'My custom answer',
                },
              },
            },
          },
        },
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_789.json',
        expect.stringContaining('"answer":"My custom answer"')
      );
    });
  });

  describe('multiselect handlers', () => {
    it('should store pending selections on multiselect change', async () => {
      const handler = registeredHandlers['action_^multiselect_(?!submit_)(.+)$'];
      expect(handler).toBeDefined();

      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'multiselect_q_multi_123',
          selected_options: [
            { value: 'Option A' },
            { value: 'Option C' },
          ],
        },
        ack,
        body: {},
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
      // Selection should be stored internally (tested via submit)
    });

    it('should submit multiselect answer to file', async () => {
      // First, simulate selection change
      const selectHandler = registeredHandlers['action_^multiselect_(?!submit_)(.+)$'];
      const submitHandler = registeredHandlers['action_^multiselect_submit_(.+)$'];
      expect(selectHandler).toBeDefined();
      expect(submitHandler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Simulate selection
      await selectHandler({
        action: {
          action_id: 'multiselect_q_submit_test',
          selected_options: [
            { value: 'Python' },
            { value: 'Go' },
          ],
        },
        ack,
        body: {},
        client: mockClient,
      });

      // Simulate submit
      await submitHandler({
        action: { action_id: 'multiselect_submit_q_submit_test' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalledTimes(2);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_submit_test.json',
        expect.stringContaining('Python, Go')
      );
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'You selected: *Python, Go*',
        })
      );
    });

    it('should handle empty multiselect submission', async () => {
      const submitHandler = registeredHandlers['action_^multiselect_submit_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Submit without prior selection
      await submitHandler({
        action: { action_id: 'multiselect_submit_q_empty' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'You selected: *(none)*',
        })
      );
    });
  });

  describe('abort query handler', () => {
    it('should register abort_query handler', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should acknowledge and log abort request', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'abort_query_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
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
      expect(saveSession).toHaveBeenCalledWith('C123', { sessionId: null, mode: 'bypassPermissions' });
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
      expect(saveThreadSession).toHaveBeenCalledWith('C123', '1234567890.123456', { sessionId: null, mode: 'bypassPermissions' });
      expect(saveSession).not.toHaveBeenCalledWith('C123', { sessionId: null, mode: 'bypassPermissions' });
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
});
