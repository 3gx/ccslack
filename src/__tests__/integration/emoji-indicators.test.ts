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
});
