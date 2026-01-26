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
      view(pattern: RegExp | string, handler: any) {
        const key = typeof pattern === 'string' ? pattern : pattern.source;
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

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getThreadSession, saveThreadSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('emoji-indicators integration tests', () => {
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

  describe('plan approval emoji handling', () => {
    it('option 1 (clear+bypass): should remove :question: and :eyes: emojis', async () => {
      const { pendingPlanApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Set up pending plan approval with originalTs
      pendingPlanApprovals.set('C123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
        statusMsgTs: 'status-123',
        activityLog: [],
      });

      await handler({
        action: { action_id: 'plan_clear_bypass_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'approval-msg-123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should remove both :question: and :eyes: emojis
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'question',
        })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'eyes',
        })
      );
    });

    it('option 2 (accept edits): should remove :question: and :eyes: emojis', async () => {
      const { pendingPlanApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      pendingPlanApprovals.set('C123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
        statusMsgTs: 'status-123',
        activityLog: [],
      });

      await handler({
        action: { action_id: 'plan_accept_edits_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'approval-msg-123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
    });

    it('option 3 (bypass): should remove :question: and :eyes: emojis', async () => {
      const { pendingPlanApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      pendingPlanApprovals.set('C123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
        statusMsgTs: 'status-123',
        activityLog: [],
      });

      await handler({
        action: { action_id: 'plan_bypass_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'approval-msg-123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
    });

    it('option 4 (manual): should remove :question: and :eyes: emojis', async () => {
      const { pendingPlanApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      pendingPlanApprovals.set('C123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
        statusMsgTs: 'status-123',
        activityLog: [],
      });

      await handler({
        action: { action_id: 'plan_manual_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'approval-msg-123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
    });

    it('option 5 (reject): should remove :question: and :eyes: emojis', async () => {
      const { pendingPlanApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      pendingPlanApprovals.set('C123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
        statusMsgTs: 'status-123',
        activityLog: [],
      });

      await handler({
        action: { action_id: 'plan_reject_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'approval-msg-123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
    });
  });

  describe('tool approval emoji handling', () => {
    it('should remove :question: emoji on tool approve', async () => {
      const { pendingToolApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      // Set up pending tool approval with originalTs
      pendingToolApprovals.set('approval-123', {
        toolName: 'Edit',
        toolInput: { file_path: '/test.ts' },
        resolve: resolvePromise,
        messageTs: 'tool-msg-123',
        channelId: 'C123',
        threadTs: 'thread-123',
        originalTs: 'user-msg-123',
      });

      await handler({
        action: { action_id: 'tool_approve_approval-123' },
        ack,
        body: {},
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'question',
        })
      );
      expect(resolvePromise).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'allow' })
      );
    });

    it('should remove :question: emoji on tool deny', async () => {
      const { pendingToolApprovals } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      pendingToolApprovals.set('approval-456', {
        toolName: 'Edit',
        toolInput: { file_path: '/test.ts' },
        resolve: resolvePromise,
        messageTs: 'tool-msg-456',
        channelId: 'C123',
        threadTs: 'thread-123',
        originalTs: 'user-msg-456',
      });

      await handler({
        action: { action_id: 'tool_deny_approval-456' },
        ack,
        body: {},
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-456',
          name: 'question',
        })
      );
      expect(resolvePromise).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'deny' })
      );
    });
  });

  describe('SDK question emoji handling', () => {
    it('should remove :question: emoji on SDK question answer', async () => {
      const { pendingSdkQuestions } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^sdkq_(.+)_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      // Set up pending SDK question with originalTs
      pendingSdkQuestions.set('sdkq-123', {
        resolve: resolvePromise,
        messageTs: 'question-msg-123',
        channelId: 'C123',
        threadTs: 'thread-123',
        question: 'Which option?',
        originalTs: 'user-msg-123',
      });

      await handler({
        action: { action_id: 'sdkq_sdkq-123_0', value: 'Option A' },
        ack,
        body: {},
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'question',
        })
      );
      expect(resolvePromise).toHaveBeenCalledWith('Option A');
    });
  });

  describe('SDK question ABORT emoji handling', () => {
    it('should remove :question: and add :octagonal_sign: when SDK question is aborted', async () => {
      const { pendingSdkQuestions } = await import('../../slack-bot.js');
      const modalHandler = registeredHandlers['view_abort_confirmation_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      pendingSdkQuestions.set('sdkq-abort-123', {
        resolve: resolvePromise,
        messageTs: 'question-msg-123',
        channelId: 'C123',
        threadTs: 'thread-123',
        question: 'Which option do you want?',
        originalTs: 'user-msg-123',
      });

      await modalHandler({
        ack,
        view: {
          private_metadata: JSON.stringify({
            abortType: 'sdk_question',
            key: 'sdkq-abort-123',
            channelId: 'C123',
            messageTs: 'question-msg-123',
          }),
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'question',
        })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'octagonal_sign',
        })
      );
      expect(resolvePromise).toHaveBeenCalledWith('__ABORTED__');
    });

    it('should handle abort gracefully when originalTs is undefined', async () => {
      const { pendingSdkQuestions } = await import('../../slack-bot.js');
      const modalHandler = registeredHandlers['view_abort_confirmation_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      pendingSdkQuestions.set('sdkq-no-original-456', {
        resolve: resolvePromise,
        messageTs: 'question-msg-456',
        channelId: 'C123',
        threadTs: undefined,
        question: 'Select an option',
        // originalTs is undefined
      });

      await modalHandler({
        ack,
        view: {
          private_metadata: JSON.stringify({
            abortType: 'sdk_question',
            key: 'sdkq-no-original-456',
            channelId: 'C123',
            messageTs: 'question-msg-456',
          }),
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).not.toHaveBeenCalled();
      expect(mockClient.reactions.add).not.toHaveBeenCalled();
      expect(resolvePromise).toHaveBeenCalledWith('__ABORTED__');
    });

    it('should update question message to show aborted status', async () => {
      const { pendingSdkQuestions } = await import('../../slack-bot.js');
      const modalHandler = registeredHandlers['view_abort_confirmation_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      pendingSdkQuestions.set('sdkq-abort-789', {
        resolve: resolvePromise,
        messageTs: 'question-msg-789',
        channelId: 'C123',
        threadTs: 'thread-123',
        question: 'Do you want to proceed?',
        originalTs: 'user-msg-789',
      });

      await modalHandler({
        ack,
        view: {
          private_metadata: JSON.stringify({
            abortType: 'sdk_question',
            key: 'sdkq-abort-789',
            channelId: 'C123',
            messageTs: 'question-msg-789',
          }),
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'question-msg-789',
          text: 'Question aborted',
        })
      );
    });

    it('should clean up pending question entry from map', async () => {
      const { pendingSdkQuestions, pendingSdkMultiSelections } = await import('../../slack-bot.js');
      const modalHandler = registeredHandlers['view_abort_confirmation_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const resolvePromise = vi.fn();

      pendingSdkQuestions.set('sdkq-cleanup-999', {
        resolve: resolvePromise,
        messageTs: 'question-msg-999',
        channelId: 'C123',
        threadTs: undefined,
        question: 'Multiple choice?',
        originalTs: 'user-msg-999',
      });
      pendingSdkMultiSelections.set('sdkq-cleanup-999', ['option1', 'option2']);

      await modalHandler({
        ack,
        view: {
          private_metadata: JSON.stringify({
            abortType: 'sdk_question',
            key: 'sdkq-cleanup-999',
            channelId: 'C123',
            messageTs: 'question-msg-999',
          }),
        },
        client: mockClient,
      });

      expect(pendingSdkQuestions.has('sdkq-cleanup-999')).toBe(false);
      expect(pendingSdkMultiSelections.has('sdkq-cleanup-999')).toBe(false);
    });
  });

  describe('mode picker emoji handling', () => {
    it('mode button click: removes both :question: and :eyes:', async () => {
      const { pendingModeSelections } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Set up pending mode selection with originalTs
      pendingModeSelections.set('picker-msg-123', {
        originalTs: 'user-msg-123',
        channelId: 'C123',
        threadTs: undefined,
      });

      await handler({
        action: { action_id: 'mode_plan' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'picker-msg-123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should remove both :question: and :eyes: emojis
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'question',
        })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-123',
          name: 'eyes',
        })
      );
      // Verify pending entry is cleaned up
      expect(pendingModeSelections.has('picker-msg-123')).toBe(false);
    });

    it('mode button click in thread: handles thread-aware emoji cleanup', async () => {
      const { pendingModeSelections } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Set up pending mode selection with thread context
      pendingModeSelections.set('picker-msg-456', {
        originalTs: 'user-msg-456',
        channelId: 'C123',
        threadTs: 'thread-123',
      });

      await handler({
        action: { action_id: 'mode_bypassPermissions' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'picker-msg-456', thread_ts: 'thread-123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-456',
          name: 'question',
        })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-456',
          name: 'eyes',
        })
      );
    });
  });

  describe('model picker emoji handling', () => {
    it('model button click: removes both :question: and :eyes:', async () => {
      const { pendingModelSelections } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^model_select_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Set up pending model selection with originalTs
      pendingModelSelections.set('picker-msg-789', {
        originalTs: 'user-msg-789',
        channelId: 'C123',
        threadTs: undefined,
      });

      await handler({
        action: { action_id: 'model_select_claude-sonnet-4-20250514' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'picker-msg-789' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should remove both :question: and :eyes: emojis
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-789',
          name: 'question',
        })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-789',
          name: 'eyes',
        })
      );
      // Verify pending entry is cleaned up
      expect(pendingModelSelections.has('picker-msg-789')).toBe(false);
    });

    it('model button click in thread: handles thread-aware emoji cleanup', async () => {
      const { pendingModelSelections } = await import('../../slack-bot.js');
      const handler = registeredHandlers['action_^model_select_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Set up pending model selection with thread context
      pendingModelSelections.set('picker-msg-999', {
        originalTs: 'user-msg-999',
        channelId: 'C123',
        threadTs: 'thread-456',
      });

      await handler({
        action: { action_id: 'model_select_claude-opus-4-20250514' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'picker-msg-999', thread_ts: 'thread-456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-999',
          name: 'question',
        })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          timestamp: 'user-msg-999',
          name: 'eyes',
        })
      );
    });
  });
});
