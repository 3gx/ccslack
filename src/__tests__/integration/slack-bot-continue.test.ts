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
import { getSession, saveSession } from '../../session-manager.js';
import { startWatching, stopWatching, isWatching, getWatcher, onSessionCleared, updateWatchRate } from '../../terminal-watcher.js';
import { startClaudeQuery } from '../../claude-client.js';

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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      expect(blocks).toContainEqual(expect.objectContaining({
        type: 'context',
        elements: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Watching for terminal activity') }),
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

      expect(startWatching).toHaveBeenCalledWith(
        'C123',
        undefined,
        expect.objectContaining({ sessionId: 'existing-session-123' }),
        mockClient,
        'response-ts-456',
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

    it('should work in thread context', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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
        event: { text: '<@BOT123> /stop-watching', channel: 'C123', ts: 'msg-ts', thread_ts: 'thread-ts-123', user: 'U123' },
        client: mockClient,
        say: vi.fn(),
      });

      expect(stopWatching).toHaveBeenCalledWith('C123', 'thread-ts-123');
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          thread_ts: 'thread-ts-123',
          text: expect.stringContaining('Stopped watching'),
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
});
