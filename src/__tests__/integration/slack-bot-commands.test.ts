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
});
