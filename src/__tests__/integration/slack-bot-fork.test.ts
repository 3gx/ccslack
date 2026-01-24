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

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId, getActivityLog } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';
import fs from 'fs';

describe('slack-bot fork handlers', () => {
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

  describe('concurrent session handlers', () => {
    it('should cancel and remove pending message on cancel click', async () => {
      const handler = registeredHandlers['action_^concurrent_cancel_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'concurrent_cancel_sess-123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
        })
      );
    });

    it('should proceed with message on proceed click', async () => {
      const handler = registeredHandlers['action_^concurrent_proceed_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'concurrent_proceed_sess-456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalled();
    });
  });

  describe('Fork here button handler (opens modal)', () => {
    it('should open modal with trigger_id on button click', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';
      const triggerId = 'trigger_123abc';

      await handler({
        action: {
          action_id: 'fork_here_C123',
          value: JSON.stringify({}),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
          trigger_id: triggerId,
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should open modal (not create fork directly)
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: triggerId,
          view: expect.objectContaining({
            type: 'modal',
            callback_id: 'fork_to_channel_modal',
          }),
        })
      );
    });

    it('should include threadTs in modal metadata when forking from thread', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const threadTs = '1000000000.000000';
      const messageTs = '1000000100.000000';

      await handler({
        action: {
          action_id: `fork_here_C123_${threadTs}`,
          value: JSON.stringify({ threadTs }),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
          trigger_id: 'trigger_456',
        },
        client: mockClient,
      });

      expect(mockClient.views.open).toHaveBeenCalled();
      const viewCall = mockClient.views.open.mock.calls[0][0];
      const metadata = JSON.parse(viewCall.view.private_metadata);

      expect(metadata.sourceChannelId).toBe('C123');
      expect(metadata.sourceMessageTs).toBe(messageTs);
      expect(metadata.conversationKey).toBe(`C123_${threadTs}`);
      expect(metadata.threadTs).toBe(threadTs);
    });

    it('should not include threadTs for main channel forks', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';

      await handler({
        action: {
          action_id: 'fork_here_C123',
          value: JSON.stringify({}),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
          trigger_id: 'trigger_789',
        },
        client: mockClient,
      });

      const viewCall = mockClient.views.open.mock.calls[0][0];
      const metadata = JSON.parse(viewCall.view.private_metadata);

      expect(metadata.sourceChannelId).toBe('C123');
      expect(metadata.conversationKey).toBe('C123');
      expect(metadata.threadTs).toBeUndefined();
    });
  });
});
