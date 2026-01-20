import { describe, it, expect, vi, beforeEach } from 'vitest';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// vi.mock calls must be at module level - Vitest hoists these
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
      message(handler: any) { registeredHandlers['message'] = handler; }
      action(pattern: RegExp | string, handler: any) {
        const key = typeof pattern === 'string' ? pattern : pattern.source;
        registeredHandlers[`action_${key}`] = handler;
      }
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
import { getSession, saveThreadSession, findForkPointMessageId } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('slack-bot /fork-message command', () => {
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

  describe('/fork-message command', () => {
    it('should reject /fork-message used outside of a thread', async () => {
      const handler = registeredHandlers['event_app_mention'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-message https://slack.com/archives/C123/p1705123456789012 test fork',
          channel: 'C123',
          ts: '1111111111.111111',
          // No thread_ts - main channel message
        },
        client: mockClient,
      });

      // Should post error message about being outside thread
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('/fork-message') && call[0].text?.includes('thread')
      );
      expect(errorCall).toBeDefined();
      expect(errorCall[0].text).toContain('can only be used inside a thread');
    });

    it('should reject /fork-message with invalid link', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-message https://google.com/not-a-slack-link test',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should post error about invalid link
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Invalid message link')
      );
      expect(errorCall).toBeDefined();
    });

    it('should reject /fork-message when message not found in messageMap', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // No message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue(null);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-message https://slack.com/archives/C123/p1705123456789012 test fork',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should post error about message not found
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('not found in conversation history')
      );
      expect(errorCall).toBeDefined();
    });

    it('should create point-in-time fork when message found in messageMap', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';
      const forkPointTs = '1705123456.789012';
      const forkPointMessageId = 'msg_017test';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: forkPointMessageId,
        sessionId: 'main-session',
      });

      // Mock postMessage to return a ts for the anchor
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'new-thread-123', channel: 'C123' });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-message https://slack.com/archives/C123/p1705123456789012 my test fork',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should create fork anchor in main channel
      const anchorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked') && !call[0].thread_ts
      );
      expect(anchorCall).toBeDefined();

      // Should save thread session with resumeSessionAtMessageId
      expect(saveThreadSession).toHaveBeenCalledWith(
        'C123',
        'new-thread-123',
        expect.objectContaining({
          sessionId: null,
          forkedFrom: 'main-session',
          resumeSessionAtMessageId: forkPointMessageId,
        })
      );

      // Should post notification in source thread
      const notificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts === threadTs && call[0].text?.includes('Point-in-time fork created')
      );
      expect(notificationCall).toBeDefined();
    });

    it('should show usage help when /fork-message called without arguments', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-message',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should show usage help
      const helpCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Usage:') && call[0].text?.includes('/fork-message')
      );
      expect(helpCall).toBeDefined();
    });
  });
});

describe('slack-bot fork_here button handler', () => {
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

  describe('fork_here button click', () => {
    it('should register fork_here action handler', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should create point-in-time fork when button clicked', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const conversationKey = 'C123_1000000000.000000';
      const messageTs = '1111111111.111111';
      const threadTs = '1000000000.000000';
      const forkPointMessageId = 'msg_017button';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: forkPointMessageId,
        sessionId: 'main-session',
      });

      // Mock postMessage to return a ts for the anchor
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'new-thread-456', channel: 'C123' });

      await handler({
        action: {
          action_id: `fork_here_${conversationKey}`,
          value: JSON.stringify({ messageTs, threadTs }),
        },
        ack,
        body: {
          user: { id: 'U123' },
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should look up message in messageMap
      expect(findForkPointMessageId).toHaveBeenCalledWith('C123', messageTs);

      // Should create fork anchor in main channel
      const anchorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked') && !call[0].thread_ts
      );
      expect(anchorCall).toBeDefined();

      // Should save thread session with resumeSessionAtMessageId
      expect(saveThreadSession).toHaveBeenCalledWith(
        'C123',
        'new-thread-456',
        expect.objectContaining({
          sessionId: null,
          forkedFrom: 'main-session',
          resumeSessionAtMessageId: forkPointMessageId,
        })
      );
    });

    it('should post error when message not found in messageMap', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const conversationKey = 'C123_1000000000.000000';
      const messageTs = '1111111111.111111';
      const threadTs = '1000000000.000000';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // No message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue(null);

      await handler({
        action: {
          action_id: `fork_here_${conversationKey}`,
          value: JSON.stringify({ messageTs, threadTs }),
        },
        ack,
        body: {
          user: { id: 'U123' },
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should post error in thread
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('not found') && call[0].thread_ts === threadTs
      );
      expect(errorCall).toBeDefined();
    });

    it('should handle invalid JSON in action value gracefully', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const conversationKey = 'C123_1000000000.000000';

      // Should not throw - just log and return
      await handler({
        action: {
          action_id: `fork_here_${conversationKey}`,
          value: 'not-valid-json',
        },
        ack,
        body: {
          user: { id: 'U123' },
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not create any fork
      expect(saveThreadSession).not.toHaveBeenCalled();
    });

    it('should handle missing messageTs/threadTs in forkInfo gracefully', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const conversationKey = 'C123_1000000000.000000';

      await handler({
        action: {
          action_id: `fork_here_${conversationKey}`,
          value: JSON.stringify({ messageTs: '123' }), // Missing threadTs
        },
        ack,
        body: {
          user: { id: 'U123' },
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not create any fork
      expect(saveThreadSession).not.toHaveBeenCalled();
    });
  });
});
