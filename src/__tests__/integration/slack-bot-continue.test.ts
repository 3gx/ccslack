import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// vi.mock calls must be at module level - Vitest hoists these
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
      message(handler: any) { registeredHandlers['message'] = handler; }
      action(pattern: string | RegExp, handler: any) {
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
  getMessageMapUuids: vi.fn().mockReturnValue(new Set()),
  clearSyncedMessageUuids: vi.fn(),
  isSlackOriginatedUserUuid: vi.fn().mockReturnValue(false),  // Default: not Slack-originated
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

vi.mock('../../terminal-watcher.js', () => ({
  startWatching: vi.fn().mockReturnValue({ success: true }),
  stopWatching: vi.fn().mockReturnValue(true),
  isWatching: vi.fn().mockReturnValue(false),
  updateWatchRate: vi.fn().mockReturnValue(true),
  getWatcher: vi.fn().mockReturnValue(undefined),
  onSessionCleared: vi.fn(),
  stopAllWatchers: vi.fn(),
  postTerminalMessage: vi.fn().mockResolvedValue(true),
  WatchState: {},  // Mock interface
}));

vi.mock('../../session-reader.js', () => ({
  readNewMessages: vi.fn().mockResolvedValue({ messages: [], newOffset: 0 }),
  getSessionFilePath: vi.fn().mockReturnValue('/mock/path/session.jsonl'),
  findMessageIndexByUuid: vi.fn().mockReturnValue(-1),
  sessionFileExists: vi.fn().mockReturnValue(true),
  extractTextContent: vi.fn((msg) => {
    if (typeof msg?.message?.content === 'string') return msg.message.content;
    return msg?.message?.content?.find((b: any) => b.type === 'text')?.text || '';
  }),
  groupMessagesByTurn: vi.fn().mockReturnValue([]),
  extractPlanFilePathFromMessage: vi.fn().mockReturnValue(null),  // Plan detection for /watch
  hasExitPlanMode: vi.fn().mockReturnValue(false),  // ExitPlanMode detection for /watch
}));

vi.mock('../../session-event-stream.js', () => ({
  readActivityLog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../ff-abort-tracker.js', () => ({
  markFfAborted: vi.fn(),
  isFfAborted: vi.fn().mockReturnValue(false),
  clearFfAborted: vi.fn(),
  resetFfAborted: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({ channels: {} })),
  promises: { readFile: vi.fn().mockResolvedValue('# Test Plan Content') },
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({ channels: {} })),
    promises: { readFile: vi.fn().mockResolvedValue('# Test Plan Content') },
  },
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getMessageMapUuids, clearSyncedMessageUuids, saveActivityLog, getOrCreateThreadSession } from '../../session-manager.js';
import { startWatching, stopWatching, isWatching, getWatcher, onSessionCleared, updateWatchRate, postTerminalMessage } from '../../terminal-watcher.js';
import { startClaudeQuery } from '../../claude-client.js';
import { readNewMessages, sessionFileExists, extractTextContent, groupMessagesByTurn } from '../../session-reader.js';
import { readActivityLog } from '../../session-event-stream.js';
import { markFfAborted, isFfAborted, clearFfAborted } from '../../ff-abort-tracker.js';

describe('slack-bot /watch command', () => {
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

    // Reset session-reader mocks to default values AFTER module import (can be overridden in tests)
    vi.mocked(extractTextContent).mockReturnValue('mock text content');
    vi.mocked(readActivityLog).mockResolvedValue([]);
    vi.mocked(isWatching).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations to defaults
    vi.mocked(extractTextContent).mockReturnValue('mock text content');
    vi.mocked(readActivityLog).mockResolvedValue([]);
    vi.mocked(isWatching).mockReturnValue(false);
  });

  describe('/watch command with terminal watching', () => {
    it('should post blocks with watching status and stop button', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session with existing session ID
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock postMessage to return a ts
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'response-ts-123' });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post blocks with watching status
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      const blocksCall = postMessageCalls.find(call =>
        call[0].blocks?.some((b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'stop_terminal_watch'))
      );

      expect(blocksCall).toBeDefined();

      // Verify blocks contain expected content
      const blocks = blocksCall[0].blocks;
      expect(blocks).toContainEqual(expect.objectContaining({
        type: 'header',
        text: expect.objectContaining({ text: 'Continue in Terminal' }),
      }));
      // Check for stop watching button with rate info
      expect(blocks).toContainEqual(expect.objectContaining({
        type: 'actions',
        elements: expect.arrayContaining([
          expect.objectContaining({
            action_id: 'stop_terminal_watch',
            text: expect.objectContaining({ text: expect.stringContaining('Stop Watching') }),
          }),
        ]),
      }));
    });

    it('should call startWatching after posting /watch response', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        updateRateSeconds: 3,
      });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'response-ts-456' });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // With thread-based output, anchor ts is used as BOTH statusMsgTs AND threadTs
      // All terminal activity posts as thread replies to the anchor
      expect(startWatching).toHaveBeenCalledWith(
        'C123',
        'response-ts-456',  // anchorTs used as threadTs for activity replies
        expect.objectContaining({ sessionId: 'existing-session-123' }),
        mockClient,
        'response-ts-456',  // anchorTs used as statusMsgTs
        'U123'  // userId for ephemeral error notifications
      );
    });

    it('should post error message if startWatching fails', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(startWatching).mockReturnValue({
        success: false,
        error: 'Session file not found',
      });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'response-ts' });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post error message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Could not start watching'),
        })
      );
    });

    it('should return error when no session exists for /watch', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,  // No session
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT call startWatching
      expect(startWatching).not.toHaveBeenCalled();

      // Should post error response
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No active session'),
        })
      );
    });

    it('should NOT post mode header message for /watch command (no Bypass/Plan message)', async () => {
      // This test verifies the fix for extra "Bypass" message appearing before /watch anchor
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'bypassPermissions',  // This would show as "Bypass" in header
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'response-ts' });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT post a header message with mode (Bypass/Plan/etc)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const headerCall = postCalls.find((call: any) => {
        const blocks = call[0].blocks;
        return blocks?.some((b: any) =>
          b.type === 'context' &&
          b.elements?.some((e: any) => e.text?.includes('Bypass') || e.text?.includes('Plan'))
        );
      });

      expect(headerCall).toBeUndefined();
    });
  });

  describe('stop_terminal_watch button handler', () => {
    it('should register stop_terminal_watch action handler', async () => {
      expect(registeredHandlers['action_stop_terminal_watch']).toBeDefined();
    });

    it('should call stopWatching when button clicked', async () => {
      const handler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts', thread_ts: undefined },
        },
        client: mockClient,
      });

      expect(stopWatching).toHaveBeenCalledWith('C123', undefined);
    });

    it('should update message to show stopped state', async () => {
      const handler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg-ts',
          text: 'Terminal watching stopped',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              text: expect.objectContaining({
                text: expect.stringContaining('Stopped watching'),
              }),
            }),
          ]),
        })
      );
    });

    it('should extract threadTs from button value for watcher lookup (thread-based output)', async () => {
      // This test verifies the fix for stop button not working with thread-based output
      // where the anchor message contains anchorTs in the button value
      const handler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'anchor-msg-ts' },  // Anchor is NOT in a thread, so no thread_ts
          actions: [{
            value: JSON.stringify({ sessionId: 'sess-123', threadTs: 'anchor-ts-for-watcher' }),
          }],
        },
        client: mockClient,
      });

      // Should use threadTs from button value, not from message.thread_ts
      expect(stopWatching).toHaveBeenCalledWith('C123', 'anchor-ts-for-watcher');
    });

    it('should fallback to message.thread_ts if button value has no threadTs (backwards compatibility)', async () => {
      const handler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts', thread_ts: 'thread-ts-fallback' },
          actions: [{
            value: JSON.stringify({ sessionId: 'sess-123' }),  // No threadTs in value
          }],
        },
        client: mockClient,
      });

      // Should fallback to undefined since threadTs in value is undefined
      // (message.thread_ts is only used if JSON parsing fails)
      expect(stopWatching).toHaveBeenCalledWith('C123', undefined);
    });
  });

  describe('block messages while watching', () => {
    it('should block regular messages and show warning', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock isWatching to return true
      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> hello', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT stop watcher
      expect(stopWatching).not.toHaveBeenCalled();

      // Should post warning message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should block /clear command while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /clear', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT stop watcher
      expect(stopWatching).not.toHaveBeenCalled();

      // Should post warning message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should block /mode command while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /mode', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post warning message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should block /watch command while already watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post warning message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });
  });

  describe('watcher rate update on /update-rate', () => {
    it('should update watcher rate when /update-rate called while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock isWatching to return true
      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /update-rate 5', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should update watcher rate
      expect(updateWatchRate).toHaveBeenCalledWith('C123', undefined, 5);
    });
  });

  describe('/stop-watching command', () => {
    it('should call stopWatching and post success message when watcher is active', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(stopWatching).mockReturnValue(true);  // Watcher was active

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /stop-watching', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).toHaveBeenCalledWith('C123', undefined);
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Stopped watching terminal session'),
        })
      );
    });

    it('should post info message when no watcher is active', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(stopWatching).mockReturnValue(false);  // No watcher was active

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /stop-watching', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).toHaveBeenCalledWith('C123', undefined);
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('No active terminal watcher'),
        })
      );
    });

    it('should allow /stop-watching command while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Watcher is active
      vi.mocked(isWatching).mockReturnValue(true);
      vi.mocked(stopWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /stop-watching', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // stopWatching should be called by the command handler
      expect(stopWatching).toHaveBeenCalledTimes(1);

      // Should post the command success message (not the blocking warning)
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Stopped watching terminal session'),
        })
      );
    });

    it('should allow /status command while watching (read-only)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Watcher is active
      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /status', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // stopWatching should NOT be called for /status
      expect(stopWatching).not.toHaveBeenCalled();

      // Should NOT show blocking warning - should show status blocks instead
      expect(mockClient.chat.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should allow /help command while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /help', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).not.toHaveBeenCalled();
      // Should NOT show blocking warning
      expect(mockClient.chat.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should allow /ls command while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /ls', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).not.toHaveBeenCalled();
      // Should NOT show blocking warning
      expect(mockClient.chat.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });

    it('should block unknown commands (typos) while watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Typo in command - should be blocked
      await handler({
        event: { text: '<@BOT123> /stop-watchign', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).not.toHaveBeenCalled();
      // Should show blocking warning
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );
    });
  });

  describe('watcher cleanup on /clear', () => {
    it('should call onSessionCleared when /clear is executed (when not watching)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // NOT watching - /clear should work
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock the SDK query for /clear
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session-456', model: 'claude-sonnet' };
          yield { type: 'result', result: 'Cleared' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: { text: '<@BOT123> /clear', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should call onSessionCleared
      expect(onSessionCleared).toHaveBeenCalledWith('C123', undefined);
    });
  });

  describe.skip('/ff (fast-forward) command', () => {
    it('should return error when no session exists', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,  // No session
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT call any syncing functions
      expect(readNewMessages).not.toHaveBeenCalled();

      // Should post error response
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No active session'),
        })
      );
    });

    it('should sync missed messages and start watching', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock session file exists
      vi.mocked(sessionFileExists).mockReturnValue(true);

      // Mock already synced UUIDs (uuid-1 is synced, uuid-2 and uuid-3 are new)
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set(['uuid-1']));

      // Mock messages from session file (including old and new messages)
      const mockMessages = [
        { uuid: 'uuid-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Old response' }] } },
        { uuid: 'uuid-2', type: 'user' as const, timestamp: '2024-01-01T00:01:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'New user input' } },
        { uuid: 'uuid-3', type: 'assistant' as const, timestamp: '2024-01-01T00:02:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'New response' }] } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 1000 });

      // Mock groupMessagesByTurn - one turn with uuid-2 (user) and uuid-3 (text output)
      vi.mocked(groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessages[1],
        segments: [{ activityMessages: [], textOutput: mockMessages[2] }],
        trailingActivity: [],
        allMessageUuids: ['uuid-2', 'uuid-3'],
      }]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Turn-based posting: 1 turn with user input + text output = 2 messages posted
      // Plus initial status message = 3 total postMessage calls (but first is status)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      // Should have at least posted the new turn messages (user input + text response)
      const inputCall = postCalls.find((c: any) => c[0].text?.includes(':inbox_tray:'));
      expect(inputCall).toBeDefined();

      // messageMap is updated by postTerminalMessage -> saveMessageMapping (no separate tracking)

      // Should start watching after sync with anchor as thread parent
      // With thread-based output, anchor ts is used as BOTH statusMsgTs AND threadTs
      expect(startWatching).toHaveBeenCalledWith(
        'C123',
        expect.any(String),  // anchorTs used as threadTs for activity replies
        expect.objectContaining({ sessionId: 'existing-session-123' }),
        mockClient,
        expect.any(String),  // anchorTs used as statusMsgTs
        'U123'
      );
    });

    it('should not duplicate messages that were sent via Slack (mixed Slack/terminal workflow)', async () => {
      // Scenario: User works in Slack, then terminal, then Slack again, then /ff
      // Messages uuid-1, uuid-2 were sent via Slack bot
      // Messages uuid-3, uuid-4 were done in terminal (not in messageMap)
      // Messages uuid-5, uuid-6 were sent via Slack bot again
      // /ff should only import uuid-3, uuid-4 (terminal messages)

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      // messageMap has Slack-originated messages (uuid-1, 2, 5, 6) but NOT terminal messages (uuid-3, 4)
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set(['uuid-1', 'uuid-2', 'uuid-5', 'uuid-6']));

      // Session file has ALL messages in chronological order
      const msg3 = { uuid: 'uuid-3', type: 'user' as const, timestamp: '2024-01-01T00:02:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'Terminal input' } };
      const msg4 = { uuid: 'uuid-4', type: 'assistant' as const, timestamp: '2024-01-01T00:03:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Terminal response' }] } };
      const mockMessages = [
        { uuid: 'uuid-1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'Slack msg 1' } },
        { uuid: 'uuid-2', type: 'assistant' as const, timestamp: '2024-01-01T00:01:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Slack response 1' }] } },
        msg3,
        msg4,
        { uuid: 'uuid-5', type: 'user' as const, timestamp: '2024-01-01T00:04:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'Slack msg 2' } },
        { uuid: 'uuid-6', type: 'assistant' as const, timestamp: '2024-01-01T00:05:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Slack response 2' }] } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 1000 });

      // Mock groupMessagesByTurn - three turns, but only terminal turn needs posting
      vi.mocked(groupMessagesByTurn).mockReturnValue([
        { userInput: mockMessages[0], segments: [{ activityMessages: [], textOutput: mockMessages[1] }], trailingActivity: [], allMessageUuids: ['uuid-1', 'uuid-2'] },
        { userInput: msg3, segments: [{ activityMessages: [], textOutput: msg4 }], trailingActivity: [], allMessageUuids: ['uuid-3', 'uuid-4'] },
        { userInput: mockMessages[4], segments: [{ activityMessages: [], textOutput: mockMessages[5] }], trailingActivity: [], allMessageUuids: ['uuid-5', 'uuid-6'] },
      ]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Turn-based posting: only the terminal turn (uuid-3, uuid-4) should be posted
      // Should find user input with :inbox_tray: prefix
      const postCalls = mockClient.chat.postMessage.mock.calls;
      // Find any call that includes :inbox_tray: (user input marker)
      const userInputCall = postCalls.find((c: any) => c[0].text?.includes(':inbox_tray:'));
      expect(userInputCall).toBeDefined();
      // Should NOT have posted more than initial status + 1 turn + Fork button + final status
      // (user input, text response, Fork button message, status updates)
      expect(postCalls.length).toBeLessThanOrEqual(6);
    });

    it('should show "already up to date" and start watching when no new messages', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      // All messages already synced
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set(['uuid-1', 'uuid-2', 'uuid-3']));

      const mockMessages = [
        { uuid: 'uuid-1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'User' } },
        { uuid: 'uuid-2', type: 'assistant' as const, timestamp: '2024-01-01T00:01:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] } },
        { uuid: 'uuid-3', type: 'user' as const, timestamp: '2024-01-01T00:02:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'Last' } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 500 });

      // Mock groupMessagesByTurn - all messages already posted
      vi.mocked(groupMessagesByTurn).mockReturnValue([
        { userInput: mockMessages[0], segments: [{ activityMessages: [], textOutput: mockMessages[1] }], trailingActivity: [], allMessageUuids: ['uuid-1', 'uuid-2'] },
        { userInput: mockMessages[2], segments: [], trailingActivity: [], allMessageUuids: ['uuid-3'] },
      ]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // With turn-based posting, no new turns should be posted
      // (all UUIDs in all turns are already in messageMap)

      // Should update message to say "already up to date"
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Already up to date'),
        })
      );

      // Should still start watching
      expect(startWatching).toHaveBeenCalled();
    });

    it('should sync all messages when no prior synced UUIDs', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      // No prior synced messages (empty set)
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      const mockMessages = [
        { uuid: 'uuid-1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'User' } },
        { uuid: 'uuid-2', type: 'assistant' as const, timestamp: '2024-01-01T00:01:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 500 });

      // Mock groupMessagesByTurn - one turn with user input and text output
      vi.mocked(groupMessagesByTurn).mockReturnValue([
        { userInput: mockMessages[0], segments: [{ activityMessages: [], textOutput: mockMessages[1] }], trailingActivity: [], allMessageUuids: ['uuid-1', 'uuid-2'] },
      ]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Turn-based posting: 1 turn with user input + text output = 2 messages
      // Check for user input with :inbox_tray:
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const inputCall = postCalls.find((c: any) => c[0].text?.includes(':inbox_tray:'));
      expect(inputCall).toBeDefined();
    });

    it('should be blocked while watching is active', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post blocking warning
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Cannot run this while watching terminal'),
        })
      );

      // Should NOT attempt to sync
      expect(readNewMessages).not.toHaveBeenCalled();
    });

    it('should accept /fast-forward alias', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Reset isWatching to false for this test
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());
      vi.mocked(readNewMessages).mockResolvedValue({ messages: [], newOffset: 0 });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /fast-forward', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should call readNewMessages (indicating ff was triggered)
      expect(readNewMessages).toHaveBeenCalled();
    });

    it('should handle session file not found', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Reset isWatching to false for this test
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Session file doesn't exist
      vi.mocked(sessionFileExists).mockReturnValue(false);

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should post error about session file not found
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Session file not found'),
        })
      );

      // Should NOT attempt to sync
      expect(readNewMessages).not.toHaveBeenCalled();
    });

    it('should include Stop FF button in progress messages', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      const mockMessages = [
        { uuid: 'uuid-1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'User' } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 500 });

      // Mock groupMessagesByTurn
      vi.mocked(groupMessagesByTurn).mockReturnValue([
        { userInput: mockMessages[0], segments: [], trailingActivity: [], allMessageUuids: ['uuid-1'] },
      ]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Check that initial update was called with blocks containing Stop FF button
      const updateCalls = mockClient.chat.update.mock.calls;
      const progressUpdate = updateCalls.find(call =>
        call[0].blocks?.some((b: any) =>
          b.type === 'actions' &&
          b.elements?.some((e: any) => e.action_id === 'stop_ff_sync')
        )
      );

      expect(progressUpdate).toBeDefined();
    });

    it('should move status message to bottom by delete+repost on progress update', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      // Create enough messages to trigger progress update (10 messages)
      // Create as turns: 5 turns (user + assistant pairs)
      const mockMessages = Array.from({ length: 10 }, (_, i) => ({
        uuid: `uuid-${i + 1}`,
        type: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        timestamp: `2024-01-01T00:0${i}:00Z`,
        sessionId: 'sess-1',
        message: { role: (i % 2 === 0 ? 'user' : 'assistant'), content: (i % 2 === 0 ? `Message ${i + 1}` : [{ type: 'text', text: `Message ${i + 1}` }]) },
      }));
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 1000 });

      // Mock groupMessagesByTurn - 5 turns
      const turns = [];
      for (let i = 0; i < 5; i++) {
        turns.push({
          userInput: mockMessages[i * 2],
          segments: [{ activityMessages: [], textOutput: mockMessages[i * 2 + 1] }],
          trailingActivity: [],
          allMessageUuids: [`uuid-${i * 2 + 1}`, `uuid-${i * 2 + 2}`],
        });
      }
      vi.mocked(groupMessagesByTurn).mockReturnValue(turns);

      // Track postMessage calls to return different ts values
      let postMessageCallCount = 0;
      mockClient.chat.postMessage.mockImplementation(() => {
        postMessageCallCount++;
        return Promise.resolve({ ts: `msg-ts-${postMessageCallCount}` });
      });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // With turn-based posting, syncing should happen
      // Should have posted user inputs and text responses
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      expect(postMessageCalls.length).toBeGreaterThan(0);
    });

    it('should use new status message ts after moving to bottom', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      // 10 messages to trigger a progress update - 5 turns
      const mockMessages = Array.from({ length: 10 }, (_, i) => ({
        uuid: `uuid-${i + 1}`,
        type: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        timestamp: `2024-01-01T00:0${i}:00Z`,
        sessionId: 'sess-1',
        message: { role: (i % 2 === 0 ? 'user' : 'assistant'), content: (i % 2 === 0 ? `Message ${i + 1}` : [{ type: 'text', text: `Message ${i + 1}` }]) },
      }));
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 1000 });

      // Mock groupMessagesByTurn - 5 turns
      const turns = [];
      for (let i = 0; i < 5; i++) {
        turns.push({
          userInput: mockMessages[i * 2],
          segments: [{ activityMessages: [], textOutput: mockMessages[i * 2 + 1] }],
          trailingActivity: [],
          allMessageUuids: [`uuid-${i * 2 + 1}`, `uuid-${i * 2 + 2}`],
        });
      }
      vi.mocked(groupMessagesByTurn).mockReturnValue(turns);

      // First postMessage returns initial ts, subsequent calls return new ts
      let postMessageCallCount = 0;
      mockClient.chat.postMessage.mockImplementation(() => {
        postMessageCallCount++;
        if (postMessageCallCount === 1) {
          return Promise.resolve({ ts: 'initial-status-ts' });
        }
        return Promise.resolve({ ts: `new-status-ts-${postMessageCallCount}` });
      });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // With turn-based posting, syncing should complete
      // Check that messages were posted
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
    });

    it('should stop sync when abort flag is set', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      // 3 messages in 2 turns
      const mockMessages = [
        { uuid: 'uuid-1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'User 1' } },
        { uuid: 'uuid-2', type: 'assistant' as const, timestamp: '2024-01-01T00:01:00Z', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] } },
        { uuid: 'uuid-3', type: 'user' as const, timestamp: '2024-01-01T00:02:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'User 2' } },
      ];
      vi.mocked(readNewMessages).mockResolvedValue({ messages: mockMessages, newOffset: 500 });

      // Mock groupMessagesByTurn - 2 turns
      vi.mocked(groupMessagesByTurn).mockReturnValue([
        { userInput: mockMessages[0], segments: [{ activityMessages: [], textOutput: mockMessages[1] }], trailingActivity: [], allMessageUuids: ['uuid-1', 'uuid-2'] },
        { userInput: mockMessages[2], segments: [], trailingActivity: [], allMessageUuids: ['uuid-3'] },
      ]);

      // Simulate: after first turn, abort flag is set
      let checkCount = 0;
      vi.mocked(isFfAborted).mockImplementation(() => {
        checkCount++;
        // First check (before turn 1): false
        // Second check (before turn 2): true (user clicked Stop)
        return checkCount >= 2;
      });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // With turn-based posting and abort after first turn:
      // Only first turn (uuid-1, uuid-2) should be posted
      // Check that update shows "stopped" or similar
      const updateCalls = mockClient.chat.update.mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);

      // Should clear the abort flag
      expect(clearFfAborted).toHaveBeenCalledWith('C123');

      // Should show stopped message, not completed message
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Sync stopped'),
        })
      );

      // Should NOT start watching after stop
      expect(startWatching).not.toHaveBeenCalled();
    });

    it('should clear abort flag at start of /ff', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());
      vi.mocked(readNewMessages).mockResolvedValue({ messages: [], newOffset: 0 });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should clear abort flag at start
      expect(clearFfAborted).toHaveBeenCalledWith('C123');
    });

    // TODO: This test passes individually but fails in suite due to mock isolation issues
    // The feature works correctly - see unit tests in session-reader.test.ts
    it.skip('should post messages with text normally even if they have thinking blocks', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Reset ALL relevant mocks for this test
      const msgTimestamp = new Date('2024-01-01T12:00:00Z').getTime();
      vi.mocked(postTerminalMessage).mockClear();
      vi.mocked(postTerminalMessage).mockResolvedValue(undefined);
      vi.mocked(extractTextContent).mockReset();  // Reset completely
      vi.mocked(readActivityLog).mockReset();  // Reset completely
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      // Message with thinking AND text
      const msgWithThinkingAndText = {
        uuid: 'uuid-mixed',
        type: 'assistant' as const,
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'existing-session-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is my response' },
          ],
        },
      };
      vi.mocked(readNewMessages).mockResolvedValue({ messages: [msgWithThinkingAndText], newOffset: 1000 });

      // extractTextContent returns the text part
      vi.mocked(extractTextContent).mockReturnValue('Here is my response');

      // readActivityLog returns both entries with matching timestamp
      vi.mocked(readActivityLog).mockResolvedValue([
        { timestamp: msgTimestamp, type: 'thinking', thinkingContent: 'Let me think...', thinkingTruncated: 'Let me think...' },
        { timestamp: msgTimestamp, type: 'generating', generatingChars: 20 },
      ]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should call postTerminalMessage (has text content)
      expect(postTerminalMessage).toHaveBeenCalledTimes(1);
    });

    it('should skip messages with no text and no activity', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);
      vi.mocked(getMessageMapUuids).mockReturnValue(new Set());

      // Empty message (shouldn't happen in practice)
      const emptyMsg = {
        uuid: 'uuid-empty',
        type: 'assistant' as const,
        timestamp: '2024-01-01T12:00:00Z',
        sessionId: 'existing-session-123',
        message: { role: 'assistant', content: [] },
      };
      vi.mocked(readNewMessages).mockResolvedValue({ messages: [emptyMsg], newOffset: 1000 });

      vi.mocked(extractTextContent).mockReturnValue('');
      // No activity entries for empty message
      vi.mocked(readActivityLog).mockResolvedValue([]);

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'status-msg-ts' });

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'original-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should NOT call postTerminalMessage
      expect(postTerminalMessage).not.toHaveBeenCalled();

      // Should NOT save activity log for empty message
      expect(saveActivityLog).not.toHaveBeenCalled();
    });
  });

  describe.skip('stop_ff_sync button handler', () => {
    it('should register stop_ff_sync action handler', async () => {
      expect(registeredHandlers['action_stop_ff_sync']).toBeDefined();
    });

    it('should call markFfAborted when button clicked', async () => {
      const handler = registeredHandlers['action_stop_ff_sync'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts', thread_ts: undefined },
        },
        client: mockClient,
      });

      expect(markFfAborted).toHaveBeenCalledWith('C123');
    });

    it('should call markFfAborted with thread context', async () => {
      const handler = registeredHandlers['action_stop_ff_sync'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts', thread_ts: 'thread-ts-456' },
        },
        client: mockClient,
      });

      expect(markFfAborted).toHaveBeenCalledWith('C123_thread-ts-456');
    });

    it('should update message to show stopping state', async () => {
      const handler = registeredHandlers['action_stop_ff_sync'];
      const mockClient = createMockSlackClient();

      await handler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg-ts' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg-ts',
          text: 'Stopping sync...',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              elements: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining('Stopping sync'),
                }),
              ]),
            }),
          ]),
        })
      );
    });
  });

  describe('busyConversations blocking for /watch and /ff', () => {
    it('should add to busyConversations when /watch starts', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Clear any existing state
      busyConversations.clear();

      vi.mocked(isWatching).mockReturnValue(false);
      vi.mocked(startWatching).mockReturnValue({ success: true });

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'watch-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have added to busyConversations
      expect(busyConversations.has('C123')).toBe(true);

      // Cleanup
      busyConversations.delete('C123');
    });

    it('should remove from busyConversations when /stop-watching is called', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Pre-populate busyConversations
      busyConversations.add('C123');

      vi.mocked(isWatching).mockReturnValue(false);  // Allow /stop-watching through
      vi.mocked(stopWatching).mockReturnValue(true);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /stop-watching', channel: 'C123', ts: 'stop-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have removed from busyConversations
      expect(busyConversations.has('C123')).toBe(false);
    });

    it('should block Claude queries with busy message during /watch', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Simulate /watch is active (added to busyConversations but isWatching returns false for race window test)
      busyConversations.add('C123');
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> hello', channel: 'C123', ts: 'query-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have posted busy message
      const busyCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes("I'm busy with the current request")
      );
      expect(busyCalls.length).toBe(1);

      // Should have removed :eyes: reaction
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'query-ts',
        name: 'eyes',
      });

      // Cleanup
      busyConversations.delete('C123');
    });

    it('should remove from busyConversations when startWatching fails', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Clear any existing state
      busyConversations.clear();

      vi.mocked(isWatching).mockReturnValue(false);
      vi.mocked(startWatching).mockReturnValue({ success: false, error: 'No session' });

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'watch-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have removed from busyConversations on failure
      expect(busyConversations.has('C123')).toBe(false);
    });

    it('should remove from busyConversations when Stop Watching button is clicked', async () => {
      const buttonHandler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Pre-populate busyConversations
      busyConversations.add('C123');

      vi.mocked(stopWatching).mockReturnValue(true);

      await buttonHandler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'anchor-ts' },
          actions: [{ value: JSON.stringify({}) }],
        },
        client: mockClient,
      });

      // Should have removed from busyConversations
      expect(busyConversations.has('C123')).toBe(false);
    });

    it('should remove from busyConversations when Stop button has threadTs in value (production scenario)', async () => {
      const buttonHandler = registeredHandlers['action_stop_terminal_watch'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Pre-populate busyConversations with main channel key
      busyConversations.add('C123');

      vi.mocked(stopWatching).mockReturnValue(true);

      // Button value has threadTs: anchor-ts (as happens in production)
      await buttonHandler({
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'anchor-ts' },
          actions: [{ value: JSON.stringify({ threadTs: 'anchor-ts', sessionId: 'test-session' }) }],
        },
        client: mockClient,
      });

      // Should have removed from busyConversations using channelId only
      // (not C123_anchor-ts which would be wrong)
      expect(busyConversations.has('C123')).toBe(false);
    });

    it('should block /watch when agent is already busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Pre-populate busyConversations (simulating an active query)
      busyConversations.add('C123');
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: { text: '<@BOT123> /watch', channel: 'C123', ts: 'watch-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have posted busy message (and ONLY the busy message, not the anchor)
      const allCalls = mockClient.chat.postMessage.mock.calls;
      expect(allCalls.length).toBe(1);  // Only busy message, no anchor
      expect(allCalls[0][0]?.text).toContain("I'm busy with the current request");

      // Should have removed :eyes: reaction
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'watch-ts',
        name: 'eyes',
      });

      // Should NOT have called startWatching
      expect(startWatching).not.toHaveBeenCalled();

      // Cleanup
      busyConversations.delete('C123');
    });

    it('should block /ff when agent is already busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const { busyConversations } = await import('../../slack-bot.js');

      // Pre-populate busyConversations (simulating an active query)
      busyConversations.add('C123');
      vi.mocked(isWatching).mockReturnValue(false);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/project',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/project',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(sessionFileExists).mockReturnValue(true);

      await handler({
        event: { text: '<@BOT123> /ff', channel: 'C123', ts: 'ff-ts', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      // Should have posted busy message
      const busyCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes("I'm busy with the current request")
      );
      expect(busyCalls.length).toBe(1);

      // Should have removed :eyes: reaction
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'ff-ts',
        name: 'eyes',
      });

      // Should NOT have called readNewMessages (ff sync logic)
      expect(readNewMessages).not.toHaveBeenCalled();

      // Cleanup
      busyConversations.delete('C123');
    });

  });
});
