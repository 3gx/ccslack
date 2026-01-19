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

  describe('thread-to-thread forking (/fork-thread)', () => {
    it('should include link to fork command message in new thread message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const sourceThreadTs = '1234567890.123456';
      const forkCommandTs = '5555555555.555555';

      // Mock session for main channel
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

      // Mock thread session with active session
      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock postMessage to return ts for new thread
      mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '9999999999.999999' });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-thread "test forking"',
          channel: 'C123',
          ts: forkCommandTs,
          thread_ts: sourceThreadTs,
        },
        client: mockClient,
      });

      // Find the call that posts to the new thread (has thread_ts and contains "Forked from")
      const newThreadCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts === '9999999999.999999' && call[0].text?.includes('Forked from')
      );

      expect(newThreadCall).toBeDefined();
      // Should contain link to the specific fork command message (not just thread)
      const expectedLink = `https://slack.com/archives/C123/p${forkCommandTs.replace('.', '')}`;
      expect(newThreadCall[0].text).toContain(expectedLink);
      expect(newThreadCall[0].text).toContain('previous thread');
    });

    it('should include link to new thread in source thread notification', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const sourceThreadTs = '1234567890.123456';
      const newThreadTs = '9999999999.999999';

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

      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: newThreadTs });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-thread "test"',
          channel: 'C123',
          ts: '5555555555.555555',
          thread_ts: sourceThreadTs,
        },
        client: mockClient,
      });

      // Find the notification posted to source thread
      const sourceNotifyCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].thread_ts === sourceThreadTs && call[0].text?.includes('forked to')
      );

      expect(sourceNotifyCall).toBeDefined();
      // Should contain link to new thread
      const expectedLink = `https://slack.com/archives/C123/p${newThreadTs.replace('.', '')}`;
      expect(sourceNotifyCall[0].text).toContain(expectedLink);
      expect(sourceNotifyCall[0].text).toContain('new thread');
    });

    it('should error when /fork-thread used outside a thread', async () => {
      const handler = registeredHandlers['event_app_mention'];
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
          text: '<@BOT123> /fork-thread "test"',
          channel: 'C123',
          ts: '1234567890.123456',
          // No thread_ts - not in a thread
        },
        client: mockClient,
      });

      // Should post error message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('can only be used inside a thread'),
        })
      );
    });

    it('should error when source thread has no session', async () => {
      const handler = registeredHandlers['event_app_mention'];
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

      // No session for the thread
      vi.mocked(getThreadSession).mockReturnValue(null);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-thread "test"',
          channel: 'C123',
          ts: '5555555555.555555',
          thread_ts: '1234567890.123456',
        },
        client: mockClient,
      });

      // Should post error in thread
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: '1234567890.123456',
          text: expect.stringContaining('no active session'),
        })
      );
    });

    it('should save forked thread session with correct fields', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const sourceThreadTs = '1234567890.123456';
      const newThreadTs = '9999999999.999999';

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

      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/custom/path',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: newThreadTs });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-thread "test"',
          channel: 'C123',
          ts: '5555555555.555555',
          thread_ts: sourceThreadTs,
        },
        client: mockClient,
      });

      // Verify saveThreadSession was called with correct data
      expect(saveThreadSession).toHaveBeenCalledWith(
        'C123',
        newThreadTs,
        expect.objectContaining({
          sessionId: null,
          forkedFrom: 'source-thread-session',
          forkedFromThreadTs: sourceThreadTs,
          workingDir: '/custom/path',
          mode: 'bypassPermissions',
        })
      );
    });

    it('should fork from parent when first message sent to forked thread (uninitialized fork)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const forkedThreadTs = '9999999999.999999';
      const sourceThreadSessionId = 'source-thread-session-abc123';

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

      // Mock forked thread session: sessionId null but forkedFrom set (uninitialized fork)
      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null, // Not initialized yet
          forkedFrom: sourceThreadSessionId, // Parent thread session
          forkedFromThreadTs: '1234567890.123456',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
        },
        isNewFork: false, // Thread exists in sessions.json
      });

      // Mock SDK to return async generator
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-forked-session-xyz', model: 'claude-opus-4-1-20250805' },
        { type: 'assistant', content: 'Response from forked thread' },
        {
          type: 'result',
          result: 'Response from forked thread',
          duration_ms: 1000,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> what is the value?',
          channel: 'C123',
          ts: '1111111111.111111',
          thread_ts: forkedThreadTs,
        },
        client: mockClient,
      });

      // Critical assertion: Should fork from parent thread session (not start new session)
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'what is the value?',
        expect.objectContaining({
          sessionId: sourceThreadSessionId, // Should use parent's sessionId
          forkSession: true, // Should fork (not resume)
        })
      );

      // Should save new sessionId after SDK init
      expect(saveThreadSession).toHaveBeenCalledWith('C123', forkedThreadTs, {
        sessionId: 'new-forked-session-xyz',
      });
    });

    it('should fork from thread session (not main session) when using /fork-thread', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const sourceThreadTs = '1234567890.123456';
      const mainSessionId = 'main-session-id';
      const threadSessionId = 'thread-session-id-different-from-main';

      // Main session exists
      vi.mocked(getSession).mockReturnValue({
        sessionId: mainSessionId,
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Source thread has its own session (different from main)
      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: threadSessionId,
        forkedFrom: mainSessionId,
        workingDir: '/test/dir',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      mockClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '9999999999.999999' });

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> /fork-thread "explore alternative"',
          channel: 'C123',
          ts: '5555555555.555555',
          thread_ts: sourceThreadTs,
        },
        client: mockClient,
      });

      // Critical: Should save with thread's sessionId (not main's sessionId)
      expect(saveThreadSession).toHaveBeenCalledWith(
        'C123',
        '9999999999.999999',
        expect.objectContaining({
          sessionId: null,
          forkedFrom: threadSessionId, // Should use THREAD session, not main
        })
      );

      // Verify it's using thread session, not main session
      const saveCall = vi.mocked(saveThreadSession).mock.calls[0];
      expect(saveCall[2].forkedFrom).toBe(threadSessionId);
      expect(saveCall[2].forkedFrom).not.toBe(mainSessionId);
    });

    it('should save sessionId at init time even if SDK crashes after', async () => {
      // Critical bug fix test: sessionId must be saved immediately when init message received
      // If saved only at end of try block, SDK crash after init causes sessionId to never be saved
      // Next message then sees sessionId: null and tries to fork again (instead of resume)
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1234567890.123456';
      const newSessionId = 'new-session-after-fork';

      // Existing thread without sessionId (simulating first message in thread)
      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'parent-session',
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

      // Mock SDK: returns init message with session_id, then throws error (simulating crash)
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: newSessionId, model: 'claude-opus-4-1-20250805' };
          // SDK crashes after init but before result
          throw new Error('SDK crashed after init');
        },
        interrupt: vi.fn(),
      } as any);

      // Handler should catch the error gracefully
      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: '5555555555.555555',
          thread_ts: threadTs,
        },
        client: mockClient,
      });

      // CRITICAL: sessionId should have been saved at init time (before crash)
      // This is the fix for the bug where SDK crash caused sessionId to never be saved
      expect(saveThreadSession).toHaveBeenCalledWith('C123', threadTs, {
        sessionId: newSessionId,
      });
    });

    it('should save main session sessionId at init time even if SDK crashes after', async () => {
      // Same test but for main channel session (not thread)
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const newSessionId = 'new-main-session';

      // Main session without sessionId (e.g., after /clear or first message)
      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK: returns init message, then throws error
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: newSessionId, model: 'claude-opus-4-1-20250805' };
          throw new Error('SDK crashed after init');
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          type: 'app_mention',
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: '1111111111.111111',
          // No thread_ts - this is a main channel message
        },
        client: mockClient,
      });

      // CRITICAL: main session sessionId should have been saved at init time
      expect(saveSession).toHaveBeenCalledWith('C123', {
        sessionId: newSessionId,
      });
    });
  });
});
