/**
 * Shared setup for slack-bot integration tests.
 * This file contains handler tracking and utility functions.
 *
 * NOTE: vi.mock() calls must be at the TOP LEVEL of each test file (Vitest hoists them).
 * Copy the mocks from the template below into each test file.
 */
import { vi } from 'vitest';

// Store registered handlers - exported for test access
export let registeredHandlers: Record<string, any> = {};

// Reset handlers - call this in beforeEach
export function resetHandlers() {
  registeredHandlers = {};
}

// Create mock Slack client with all required methods
export function createMockSlackClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg123', channel: 'C123' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      postEphemeral: vi.fn().mockResolvedValue({}),
      startStream: vi.fn().mockRejectedValue(new Error('Native streaming not available')),
      appendStream: vi.fn().mockResolvedValue({}),
      stopStream: vi.fn().mockResolvedValue({}),
      getPermalink: vi.fn().mockImplementation(({ channel, message_ts }) =>
        Promise.resolve({ ok: true, permalink: `https://test-workspace.slack.com/archives/${channel}/p${message_ts.replace('.', '')}` })
      ),
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      create: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'CNEW123', name: 'new-channel' } }),
      invite: vi.fn().mockResolvedValue({ ok: true }),
      info: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'C123' } }),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// Helper to get session mock with defaults
export function createMockSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'test-session',
    workingDir: '/test',
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/test/dir',
    configuredBy: 'U123',
    configuredAt: Date.now(),
    ...overrides,
  };
}

// Helper to create a mock Claude query generator
export function createMockClaudeQuery(messages: any[], interruptFn = vi.fn()) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
    interrupt: interruptFn,
  } as any;
}

/**
 * TEMPLATE: Copy these mocks to the top of each test file (before any imports)
 *
 * // Store registered handlers
 * let registeredHandlers: Record<string, any> = {};
 *
 * vi.mock('@slack/bolt', () => {
 *   return {
 *     App: class MockApp {
 *       event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
 *       message(handler: any) { registeredHandlers['message'] = handler; }
 *       action(pattern: RegExp, handler: any) { registeredHandlers[`action_${pattern.source}`] = handler; }
 *       view(pattern: RegExp, handler: any) { registeredHandlers[`view_${pattern.source}`] = handler; }
 *       async start() { return Promise.resolve(); }
 *     },
 *   };
 * });
 *
 * vi.mock('../../claude-client.js', () => ({
 *   streamClaude: vi.fn(),
 *   startClaudeQuery: vi.fn(),
 * }));
 *
 * vi.mock('../../session-manager.js', () => ({
 *   getSession: vi.fn(),
 *   saveSession: vi.fn(),
 *   getOrCreateThreadSession: vi.fn().mockReturnValue({
 *     session: { sessionId: null, forkedFrom: null, workingDir: '/test/dir', mode: 'default',
 *       createdAt: Date.now(), lastActiveAt: Date.now(), pathConfigured: true,
 *       configuredPath: '/test/dir', configuredBy: 'U123', configuredAt: Date.now() },
 *     isNewFork: false,
 *   }),
 *   getThreadSession: vi.fn(),
 *   saveThreadSession: vi.fn(),
 *   saveMessageMapping: vi.fn(),
 *   findForkPointMessageId: vi.fn().mockReturnValue(null),
 *   deleteSession: vi.fn(),
 *   saveActivityLog: vi.fn().mockResolvedValue(undefined),
 *   getActivityLog: vi.fn().mockResolvedValue(null),
 * }));
 *
 * vi.mock('../../concurrent-check.js', () => ({
 *   isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
 *   buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
 *   getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
 * }));
 *
 * vi.mock('../../model-cache.js', () => ({
 *   getAvailableModels: vi.fn().mockResolvedValue([
 *     { value: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', description: 'Fast' },
 *     { value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', description: 'Smart' },
 *   ]),
 *   isModelAvailable: vi.fn().mockResolvedValue(true),
 *   refreshModelCache: vi.fn().mockResolvedValue(undefined),
 *   getModelInfo: vi.fn().mockResolvedValue({ value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' }),
 * }));
 *
 * vi.mock('fs', () => ({
 *   default: {
 *     existsSync: vi.fn(),
 *     writeFileSync: vi.fn(),
 *     readFileSync: vi.fn(),
 *     promises: { readFile: vi.fn().mockResolvedValue('# Test Plan Content') },
 *   },
 * }));
 */
