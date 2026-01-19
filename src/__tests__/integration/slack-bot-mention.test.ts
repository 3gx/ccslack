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

describe('slack-bot mention handlers', () => {
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

  describe('app_mention event', () => {
    it('should register app_mention handler', async () => {
      // Verify event handler was registered
      expect(registeredHandlers['event_app_mention']).toBeDefined();
    });

    it('should add eyes reaction immediately and remove after command completes', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
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
          user: 'U123',
          text: '<@BOT123> /status',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Eyes should be added first
      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Eyes should be removed after command completes
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Verify order: add called before remove
      const addCall = mockClient.reactions.add.mock.invocationCallOrder[0];
      const removeCall = mockClient.reactions.remove.mock.invocationCallOrder[0];
      expect(addCall).toBeLessThan(removeCall);
    });

    it('should post header with mode for commands', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session with plan mode
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
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
          user: 'U123',
          text: '<@BOT123> /status',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post header with mode before command response
      const postCalls = mockClient.chat.postMessage.mock.calls;
      expect(postCalls.length).toBeGreaterThanOrEqual(2);

      // First post should be header with mode
      const headerCall = postCalls[0][0];
      expect(headerCall.channel).toBe('C123');
      expect(headerCall.blocks).toBeDefined();
      expect(headerCall.blocks[0].type).toBe('context');
      expect(headerCall.blocks[0].elements[0].text).toBe('_Plan_');
    });

    it('should show current mode in header for different modes', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session with bypassPermissions mode
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
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
          text: '<@BOT123> /status',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // First post should be header with current mode (bypass)
      const headerCall = mockClient.chat.postMessage.mock.calls[0][0];
      expect(headerCall.blocks[0].elements[0].text).toBe('_Bypass_');
    });

    it('should add eyes reaction for Claude messages and remove when done', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // startClaudeQuery mock is already set up in beforeEach

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Eyes should be added
      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Eyes should be removed after Claude response
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });
    });

    it('should post header message with mode and Abort button', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // Mock startClaudeQuery to return an async generator
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet-4-5-20250929' },
        { type: 'result', result: 'Test response' },
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
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Verify combined status message was posted
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      expect(postMessageCalls.length).toBeGreaterThanOrEqual(1); // Combined message + response

      // First postMessage should be the combined status message (activity log + status panel)
      const combinedCall = postMessageCalls[0][0];
      expect(combinedCall.channel).toBe('C123');
      expect(combinedCall.text).toBe('Claude is starting...');

      // Verify combined blocks: activity section + divider + status panel (3 blocks)
      const blocks = combinedCall.blocks;
      expect(blocks).toBeDefined();
      expect(blocks.length).toBe(5); // activity section + divider + 3 status panel blocks

      // First block: activity log section
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text.text).toContain('Analyzing request');

      // Second block: divider
      expect(blocks[1].type).toBe('divider');

      // Third block: status header section
      expect(blocks[2].type).toBe('section');
      expect(blocks[2].text.text).toContain('Claude is working');

      // Fourth block: status context with mode
      expect(blocks[3].type).toBe('context');
      expect(blocks[3].elements[0].text).toContain('Plan');

      // Fifth block: Abort button
      expect(blocks[4].type).toBe('actions');
      expect(blocks[4].elements[0].type).toBe('button');
      expect(blocks[4].elements[0].text.text).toBe('Abort');
      expect(blocks[4].elements[0].style).toBe('danger');
      expect(blocks[4].elements[0].action_id).toMatch(/^abort_query_/);
    });

    it('should update header with stats on success', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // Mock startClaudeQuery to return successful response with stats
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Success!', duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 200 } },
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
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Both messages should be posted then updated (not deleted)
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalled();
      expect(mockClient.chat.delete).not.toHaveBeenCalled();

      // Verify chat.update was called with complete status and stats
      const updateCalls = mockClient.chat.update.mock.calls;
      // Find the combined completion update (has 'Complete' somewhere in blocks)
      const statusPanelComplete = updateCalls.find((call: any) =>
        call[0].blocks?.some((b: any) => b.text?.text?.includes('Complete'))
      );
      expect(statusPanelComplete).toBeDefined();

      // Combined completion blocks structure:
      // 0: collapsed activity summary section
      // 1: actions (View Log / Download)
      // 2: divider
      // 3: completion status section (with "Complete")
      // 4: context with stats
      const completeBlocks = statusPanelComplete![0].blocks;

      // Find the status section with "Complete"
      const statusSection = completeBlocks.find((b: any) => b.text?.text?.includes('Complete'));
      expect(statusSection).toBeDefined();

      // Find the context block with stats
      const contextBlock = completeBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Plan'));
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain('claude-sonnet');
      expect(contextBlock.elements[0].text).toContain('Plan');
      expect(contextBlock.elements[0].text).toContain('100');  // input tokens
      expect(contextBlock.elements[0].text).toContain('200');  // output tokens
      expect(contextBlock.elements[0].text).toContain('5.0s');
    });

    it('should post response after processing', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Hello from Claude!' },
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
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post: 1) combined status message, 2) response
      const postCalls = mockClient.chat.postMessage.mock.calls;
      expect(postCalls.length).toBe(2);

      // Second call should be the response
      const responseCall = postCalls[1][0];
      expect(responseCall.text).toBe('Hello from Claude!');
    });

    it('should upload .md file without initial_comment and post text separately', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'file-msg-ts' }] } },
        }],
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: '# Hello\n\nThis is **markdown**' },
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
          user: 'U123',
          text: '<@BOT123> show table',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should upload .md and .png files WITHOUT initial_comment
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: undefined,
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              file: expect.any(Buffer),  // Markdown as Buffer
              filename: expect.stringMatching(/^response-\d+\.md$/),
              title: 'Full Response (Markdown)',
            }),
          ]),
        })
      );
      // Verify initial_comment is NOT present
      const uploadCall = mockClient.files.uploadV2.mock.calls[0][0] as any;
      expect(uploadCall.initial_comment).toBeUndefined();

      // Text should be posted separately via chat.postMessage
      const postCalls = mockClient.chat.postMessage.mock.calls;
      // Response text should be posted (after combined status message)
      const responseCall = postCalls.find((call: any) => call[0].text?.includes('Hello'));
      expect(responseCall).toBeDefined();
    });

    it('should fall back to chat.postMessage when file upload fails', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Fallback response' },
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
          user: 'U123',
          text: '<@BOT123> test',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should fall back to posting response via chat.postMessage
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const responseCall = postCalls.find((call: any) => call[0].text === 'Fallback response');
      expect(responseCall).toBeDefined();
    });

    it('should upload .md file in thread and post text separately', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'thread-file-ts' }] } },
        }],
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'parent-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: 'thread-session',
          forkedFrom: 'parent-session',
          workingDir: '/test',
          mode: 'default',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
        },
        isNewFork: false,
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'thread-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Thread response' },
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
          user: 'U123',
          text: '<@BOT123> reply in thread',
          channel: 'C123',
          ts: 'msg456',
          thread_ts: 'thread123',
        },
        client: mockClient,
      });

      // Should upload .md and .png files to the thread WITHOUT initial_comment
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              file: expect.any(Buffer),  // Markdown as Buffer
              filename: expect.stringMatching(/^response-\d+\.md$/),
              title: 'Full Response (Markdown)',
            }),
          ]),
        })
      );
      // Verify initial_comment is NOT present
      const uploadCall = mockClient.files.uploadV2.mock.calls[0][0] as any;
      expect(uploadCall.initial_comment).toBeUndefined();

      // Text should be posted separately via chat.postMessage
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const responseCall = postCalls.find((call: any) =>
        call[0].text?.includes('Thread response') &&
        call[0].thread_ts === 'thread123'
      );
      expect(responseCall).toBeDefined();
    });
  });

});
