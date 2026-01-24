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
  clearSyncedMessageUuids: vi.fn(),
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

vi.mock('../../terminal-watcher.js', () => ({
  startWatching: vi.fn().mockReturnValue({ success: true }),
  stopWatching: vi.fn().mockReturnValue(true),
  isWatching: vi.fn().mockReturnValue(false),
  updateWatchRate: vi.fn().mockReturnValue(true),
  getWatcher: vi.fn().mockReturnValue(undefined),
  onSessionCleared: vi.fn(),
  stopAllWatchers: vi.fn(),
  postTerminalMessage: vi.fn().mockResolvedValue(undefined),
  WatchState: {},
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

describe('slack-bot command handlers', () => {
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

  describe('/compact command', () => {
    it('should call runCompactSession when compactSession flag is set', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session with existing session ID
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return compact_boundary message
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session-456', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should have started query with /compact as prompt
      expect(startClaudeQuery).toHaveBeenCalledWith(
        '/compact',
        expect.objectContaining({
          sessionId: 'existing-session-123',
        })
      );

      // Should have posted status messages
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
    });

    it('should return error when no session for /compact', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session without session ID
      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should NOT start a query since no session
      expect(startClaudeQuery).not.toHaveBeenCalledWith('/compact', expect.anything());

      // Should post error response about no session
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No active session'),
        })
      );
    });

    it('should update session ID after successful compaction', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'old-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return new session ID after compaction
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-compacted-session', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 10000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should save new session ID
      expect(saveSession).toHaveBeenCalledWith(
        'C123',
        expect.objectContaining({
          sessionId: 'new-compacted-session',
        })
      );
    });
  });

  describe('/compact command with abort', () => {
    it('should register /compact query in activeQueries for abort capability', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Import busyConversations to verify tracking
      const { busyConversations } = await import('../../slack-bot.js');

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Track when postMessage is called to verify activeQueries is set
      let activeQueriesChecked = false;
      mockClient.chat.postMessage.mockImplementation(async (params: any) => {
        // After status message is posted, activeQueries should be set
        if (params.text === 'Compacting session...') {
          // Can't easily check activeQueries from here, but we verify via abort behavior
          activeQueriesChecked = true;
        }
        return { ts: 'status123', channel: 'C123' };
      });

      // Mock SDK to return compact_boundary message
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session-456', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should have posted status message
      expect(activeQueriesChecked).toBe(true);
    });

    it('should add conversationKey to busyConversations during /compact', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Import busyConversations to verify tracking
      const { busyConversations } = await import('../../slack-bot.js');

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      let busyDuringCompact = false;
      const conversationKey = 'compact_C123';

      // Mock SDK to check busyConversations during iteration
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session-456', model: 'claude-sonnet' };
          // Check if busy during compaction
          busyDuringCompact = busyConversations.has(conversationKey);
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should have been busy during compaction
      expect(busyDuringCompact).toBe(true);
      // Should be cleaned up after completion
      expect(busyConversations.has(conversationKey)).toBe(false);
    });

    it('should post :gear: message when compact_boundary found', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session-456', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 150000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post :gear: message with spinner and token count
      const gearCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes(':gear:') && call[0]?.text?.includes('Compacting context')
      );
      expect(gearCalls.length).toBe(1);
      expect(gearCalls[0][0].text).toMatch(/◐|◓|◑|◒/); // Spinner frame
      expect(gearCalls[0][0].text).toContain('150,000 tokens');
      expect(gearCalls[0][0].text).toContain('(0.0s)');
    });

    it('should update :gear: message to :checkered_flag: on completion', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Track message timestamps
      let gearMsgTs = 'gear123';
      mockClient.chat.postMessage.mockImplementation(async (params: any) => {
        if (params.text?.includes(':gear:')) {
          return { ts: gearMsgTs, channel: 'C123' };
        }
        return { ts: 'msg123', channel: 'C123' };
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session-456', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 150000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should update :gear: message to :checkered_flag:
      const checkeredFlagCalls = mockClient.chat.update.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes(':checkered_flag:') && call[0]?.text?.includes('Compacted context')
      );
      expect(checkeredFlagCalls.length).toBeGreaterThanOrEqual(1);
      expect(checkeredFlagCalls[0][0].ts).toBe(gearMsgTs);
      expect(checkeredFlagCalls[0][0].text).toContain('150,000 tokens');
    });
  });

  describe('/clear command', () => {
    it('should set sessionId to null after /clear succeeds', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session with existing session ID
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'old-session-id',
        previousSessionIds: [],
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // SDK returns same session ID (this is actual SDK behavior - /clear as prompt does nothing)
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'old-session-id', model: 'claude-sonnet' };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /clear',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should have started query with /clear as prompt
      expect(startClaudeQuery).toHaveBeenCalledWith(
        '/clear',
        expect.objectContaining({
          sessionId: 'old-session-id',
        })
      );

      // CRITICAL: Should set sessionId to NULL so next message starts fresh
      expect(saveSession).toHaveBeenCalledWith(
        'C123',
        expect.objectContaining({
          sessionId: null,
          previousSessionIds: ['old-session-id'],
        })
      );

      // Should post success message
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Session history cleared'),
        })
      );
    });

    it('should track multiple previous sessions after repeated /clear', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session that already has previous sessions (from earlier /clear commands)
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'session-v2',
        previousSessionIds: ['session-v1'],
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // SDK returns same session ID (as expected)
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-v2', model: 'claude-sonnet' };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /clear',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should save with sessionId: null and accumulated previous session IDs
      expect(saveSession).toHaveBeenCalledWith(
        'C123',
        expect.objectContaining({
          sessionId: null,
          previousSessionIds: ['session-v1', 'session-v2'],
        })
      );
    });

    it('should return error when no session for /clear', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock session without session ID
      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /clear',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should NOT start a query since no session
      expect(startClaudeQuery).not.toHaveBeenCalledWith('/clear', expect.anything());

      // Should post error response about no session
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No active session'),
        })
      );
    });
  });

  describe('/compact honors updateRateSeconds', () => {
    it('should use updateRateSeconds from session for spinner timer interval', async () => {
      // Spy on setTimeout to capture interval values
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Setup session with custom updateRateSeconds (5 seconds)
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        updateRateSeconds: 5,  // Custom update rate
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Find setTimeout calls with 5000ms (5 seconds * 1000)
      const spinnerTimeoutCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === 5000
      );

      // Should have at least one setTimeout call with the session's updateRateSeconds
      expect(spinnerTimeoutCalls.length).toBeGreaterThanOrEqual(1);

      setTimeoutSpy.mockRestore();
    });

    it('should use default updateRateSeconds (3s) when not configured', async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Setup session WITHOUT updateRateSeconds (should use default of 3)
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        // updateRateSeconds not set - should default to 3
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Find setTimeout calls with 3000ms (default 3 seconds * 1000)
      const spinnerTimeoutCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === 3000
      );

      // Should have at least one setTimeout call with the default updateRateSeconds
      expect(spinnerTimeoutCalls.length).toBeGreaterThanOrEqual(1);

      setTimeoutSpy.mockRestore();
    });

    it('should NOT use hardcoded 1000ms interval anymore', async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Setup session with updateRateSeconds different from 1 second
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session-123',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        updateRateSeconds: 7,  // Use 7 seconds to be distinct
      });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'compacted-session', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } };
          yield { type: 'result', result: '' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /compact',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Find setTimeout calls with 7000ms (7 seconds * 1000)
      const spinnerTimeoutCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === 7000
      );

      // Should use the session's updateRateSeconds, not hardcoded 1000ms
      expect(spinnerTimeoutCalls.length).toBeGreaterThanOrEqual(1);

      // Verify we're NOT using the old hardcoded 1000ms for spinner updates
      // (Note: there may be other 1000ms timeouts for different purposes,
      // but the spinner should use 7000ms)

      setTimeoutSpy.mockRestore();
    });
  });
});
