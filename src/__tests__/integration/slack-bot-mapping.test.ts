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
  addSlackOriginatedUserUuid: vi.fn(),
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

vi.mock('../../session-reader.js', () => ({
  getSessionFilePath: vi.fn().mockReturnValue('/test/session.jsonl'),
  sessionFileExists: vi.fn().mockReturnValue(false),
  readLastUserMessageUuid: vi.fn().mockReturnValue(null),
  extractPlanFilePathFromInput: vi.fn((input) => {
    if (!input) return null;
    const planPath = (input.file_path || input.path) as string | undefined;
    if (typeof planPath === 'string' &&
        planPath.includes('.claude/plans/') &&
        planPath.endsWith('.md')) {
      return planPath;
    }
    return null;
  }),
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveMessageMapping } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('slack-bot message mapping', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};
    vi.resetModules();
  });

  describe('assistant UUID tracking for /ff filtering', () => {
    it('should save immediate mapping for assistant UUID when text is streamed', async () => {
      // Setup: Claude returns assistant message with UUID and streams text via stream_event
      // With immediate mapping, the UUID is linked to the real Slack ts when the response is posted
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
          yield { type: 'assistant', uuid: 'assistant-uuid-123' };
          // Stream text via stream_event (this is how text is accumulated in interleaved posting)
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world!' } } };
          yield { type: 'result', result: 'Hello world!' };
        },
        interrupt: vi.fn(),
      } as any);

      await import('../../slack-bot.js');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      // Ensure postMessage returns a real ts for immediate mapping
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'response-msg-ts' });

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
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
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'user-msg-ts',
        },
        client: mockClient,
      });

      // With new behavior, response is posted to activity thread (not main channel)
      // Mapping is saved with the activity thread post ts for Fork here functionality
      expect(saveMessageMapping).toHaveBeenCalledWith(
        'C123',
        expect.any(String),  // Activity thread post ts (returned from postResponseToThread)
        expect.objectContaining({
          sdkMessageId: 'assistant-uuid-123',
          sessionId: 'session-123',
          type: 'assistant',
        })
      );
    });

    it('should save placeholder mapping when response is empty but UUID exists', async () => {
      // Setup: Claude returns assistant message with UUID but empty result
      // This happens when Claude only uses tools/thinks but outputs no text
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-456', model: 'claude-sonnet' };
          yield { type: 'assistant', uuid: 'assistant-uuid-456' };
          yield { type: 'result', result: '' };  // Empty result
        },
        interrupt: vi.fn(),
      } as any);

      await import('../../slack-bot.js');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
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
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'user-msg-ts',
        },
        client: mockClient,
      });

      // Should save placeholder mapping with _slack_ prefix
      // This prevents /ff from re-importing this message
      const assistantCalls = vi.mocked(saveMessageMapping).mock.calls.filter(
        call => call[2].type === 'assistant'
      );
      expect(assistantCalls).toHaveLength(1);
      expect(assistantCalls[0]).toEqual([
        'C123',
        '_slack_assistant-uuid-456',
        expect.objectContaining({
          sdkMessageId: 'assistant-uuid-456',
          sessionId: 'session-456',
          type: 'assistant',
        }),
      ]);
    });

    it('should NOT save mapping when no assistant UUID is captured', async () => {
      // Setup: Claude returns only init and result, no assistant message
      // This is an edge case where SDK might not emit assistant message
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-789', model: 'claude-sonnet' };
          yield { type: 'result', result: 'Response without assistant event' };
        },
        interrupt: vi.fn(),
      } as any);

      await import('../../slack-bot.js');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      mockClient.files.uploadV2.mockResolvedValue({
        ok: true,
        file: { shares: { public: { C123: [{ ts: 'response-ts' }] } } },
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
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
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'user-msg-ts',
        },
        client: mockClient,
      });

      // Should NOT call saveMessageMapping for assistant (no UUID captured)
      const assistantCalls = vi.mocked(saveMessageMapping).mock.calls.filter(
        call => call[2].type === 'assistant'
      );
      expect(assistantCalls).toHaveLength(0);
    });

    it('should NOT save mapping when session init fails (no newSessionId)', async () => {
      // Setup: SDK crashes before sending init message
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'assistant', uuid: 'assistant-uuid-orphan' };
          // No init message - simulates SDK failure
          throw new Error('SDK connection failed');
        },
        interrupt: vi.fn(),
      } as any);

      await import('../../slack-bot.js');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
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
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'user-msg-ts',
        },
        client: mockClient,
      });

      // Should NOT save assistant mapping (no valid session)
      const assistantCalls = vi.mocked(saveMessageMapping).mock.calls.filter(
        call => call[2].type === 'assistant'
      );
      expect(assistantCalls).toHaveLength(0);
    });

    it('should save placeholder when postMessage returns no ts', async () => {
      // Setup: Claude returns response but Slack postMessage returns undefined ts
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-no-ts', model: 'claude-sonnet' };
          yield { type: 'assistant', uuid: 'assistant-uuid-no-ts' };
          yield { type: 'result', result: 'Response with no ts returned' };
        },
        interrupt: vi.fn(),
      } as any);

      await import('../../slack-bot.js');

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Simulate postMessage succeeding but returning no ts
      // This can happen in edge cases
      mockClient.chat.postMessage.mockResolvedValue({ ok: true });  // No ts field

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
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
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'user-msg-ts',
        },
        client: mockClient,
      });

      // Should save placeholder mapping when no ts is returned from posting
      // This is critical - the UUID must be tracked to prevent /ff re-import
      const assistantCalls = vi.mocked(saveMessageMapping).mock.calls.filter(
        call => call[2].type === 'assistant'
      );
      expect(assistantCalls).toHaveLength(1);
      expect(assistantCalls[0]).toEqual([
        'C123',
        '_slack_assistant-uuid-no-ts',
        expect.objectContaining({
          sdkMessageId: 'assistant-uuid-no-ts',
          sessionId: 'session-no-ts',
          type: 'assistant',
        }),
      ]);
    });
  });
});
