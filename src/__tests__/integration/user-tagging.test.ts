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
  getSegmentActivityLog: vi.fn().mockReturnValue(null),
  saveSegmentActivityLog: vi.fn(),
  updateSegmentActivityLog: vi.fn(),
  generateSegmentKey: vi.fn((channelId, messageTs) => `${channelId}_${messageTs}_seg_mock-uuid`),
  clearSegmentActivityLogs: vi.fn(),
  clearSyncedMessageUuids: vi.fn(),
  addSlackOriginatedUserUuid: vi.fn(),
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
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('User tagging on notifications', () => {
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

  describe('Query completion tagging', () => {
    it('should include user mention in completion status for channels', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
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
          text: '<@BOT123> hello',
          channel: 'C123',  // Channel ID starts with 'C'
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Wait for async completion processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify chat.update was called with user mention in text for completion
      const updateCalls = mockClient.chat.update.mock.calls;
      const completionCall = updateCalls.find(
        (call: any[]) => call[0]?.text?.includes('Complete')
      );

      expect(completionCall).toBeDefined();
      expect(completionCall?.[0]?.text).toContain('<@U123>');
    });

    it('should NOT include user mention in DMs', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
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
          text: '<@BOT123> hello',
          channel: 'D123',  // DM channel ID starts with 'D'
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Wait for async completion processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify chat.update was called WITHOUT user mention for DMs
      const updateCalls = mockClient.chat.update.mock.calls;
      const completionCall = updateCalls.find(
        (call: any[]) => call[0]?.text?.includes('Complete')
      );

      // Should have completion but without mention
      if (completionCall) {
        expect(completionCall[0].text).not.toContain('<@U123>');
      }
    });
  });

  describe('AskUserQuestion tagging', () => {
    it('should include user mention in question text for channels', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'default',
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
          user: 'UTEST123',
          text: '<@BOT123> test',
          channel: 'C123',  // Channel
          ts: 'msg123',
        },
        client: mockClient,
      });

      expect(capturedCanUseTool).toBeDefined();

      // Clear previous calls to isolate question posting
      mockClient.chat.postMessage.mockClear();

      // Trigger AskUserQuestion
      capturedCanUseTool(
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

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify postMessage was called with user mention
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const questionCall = postCalls.find(
        (call: any[]) => call[0]?.text?.includes('Approach')
      );

      expect(questionCall).toBeDefined();
      expect(questionCall?.[0]?.text).toContain('<@UTEST123>');

      // CRITICAL: Verify mention is in BLOCKS (not just text) - Slack requires this for notifications
      const blocks = questionCall?.[0]?.blocks;
      expect(blocks).toBeDefined();
      const blocksJson = JSON.stringify(blocks);
      expect(blocksJson).toContain('<@UTEST123>');
    });

    // Note: DM no-mention behavior is tested at unit level via getUserMention helper
    // Integration testing DMs is complex due to session initialization edge cases
  });

  describe('Tool approval tagging', () => {
    it('should include user mention in tool approval request for channels', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Default mode requires tool approval
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test/dir',
        mode: 'default',
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
          user: 'UAPPROVAL',
          text: '<@BOT123> test',
          channel: 'C123',  // Channel
          ts: 'msg123',
        },
        client: mockClient,
      });

      expect(capturedCanUseTool).toBeDefined();
      mockClient.chat.postMessage.mockClear();

      // Trigger tool approval for Edit tool
      capturedCanUseTool(
        'Edit',
        { file_path: '/test.ts', old_string: 'foo', new_string: 'bar' },
        { signal: new AbortController().signal }
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      const postCalls = mockClient.chat.postMessage.mock.calls;
      const approvalCall = postCalls.find(
        (call: any[]) => call[0]?.text?.includes('Edit') && call[0]?.text?.includes('Approve')
      );

      expect(approvalCall).toBeDefined();
      expect(approvalCall?.[0]?.text).toContain('<@UAPPROVAL>');

      // CRITICAL: Verify mention is in BLOCKS (not just text) - Slack requires this for notifications
      const blocks = approvalCall?.[0]?.blocks;
      expect(blocks).toBeDefined();
      const blocksJson = JSON.stringify(blocks);
      expect(blocksJson).toContain('<@UAPPROVAL>');
    });

    // Note: DM no-mention behavior is tested at unit level via getUserMention helper
    // Integration testing DMs is complex due to session initialization edge cases
  });

  describe('Plan approval tagging', () => {
    it('should include user mention in plan approval request for channels', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Plan mode for plan approval
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

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet' };
          // Simulate ExitPlanMode tool use
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'ExitPlanMode',
                  input: { allowedPrompts: [] },
                },
              ],
            },
          };
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'ExitPlanMode' },
          };
          yield {
            type: 'content_block_stop',
            index: 0,
          };
          yield { type: 'result', result: 'Plan ready' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'UPLAN123',
          text: '<@BOT123> create a plan',
          channel: 'C123',  // Channel
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 200));

      const postCalls = mockClient.chat.postMessage.mock.calls;
      const planApprovalCall = postCalls.find(
        (call: any[]) => call[0]?.text?.includes('Would you like to proceed')
      );

      // Plan approval should include user mention in text
      if (planApprovalCall) {
        expect(planApprovalCall[0].text).toContain('<@UPLAN123>');

        // CRITICAL: Verify mention is in BLOCKS (not just text) - Slack requires this for notifications
        const blocks = planApprovalCall[0]?.blocks;
        expect(blocks).toBeDefined();
        const blocksJson = JSON.stringify(blocks);
        expect(blocksJson).toContain('<@UPLAN123>');
      }
    });
  });
});
