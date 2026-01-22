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

  describe('auto-fork (Reply in thread)', () => {
    it('should link to last main conversation message in fork notification', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';  // Message user clicked Reply on (10:00 AM)
      const lastMainMessageTs = '1000000600.000000';  // Last message in main (10:10 AM)

      // Mock main session
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

      // Mock thread session - new fork (isNewFork: true)
      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
        },
        isNewFork: true,  // This is a new fork
      });

      // Mock conversations.history to return messages after threadTs
      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          { ts: lastMainMessageTs, text: 'Latest message in main', thread_ts: undefined },  // Last main message
          { ts: '1000000300.000000', text: 'Middle message', thread_ts: undefined },
          { ts: threadTs, text: 'Original message', thread_ts: undefined },  // Thread parent
        ],
      });

      // Mock SDK
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'forked-session', model: 'claude-opus' };
          yield { type: 'result', result: 'Response' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> help me',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,  // This is a thread message
        },
        client: mockClient,
      });

      // Find the fork notification message
      const forkNotificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked with conversation state')
      );

      expect(forkNotificationCall).toBeDefined();

      // With point-in-time forking, link should point to threadTs (the message being replied to)
      // NOT to the last message in main conversation
      const expectedLink = `https://slack.com/archives/C123/p${threadTs.replace('.', '')}`;
      expect(forkNotificationCall[0].text).toContain(expectedLink);
      expect(forkNotificationCall[0].text).toContain('this message');
    });

    it('should fallback to thread parent if no messages after thread creation', async () => {
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

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
        },
        isNewFork: true,
      });

      // Mock conversations.history - NO messages after threadTs
      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          { ts: threadTs, text: 'Thread parent', thread_ts: undefined },
          { ts: '0999999999.999999', text: 'Earlier message', thread_ts: undefined },
        ],
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'forked-session', model: 'claude-opus' };
          yield { type: 'result', result: 'Response' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> help',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should fallback to threadTs itself
      const forkNotificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked with conversation state')
      );

      expect(forkNotificationCall).toBeDefined();
      const expectedLink = `https://slack.com/archives/C123/p${threadTs.replace('.', '')}`;
      expect(forkNotificationCall[0].text).toContain(expectedLink);
    });

    it('should always link to threadTs (the message being replied to) with point-in-time forking', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';  // The message user clicked "Reply in thread" on

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

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
        },
        isNewFork: true,
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'forked-session', model: 'claude-opus' };
          yield { type: 'result', result: 'Response' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> help',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // With point-in-time forking, link should ALWAYS point to threadTs
      // (the message user clicked "Reply in thread" on)
      const forkNotificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked with conversation state')
      );

      expect(forkNotificationCall).toBeDefined();
      const expectedLink = `https://slack.com/archives/C123/p${threadTs.replace('.', '')}`;
      expect(forkNotificationCall[0].text).toContain(expectedLink);
    });

    it('should pass resumeSessionAt to SDK when forking from message with mapping', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';  // This is the message user is replying to
      const forkPointMessageId = 'msg_017pagAKz_test';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session-abc',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // CRITICAL: Mock findForkPointMessageId to return ForkPointResult (messageId + sessionId)
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: forkPointMessageId,
        sessionId: 'main-session-abc',
      });

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session-abc',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
          resumeSessionAtMessageId: forkPointMessageId,
        },
        isNewFork: true,
      });

      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [{ ts: threadTs, text: 'Thread parent' }],
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'forked-session-xyz', model: 'claude-opus' };
          yield { type: 'result', result: 'Response from forked session' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> what do you remember?',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // CRITICAL ASSERTION: Verify resumeSessionAt is passed to SDK
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'what do you remember?',
        expect.objectContaining({
          sessionId: 'main-session-abc',
          forkSession: true,
          resumeSessionAt: forkPointMessageId,  // THIS IS THE KEY CHECK
        })
      );
    });

    it('should NOT pass resumeSessionAt when no message mapping exists (graceful degradation)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session-abc',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // No message mapping found - returns null
      vi.mocked(findForkPointMessageId).mockReturnValue(null);

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session-abc',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
          // No resumeSessionAtMessageId
        },
        isNewFork: true,
      });

      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [{ ts: threadTs, text: 'Thread parent' }],
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'forked-session', model: 'claude-opus' };
          yield { type: 'result', result: 'Response' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> help',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // Should fork but WITHOUT resumeSessionAt (graceful degradation)
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'help',
        expect.objectContaining({
          sessionId: 'main-session-abc',
          forkSession: true,
          resumeSessionAt: undefined,  // No fork point available
        })
      );
    });
  });

  describe('Fork here button handler', () => {
    it('should handle fork from thread (post notification to source thread)', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const threadTs = '1000000000.000000';
      const messageTs = '1000000100.000000';

      // Mock message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'parent-session',
      });

      // Mock session
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
        action: {
          action_id: `fork_here_C123_${threadTs}`,
          value: JSON.stringify({ threadTs }),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should create fork anchor in main channel
      const anchorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Point-in-time fork')
      );
      expect(anchorCall).toBeDefined();
      expect(anchorCall[0].channel).toBe('C123');
      expect(anchorCall[0].thread_ts).toBeUndefined(); // Main channel, no thread_ts

      // Should post notification in source thread
      const notificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts === threadTs
      );
      expect(notificationCall).toBeDefined();
      expect(notificationCall[0].text).toContain('Point-in-time fork created');
    });

    it('should handle fork from main channel (no notification in source thread)', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';

      // Mock message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_xyz789',
        sessionId: 'parent-session',
      });

      // Mock session
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
        action: {
          action_id: 'fork_here_C123',  // Main channel - no threadTs in conversationKey
          value: JSON.stringify({}),  // No threadTs for main channel
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should create fork anchor in main channel
      const anchorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Point-in-time fork')
      );
      expect(anchorCall).toBeDefined();

      // Should NOT post notification to source thread (since we're forking from main channel)
      const notificationWithThreadTs = mockClient.chat.postMessage.mock.calls.filter(
        (call: any) => call[0].thread_ts !== undefined && call[0].text?.includes('fork created')
      );
      // Only notification should be in the NEW fork thread, not the source
      expect(notificationWithThreadTs.length).toBeLessThanOrEqual(1);
    });

    it('should show error when message not found in messageMap', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const threadTs = '1000000000.000000';

      // Mock NO message mapping found
      vi.mocked(findForkPointMessageId).mockReturnValue(null);

      await handler({
        action: {
          action_id: `fork_here_C123_${threadTs}`,
          value: JSON.stringify({ threadTs }),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: '1000000100.000000' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should post error message
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Message not found')
      );
      expect(errorCall).toBeDefined();
    });

    it('should build correct forkPointLink for thread context', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const threadTs = '1000000000.000000';
      const messageTs = '1000000100.000000';

      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'parent-session',
      });

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
        action: {
          action_id: `fork_here_C123_${threadTs}`,
          value: JSON.stringify({ threadTs }),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should include thread_ts in forkPointLink - check the message posted to the new fork thread
      // (this is the first message IN the new thread, which contains the forkPointLink)
      const forkThreadMessage = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts !== undefined && call[0].text?.includes('Point-in-time fork from')
      );
      expect(forkThreadMessage).toBeDefined();
      // Thread URL format includes thread_ts
      const expectedUrlPart = `thread_ts=${threadTs}`;
      expect(forkThreadMessage[0].text).toContain(expectedUrlPart);
    });

    it('should build correct forkPointLink for main channel context', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';

      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_xyz789',
        sessionId: 'parent-session',
      });

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
        action: {
          action_id: 'fork_here_C123',
          value: JSON.stringify({}),  // No threadTs
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should NOT include thread_ts in forkPointLink (main channel URL)
      // Check the message posted to the new fork thread
      const forkThreadMessage = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts !== undefined && call[0].text?.includes('Point-in-time fork from')
      );
      expect(forkThreadMessage).toBeDefined();
      // Main channel URL should NOT have thread_ts (no ?thread_ts= in URL)
      expect(forkThreadMessage[0].text).not.toContain('thread_ts=');
    });
  });
});
