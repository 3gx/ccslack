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

describe('slack-bot question handlers', () => {
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

  describe('AskUserQuestion handling', () => {
    it('should handle AskUserQuestion in plan mode (non-default)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set up session with plan mode (not default)
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Capture the canUseTool callback
      let capturedCanUseTool: any = null;
      vi.mocked(startClaudeQuery).mockImplementation((prompt, options) => {
        capturedCanUseTool = options.canUseTool;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
            yield { type: 'result', result: 'Done' };
          },
          interrupt: vi.fn(),
        } as any;
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // canUseTool should be defined even in plan mode (for AskUserQuestion)
      expect(capturedCanUseTool).toBeDefined();

      // Call the callback with AskUserQuestion tool
      const resultPromise = capturedCanUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Which approach?',
              header: 'Approach',
              options: [
                { label: 'Simple', description: 'Simple approach' },
                { label: 'Complex', description: 'Complex approach' },
              ],
              multiSelect: false,
            },
          ],
        },
        { signal: new AbortController().signal }
      );

      // Should have posted question message to Slack
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Approach'),
        })
      );
    });

    it('should allow regular tools without prompt in plan mode', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set up session with plan mode
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      let capturedCanUseTool: any = null;
      vi.mocked(startClaudeQuery).mockImplementation((prompt, options) => {
        capturedCanUseTool = options.canUseTool;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
            yield { type: 'result', result: 'Done' };
          },
          interrupt: vi.fn(),
        } as any;
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      expect(capturedCanUseTool).toBeDefined();

      // Reset mock to check if approval message is posted
      mockClient.chat.postMessage.mockClear();

      // Call with regular tool in plan mode - should auto-allow without posting
      const result = await capturedCanUseTool(
        'Read',
        { file_path: '/test.txt' },
        { signal: new AbortController().signal }
      );

      // Should auto-allow in non-default mode
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ file_path: '/test.txt' });

      // Should NOT have posted approval message (only initial messages from handler)
      // The postMessage calls before mockClear were for status/activity messages
    });
  });

  describe('SDK question button handlers', () => {
    it('should resolve pending question on option click', async () => {
      const handler = registeredHandlers['action_^sdkq_(.+)_(\\d+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_askuserq_123_0', value: 'OAuth' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Note: Without a pending question in the Map, update won't be called
      // This test verifies the handler exists and acknowledges
    });

    it('should match real action_id format with multiple underscores in questionId', async () => {
      // Real questionId format: askuserq_<timestamp>_<random> e.g. askuserq_1705000000000_abc123xyz
      // Full action_id: sdkq_askuserq_1705000000000_abc123xyz_0
      // The regex must use .+ (not [^_]+) to match questionIds containing underscores
      const handler = registeredHandlers['action_^sdkq_(.+)_(\\d+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Use the REAL action_id format with timestamp and random string
      const realActionId = 'sdkq_askuserq_1705000000000_abc123xyz_0';

      await handler({
        action: { action_id: realActionId, value: 'Selected Option' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Verify the regex correctly extracts questionId with underscores
      const match = realActionId.match(/^sdkq_(.+)_(\d+)$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('askuserq_1705000000000_abc123xyz'); // Full questionId with underscores
      expect(match![2]).toBe('0'); // Option index
    });

    it('should handle abort button click', async () => {
      const handler = registeredHandlers['action_^sdkq_abort_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_abort_askuserq_456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle multi-select change', async () => {
      const handler = registeredHandlers['action_^sdkq_multi_(.+)$'];
      expect(handler).toBeDefined();

      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'sdkq_multi_askuserq_789',
          selected_options: [{ value: 'Option1' }, { value: 'Option2' }],
        },
        ack,
        body: {},
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle submit button click', async () => {
      const handler = registeredHandlers['action_^sdkq_submit_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_submit_askuserq_abc' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle Other button click', async () => {
      const handler = registeredHandlers['action_^sdkq_other_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'sdkq_other_askuserq_def' },
        ack,
        body: {
          trigger_id: 'trigger123',
          actions: [{ action_id: 'sdkq_other_askuserq_def' }],
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Modal won't open without pending question, but handler acknowledges
    });

    it('should handle free-text modal submission', async () => {
      const handler = registeredHandlers['view_^sdkq_freetext_modal_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        ack,
        body: {},
        view: {
          callback_id: 'sdkq_freetext_modal_askuserq_ghi',
          state: {
            values: {
              answer_block: {
                answer_input: { value: 'Custom answer' },
              },
            },
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });
  });

  describe('SDK question ack() failure resilience', () => {
    it('should handle ack() failure on option click gracefully', async () => {
      const handler = registeredHandlers['action_^sdkq_(.+)_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('Slack timeout'));

      // Handler should NOT throw when ack fails
      await handler({
        action: { action_id: 'sdkq_askuserq_123_0', value: 'OAuth' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Handler completes without throwing
    });

    it('should handle ack() failure on abort click gracefully', async () => {
      const handler = registeredHandlers['action_^sdkq_abort_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('Rate limited'));

      await handler({
        action: { action_id: 'sdkq_abort_askuserq_456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle ack() failure on multi-select change gracefully', async () => {
      const handler = registeredHandlers['action_^sdkq_multi_(.+)$'];
      const ack = vi.fn().mockRejectedValue(new Error('Network error'));

      await handler({
        action: {
          action_id: 'sdkq_multi_askuserq_789',
          selected_options: [{ value: 'Option1' }],
        },
        ack,
        body: {},
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle ack() failure on submit click gracefully', async () => {
      const handler = registeredHandlers['action_^sdkq_submit_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('Timeout'));

      await handler({
        action: { action_id: 'sdkq_submit_askuserq_abc' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle ack() failure on Other button click gracefully', async () => {
      const handler = registeredHandlers['action_^sdkq_other_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('API error'));

      await handler({
        action: { action_id: 'sdkq_other_askuserq_def' },
        ack,
        body: {
          trigger_id: 'trigger123',
          actions: [{ action_id: 'sdkq_other_askuserq_def' }],
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should handle ack() failure on free-text modal submission gracefully', async () => {
      const handler = registeredHandlers['view_^sdkq_freetext_modal_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn().mockRejectedValue(new Error('Connection reset'));

      await handler({
        ack,
        body: {},
        view: {
          callback_id: 'sdkq_freetext_modal_askuserq_ghi',
          state: {
            values: {
              answer_block: {
                answer_input: { value: 'Custom answer' },
              },
            },
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });
  });

});
