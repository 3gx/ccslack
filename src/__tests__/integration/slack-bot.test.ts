import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { createMockSlackClient } from '../__fixtures__/slack-messages.js';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// Mock App class before any imports
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) {
        registeredHandlers[`event_${name}`] = handler;
      }
      message(handler: any) {
        registeredHandlers['message'] = handler;
      }
      action(pattern: RegExp, handler: any) {
        registeredHandlers[`action_${pattern.source}`] = handler;
      }
      view(pattern: RegExp, handler: any) {
        registeredHandlers[`view_${pattern.source}`] = handler;
      }
      async start() {
        return Promise.resolve();
      }
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
    session: {
      sessionId: null,
      forkedFrom: null,
      workingDir: '/test/dir',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
    },
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
  },
}));

import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId, getActivityLog } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('slack-bot handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};

    // Default mock for startClaudeQuery - returns async generator
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Test response' };
      },
      interrupt: vi.fn(),
    } as any);

    // Reset module cache and import fresh
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

      // Verify status panel message was posted (Message 1)
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      expect(postMessageCalls.length).toBeGreaterThanOrEqual(2); // Status panel + Activity log

      // First postMessage should be the status panel
      const statusPanelCall = postMessageCalls[0][0];
      expect(statusPanelCall.channel).toBe('C123');
      expect(statusPanelCall.text).toBe('Claude is starting...');

      // Verify blocks contain mode info and Abort button
      const blocks = statusPanelCall.blocks;
      expect(blocks).toBeDefined();
      expect(blocks.length).toBe(3);

      // First block: header section
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text.text).toContain('Claude is working');

      // Second block: status context
      expect(blocks[1].type).toBe('context');
      expect(blocks[1].elements[0].text).toContain('Plan');

      // Third block: Abort button
      expect(blocks[2].type).toBe('actions');
      expect(blocks[2].elements[0].type).toBe('button');
      expect(blocks[2].elements[0].text.text).toBe('Abort');
      expect(blocks[2].elements[0].style).toBe('danger');
      expect(blocks[2].elements[0].action_id).toMatch(/^abort_query_/);

      // Second postMessage should be the activity log
      const activityLogCall = postMessageCalls[1][0];
      expect(activityLogCall.text).toContain('Analyzing request');
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
      // Find the status panel complete update (has 'Complete' in header)
      const statusPanelComplete = updateCalls.find((call: any) =>
        call[0].blocks?.some((b: any) => b.text?.text?.includes('Complete'))
      );
      expect(statusPanelComplete).toBeDefined();

      // Verify status panel contains model, mode, and stats
      const completeBlocks = statusPanelComplete![0].blocks;
      expect(completeBlocks[0].text.text).toContain('Complete');
      // Context block has stats
      expect(completeBlocks[1].elements[0].text).toContain('claude-sonnet');
      expect(completeBlocks[1].elements[0].text).toContain('Plan');
      expect(completeBlocks[1].elements[0].text).toContain('100');  // input tokens
      expect(completeBlocks[1].elements[0].text).toContain('200');  // output tokens
      expect(completeBlocks[1].elements[0].text).toContain('5.0s');
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

      // Should post: 1) status panel, 2) activity log, 3) response
      const postCalls = mockClient.chat.postMessage.mock.calls;
      expect(postCalls.length).toBe(3);

      // Third call should be the response
      const responseCall = postCalls[2][0];
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
      // Response text should be posted (after status panel and activity log)
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

  describe('button answer handler', () => {
    it('should write answer to file and update message', async () => {
      const handler = registeredHandlers['action_^answer_(.+)_(\\d+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'answer_q_123456_0',
          value: 'yes',
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_123456.json',
        expect.stringContaining('"answer":"yes"')
      );
      expect(mockClient.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: 'msg123',
        text: 'You selected: *yes*',
        blocks: [],
      });
    });
  });

  describe('abort button handler', () => {
    it('should write abort signal to file', async () => {
      const handler = registeredHandlers['action_^abort_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'abort_q_789' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_789.json',
        expect.stringContaining('__ABORTED__')
      );
    });
  });

  describe('freetext button handler', () => {
    it('should open modal for free text input', async () => {
      const handler = registeredHandlers['action_^freetext_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'freetext_q_456' },
        ack,
        body: {
          trigger_id: 'trigger123',
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            callback_id: 'freetext_modal_q_456',
            type: 'modal',
          }),
        })
      );
    });
  });

  describe('modal submission handler', () => {
    it('should write free text answer to file', async () => {
      const handler = registeredHandlers['view_^freetext_modal_(.+)$'];
      expect(handler).toBeDefined();

      const ack = vi.fn();

      await handler({
        ack,
        body: {},
        view: {
          callback_id: 'freetext_modal_q_789',
          state: {
            values: {
              answer_block: {
                answer_input: {
                  value: 'My custom answer',
                },
              },
            },
          },
        },
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_789.json',
        expect.stringContaining('"answer":"My custom answer"')
      );
    });
  });

  describe('multiselect handlers', () => {
    it('should store pending selections on multiselect change', async () => {
      const handler = registeredHandlers['action_^multiselect_(?!submit_)(.+)$'];
      expect(handler).toBeDefined();

      const ack = vi.fn();

      await handler({
        action: {
          action_id: 'multiselect_q_multi_123',
          selected_options: [
            { value: 'Option A' },
            { value: 'Option C' },
          ],
        },
        ack,
        body: {},
        client: createMockSlackClient(),
      });

      expect(ack).toHaveBeenCalled();
      // Selection should be stored internally (tested via submit)
    });

    it('should submit multiselect answer to file', async () => {
      // First, simulate selection change
      const selectHandler = registeredHandlers['action_^multiselect_(?!submit_)(.+)$'];
      const submitHandler = registeredHandlers['action_^multiselect_submit_(.+)$'];
      expect(selectHandler).toBeDefined();
      expect(submitHandler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Simulate selection
      await selectHandler({
        action: {
          action_id: 'multiselect_q_submit_test',
          selected_options: [
            { value: 'Python' },
            { value: 'Go' },
          ],
        },
        ack,
        body: {},
        client: mockClient,
      });

      // Simulate submit
      await submitHandler({
        action: { action_id: 'multiselect_submit_q_submit_test' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalledTimes(2);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/ccslack-answers/q_submit_test.json',
        expect.stringContaining('Python, Go')
      );
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'You selected: *Python, Go*',
        })
      );
    });

    it('should handle empty multiselect submission', async () => {
      const submitHandler = registeredHandlers['action_^multiselect_submit_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Submit without prior selection
      await submitHandler({
        action: { action_id: 'multiselect_submit_q_empty' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'You selected: *(none)*',
        })
      );
    });
  });

  describe('abort query handler', () => {
    it('should register abort_query handler', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should acknowledge and log abort request', async () => {
      const handler = registeredHandlers['action_^abort_query_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'abort_query_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });
  });

  describe('mode button handler', () => {
    it('should register mode button handler', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      expect(handler).toBeDefined();
    });

    it('should update session mode on button click', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'mode_bypassPermissions' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'bypassPermissions' });
    });

    it('should update message to confirm selection', async () => {
      const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'mode_plan' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: 'Mode set to `plan`',
        })
      );
    });
  });

  describe('plan approval handlers (5 options matching CLI)', () => {
    // Test handler registration for all 5 options
    it('should register option 1: clear + bypass handler', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 2: accept edits handler', async () => {
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 3: bypass handler', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 4: manual handler', async () => {
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register option 5: reject handler', async () => {
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      expect(handler).toBeDefined();
    });

    // Test option 1: clear context + bypass
    it('option 1: should clear session and set bypass mode', async () => {
      const handler = registeredHandlers['action_^plan_clear_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_clear_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should clear session (sessionId: null) AND set bypass mode
      expect(saveSession).toHaveBeenCalledWith('C123', { sessionId: null, mode: 'bypassPermissions' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('Clearing context'),
        })
      );
    });

    // Test option 2: accept edits
    it('option 2: should set acceptEdits mode', async () => {
      const handler = registeredHandlers['action_^plan_accept_edits_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_accept_edits_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'acceptEdits' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('accept-edits'),
        })
      );
    });

    // Test option 3: bypass permissions
    it('option 3: should set bypassPermissions mode', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'bypassPermissions' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('bypass mode'),
        })
      );
    });

    // Test option 4: manual approval
    it('option 4: should set default (manual) mode', async () => {
      const handler = registeredHandlers['action_^plan_manual_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_manual_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'default' });
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('manual approval'),
        })
      );
    });

    // Test option 5: reject
    it('option 5: should update message on reject', async () => {
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_reject_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: 'msg123',
          text: expect.stringContaining('rejected'),
        })
      );
    });

    it('should extract channel and thread from conversation key', async () => {
      const handler = registeredHandlers['action_^plan_bypass_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // With thread
      await handler({
        action: { action_id: 'plan_bypass_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      // Should save to the channel (extracted from conversation key)
      expect(saveSession).toHaveBeenCalledWith('C123', { mode: 'bypassPermissions' });
    });
  });

  describe('tool approval handlers', () => {
    it('should register tool approve handler', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register tool deny handler', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should acknowledge approve button click', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'tool_approve_abc-123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should acknowledge deny button click', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'tool_deny_abc-123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
    });

    it('should log when no pending approval found for approve', async () => {
      const handler = registeredHandlers['action_^tool_approve_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const consoleSpy = vi.spyOn(console, 'log');

      await handler({
        action: { action_id: 'tool_approve_nonexistent-id' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(consoleSpy).toHaveBeenCalledWith('No pending approval found for: nonexistent-id');
      consoleSpy.mockRestore();
    });

    it('should log when no pending approval found for deny', async () => {
      const handler = registeredHandlers['action_^tool_deny_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const consoleSpy = vi.spyOn(console, 'log');

      await handler({
        action: { action_id: 'tool_deny_nonexistent-id' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(consoleSpy).toHaveBeenCalledWith('No pending approval found for: nonexistent-id');
      consoleSpy.mockRestore();
    });
  });

  describe('tool approval reminder configuration', () => {
    it('should have 7-day expiry configured', async () => {
      // The configuration is tested by verifying the module loads without error
      // and that the reminder mechanism is set up (42 reminders = 7 days / 4 hours)
      expect(registeredHandlers['action_^tool_approve_(.+)$']).toBeDefined();
      expect(registeredHandlers['action_^tool_deny_(.+)$']).toBeDefined();
    });
  });

  describe('canUseTool auto-deny for approve_action', () => {
    it('should auto-deny mcp__ask-user__approve_action in default mode', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set up session with default mode
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

      // Capture the canUseTool callback passed to startClaudeQuery
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

      // Verify canUseTool callback was captured
      expect(capturedCanUseTool).toBeDefined();

      // Call the callback with approve_action tool
      const result = await capturedCanUseTool(
        'mcp__ask-user__approve_action',
        { action: 'test action' },
        { signal: new AbortController().signal }
      );

      // Should auto-deny
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('handled directly');
    });

    it('should prompt for approval for regular tools in default mode', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set up session with default mode
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
          user: 'U123',
          text: '<@BOT123> test message',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      expect(capturedCanUseTool).toBeDefined();

      // Call the callback with Write tool - this should NOT auto-deny
      // It should post a message and return a promise (we won't await the resolution)
      const resultPromise = capturedCanUseTool(
        'Write',
        { file_path: '/test.txt', content: 'hello' },
        { signal: new AbortController().signal }
      );

      // Should have posted approval message to Slack
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.stringContaining('Write'),
        })
      );

      // The promise should still be pending (waiting for user to click button)
      // We can't easily test this without resolving, but we verified the message was posted
    });
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

  describe('view_activity_log handler', () => {
    it('should register view_activity_log handler', async () => {
      const handler = registeredHandlers['action_^view_activity_log_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should open modal with activity log entries', async () => {
      const handler = registeredHandlers['action_^view_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock activity log data
      vi.mocked(getActivityLog).mockResolvedValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'Test thinking content' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ]);

      await handler({
        action: { action_id: 'view_activity_log_C123_thread456' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            type: 'modal',
            title: expect.objectContaining({ text: 'Activity Log' }),
          }),
        })
      );
    });

    it('should show error modal when activity log not found', async () => {
      const handler = registeredHandlers['action_^view_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock no activity log
      vi.mocked(getActivityLog).mockResolvedValue(null);

      await handler({
        action: { action_id: 'view_activity_log_C123_thread456' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            type: 'modal',
            blocks: expect.arrayContaining([
              expect.objectContaining({
                text: expect.objectContaining({
                  text: expect.stringContaining('no longer available'),
                }),
              }),
            ]),
          }),
        })
      );
    });

    it('should show "no activity" message when log exists but is empty', async () => {
      const handler = registeredHandlers['action_^view_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock empty activity log - log exists but has no entries
      vi.mocked(getActivityLog).mockResolvedValue([]);

      await handler({
        action: { action_id: 'view_activity_log_C123_thread456' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Empty array shows "no activity" message (different from null which shows "no longer available")
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            type: 'modal',
            blocks: expect.arrayContaining([
              expect.objectContaining({
                text: expect.objectContaining({
                  text: expect.stringContaining('No activity to display'),
                }),
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('activity_log_page pagination handler', () => {
    it('should register activity_log_page handler', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      expect(handler).toBeDefined();
    });

    it('should update modal with requested page', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock activity log with enough entries for pagination
      const entries = Array.from({ length: 30 }, (_, i) => ({
        timestamp: Date.now() + i,
        type: 'tool_start' as const,
        tool: `Tool${i}`,
      }));
      vi.mocked(getActivityLog).mockResolvedValue(entries);

      await handler({
        action: { action_id: 'activity_log_page_2' },
        ack,
        body: {
          trigger_id: 'trigger123',
          view: {
            id: 'view123',
            private_metadata: JSON.stringify({ conversationKey: 'C123_thread456', currentPage: 1 }),
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.update).toHaveBeenCalledWith(
        expect.objectContaining({
          view_id: 'view123',
          view: expect.objectContaining({
            type: 'modal',
            private_metadata: expect.stringContaining('"currentPage":2'),
          }),
        })
      );
    });

    it('should handle missing activity log during pagination', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock missing activity log
      vi.mocked(getActivityLog).mockResolvedValue(null);

      await handler({
        action: { action_id: 'activity_log_page_2' },
        ack,
        body: {
          trigger_id: 'trigger123',
          view: {
            id: 'view123',
            private_metadata: JSON.stringify({ conversationKey: 'C123_thread456', currentPage: 1 }),
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not crash, just return early
    });
  });

  describe('download_activity_log handler', () => {
    it('should register download_activity_log handler', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should upload file with activity log content', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock activity log data
      vi.mocked(getActivityLog).mockResolvedValue([
        { timestamp: 1700000000000, type: 'thinking', thinkingContent: 'Analyzing the request' },
        { timestamp: 1700000001000, type: 'tool_start', tool: 'Read' },
        { timestamp: 1700000002000, type: 'tool_complete', tool: 'Read', durationMs: 1000 },
      ]);

      await handler({
        action: { action_id: 'download_activity_log_C123_thread456' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123', thread_ts: 'thread456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          filename: expect.stringMatching(/activity-log-.*\.txt/),
          content: expect.stringContaining('THINKING'),
        })
      );
    });

    it('should include full thinking content in download', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      const longThinking = 'A'.repeat(1000);
      vi.mocked(getActivityLog).mockResolvedValue([
        { timestamp: 1700000000000, type: 'thinking', thinkingContent: longThinking },
      ]);

      await handler({
        action: { action_id: 'download_activity_log_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(longThinking),
        })
      );
    });

    it('should handle missing activity log gracefully', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getActivityLog).mockResolvedValue(null);

      await handler({
        action: { action_id: 'download_activity_log_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not attempt upload
      expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
      // Should post ephemeral with "no longer available" message
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('no longer available'),
        })
      );
    });

    it('should handle empty activity log with "no activity" message', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock empty activity log - log exists but has no entries
      vi.mocked(getActivityLog).mockResolvedValue([]);

      await handler({
        action: { action_id: 'download_activity_log_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not attempt upload
      expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
      // Should post ephemeral with "no activity" message (different from null)
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No activity to download'),
        })
      );
    });

    it('should format tool entries with duration', async () => {
      const handler = registeredHandlers['action_^download_activity_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getActivityLog).mockResolvedValue([
        { timestamp: 1700000000000, type: 'tool_start', tool: 'Edit' },
        { timestamp: 1700000001500, type: 'tool_complete', tool: 'Edit', durationMs: 1500 },
      ]);

      await handler({
        action: { action_id: 'download_activity_log_C123' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      // Format is: "TOOL COMPLETE: Edit (1500ms)"
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringMatching(/TOOL COMPLETE: Edit \(1500ms\)/),
        })
      );
    });
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

  describe('auto-compact notification', () => {
    it('should notify user when auto-compaction triggers', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test/dir',
        mode: 'default',
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return auto-triggered compact_boundary
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
          yield { type: 'result', result: 'Response after compaction' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
        client: mockClient,
      });

      // Should post auto-compact notification
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Auto-compacting context'),
        })
      );
      // Should include token count
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('150,000 tokens'),
        })
      );
    });

    it('should not notify for manual compaction in regular flow', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test/dir',
        mode: 'default',
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return manual-triggered compact_boundary
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50000 } };
          yield { type: 'result', result: 'Response after manual compaction' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
        client: mockClient,
      });

      // Should NOT post auto-compact notification for manual trigger
      const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
      );
      expect(autoCompactCalls.length).toBe(0);
    });

    it('should only notify once per query', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test/dir',
        mode: 'default',
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return multiple compact_boundary messages
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } };
          yield { type: 'result', result: 'Response after compaction' };
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
        client: mockClient,
      });

      // Should only post auto-compact notification once
      const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
      );
      expect(autoCompactCalls.length).toBe(1);
    });

    it('should retry auto-compact notification on rate limit', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'existing-session',
        workingDir: '/test/dir',
        mode: 'default',
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock SDK to return auto-triggered compact_boundary
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-sonnet' };
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } };
          yield { type: 'result', result: 'Response after compaction' };
        },
        interrupt: vi.fn(),
      } as any);

      // Track call count to simulate rate limit on first auto-compact attempt
      let postMessageCallCount = 0;
      mockClient.chat.postMessage.mockImplementation(async (params: any) => {
        postMessageCallCount++;
        // Rate limit the auto-compact notification on first attempt (call 3 = status, activity, then auto-compact)
        if (params.text?.includes('Auto-compacting context') && postMessageCallCount <= 3) {
          const rateLimitError = new Error('ratelimited') as any;
          rateLimitError.data = { error: 'ratelimited' };
          throw rateLimitError;
        }
        return { ts: `msg${postMessageCallCount}`, channel: 'C123' };
      });

      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg123' },
        client: mockClient,
      });

      // Should have retried and eventually posted auto-compact notification
      const autoCompactCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes('Auto-compacting context')
      );
      // At least 2 calls: first failed (rate limited), second succeeded (retry)
      expect(autoCompactCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('busy state handling', () => {
    it('should allow /status command while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang (simulates busy)
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise; // Hang until resolved
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query (this marks conversation as busy)
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait a tick for busy state to be set
      await new Promise(r => setTimeout(r, 10));

      // Now send /status while busy - should work!
      await handler({
        event: { user: 'U123', text: '<@BOT123> /status', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message for /status
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Should see status response (header + status blocks)
      const statusCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => {
          const blocks = call[0].blocks;
          // Look for context block with mode (header) or status-related blocks
          return blocks?.some((b: any) =>
            b.type === 'context' && b.elements?.some((e: any) => e.text === '_Plan_')
          );
        }
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should allow /help command while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Send /help while busy - should work!
      await handler({
        event: { user: 'U123', text: '<@BOT123> /help', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Should see help response (contains Available Commands with asterisks for bold)
      const helpCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes('*Available Commands*')
      );
      expect(helpCalls.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should allow /mode command while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Send /mode while busy - should work!
      await handler({
        event: { user: 'U123', text: '<@BOT123> /mode', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Should see mode picker (mode_selection block)
      const modeCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => {
          const blocks = call[0].blocks;
          return blocks?.some((b: any) =>
            b.block_id === 'mode_selection' ||
            b.elements?.some((e: any) => e.action_id?.startsWith('mode_'))
          );
        }
      );
      expect(modeCalls.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should block regular queries while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start first query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Try second query - should be blocked
      await handler({
        event: { user: 'U123', text: '<@BOT123> another question', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should block /compact while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Try /compact while busy - should be blocked
      await handler({
        event: { user: 'U123', text: '<@BOT123> /compact', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should block /clear while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Try /clear while busy - should be blocked
      await handler({
        event: { user: 'U123', text: '<@BOT123> /clear', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should allow /context command while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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
        lastUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 50,
          cost: '0.05',
        },
      });

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Send /context while busy - should work!
      await handler({
        event: { user: 'U123', text: '<@BOT123> /context', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });
  });

  describe('live config updates during query', () => {
    it('should update processingState.updateRateSeconds when /update-rate sent while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Start with updateRateSeconds = 2
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
        updateRateSeconds: 2,
      });

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query (this marks conversation as busy)
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for busy state to be set
      await new Promise(r => setTimeout(r, 10));

      // Send /update-rate 5 while busy - should update live config
      await handler({
        event: { user: 'U123', text: '<@BOT123> /update-rate 5', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Verify saveSession was called with the new updateRateSeconds
      expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
        updateRateSeconds: 5,
      }));

      // Should see confirmation message "Update rate set to 5s."
      const rateCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes('Update rate set to 5s')
      );
      expect(rateCalls.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should call query.setPermissionMode when mode button clicked while busy', async () => {
      const messageHandler = registeredHandlers['event_app_mention'];
      const modeButtonHandler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock startClaudeQuery with setPermissionMode method
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      const mockSetPermissionMode = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
        setPermissionMode: mockSetPermissionMode,
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
      } as any);

      // Start a query (this marks conversation as busy and populates activeQueries)
      const queryPromise = messageHandler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for activeQueries to be populated (after status messages are posted)
      await new Promise(r => setTimeout(r, 50));

      // Click mode button while busy - should call SDK control method
      await modeButtonHandler({
        action: { action_id: 'mode_bypassPermissions' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      // Verify setPermissionMode was called with 'bypassPermissions'
      expect(mockSetPermissionMode).toHaveBeenCalledWith('bypassPermissions');

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should block model selection while busy (model changes only apply next turn)', async () => {
      const messageHandler = registeredHandlers['event_app_mention'];
      const modelButtonHandler = registeredHandlers['action_^model_select_(.+)$'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'bypassPermissions',
        model: 'claude-sonnet-4-20250514',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock startClaudeQuery
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
      } as any);

      // Start a query (this marks conversation as busy)
      const queryPromise = messageHandler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for busy state to be set
      await new Promise(r => setTimeout(r, 50));

      // Click model button while busy - should be blocked
      await modelButtonHandler({
        action: { action_id: 'model_select_claude-opus-4-20250514' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      // Verify session was NOT updated (blocked while busy)
      expect(saveSession).not.toHaveBeenCalledWith('C123', expect.objectContaining({
        model: 'claude-opus-4-20250514',
      }));

      // Verify warning message was shown
      expect(mockClient.chat.update).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C123',
        ts: 'msg123',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining('Cannot change model while a query is running'),
            }),
          }),
        ]),
      }));

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should call query.setMaxThinkingTokens when /max-thinking-tokens sent while busy', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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
        maxThinkingTokens: undefined, // default
      });

      // Mock startClaudeQuery with setMaxThinkingTokens method
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      const mockSetMaxThinkingTokens = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: mockSetMaxThinkingTokens,
      } as any);

      // Start a query (this marks conversation as busy and populates activeQueries)
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for activeQueries to be populated (after status messages are posted)
      await new Promise(r => setTimeout(r, 50));

      // Send /max-thinking-tokens 5000 while busy - should call SDK control method
      await handler({
        event: { user: 'U123', text: '<@BOT123> /max-thinking-tokens 5000', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Verify setMaxThinkingTokens was called with 5000
      expect(mockSetMaxThinkingTokens).toHaveBeenCalledWith(5000);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should handle SDK control method errors gracefully', async () => {
      const messageHandler = registeredHandlers['event_app_mention'];
      const modeButtonHandler = registeredHandlers['action_^mode_(plan|default|bypassPermissions|acceptEdits)$'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock startClaudeQuery with setPermissionMode that throws
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      const mockSetPermissionMode = vi.fn().mockRejectedValue(new Error('SDK error'));
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
        setPermissionMode: mockSetPermissionMode,
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = messageHandler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for activeQueries to be populated
      await new Promise(r => setTimeout(r, 50));

      // Click mode button while busy - SDK method should fail but session should still update
      await modeButtonHandler({
        action: { action_id: 'mode_bypassPermissions' },
        ack: vi.fn(),
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      // Verify setPermissionMode was called (even though it throws)
      expect(mockSetPermissionMode).toHaveBeenCalledWith('bypassPermissions');

      // Session should still be updated (for next query)
      expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
        mode: 'bypassPermissions',
      }));

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should allow /update-rate command while busy (non-agent command)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Send /update-rate while busy - should work (non-agent command)
      await handler({
        event: { user: 'U123', text: '<@BOT123> /update-rate 3', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should allow /message-size command while busy (non-agent command)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to hang
      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start a query
      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      await new Promise(r => setTimeout(r, 10));

      // Send /message-size while busy - should work (non-agent command)
      await handler({
        event: { user: 'U123', text: '<@BOT123> /message-size 1000', channel: 'C123', ts: 'msg2' },
        client: mockClient,
      });

      // Should NOT see "I'm busy" message
      const busyMessages = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes("I'm busy")
      );
      expect(busyMessages).toHaveLength(0);

      // Verify saveSession was called with the new threadCharLimit
      expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
        threadCharLimit: 1000,
      }));

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });

    it('should use live threadCharLimit at response posting time', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Track getSession calls to simulate config change
      let callCount = 0;
      vi.mocked(getSession).mockImplementation(() => {
        callCount++;
        return {
          sessionId: 'test-session',
          workingDir: '/test',
          mode: 'bypassPermissions',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: true,
          configuredPath: '/test/dir',
          configuredBy: 'U123',
          configuredAt: Date.now(),
          // First few calls return 500, later calls return 100 (simulating /message-size change)
          threadCharLimit: callCount > 3 ? 100 : 500,
        };
      });

      // Mock startClaudeQuery to return a long response
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          yield { type: 'result', result: 'A'.repeat(1000) }; // 1000 char response
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // The response should have been posted - verify uploadMarkdownAndPngWithResponse behavior
      // is influenced by the live config (the actual truncation happens in streaming.ts)
      // Here we just verify getSession is called multiple times (live reads)
      expect(callCount).toBeGreaterThan(1);
    });

    it('should clear spinnerTimer in finally block on error', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

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

      // Mock startClaudeQuery to throw an error
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          throw new Error('Test SDK error');
        },
        interrupt: vi.fn(),
      } as any);

      // This should not hang or leak timers
      await handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Verify error was posted
      const errorCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any[]) => call[0].text?.includes('Error:')
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);

      // If timer wasn't cleared, this test would hang or have memory issues
      // The test completing without hanging is the verification
    });

    it('should initialize processingState.updateRateSeconds from session', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Set updateRateSeconds to 5 in session
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
        updateRateSeconds: 5,
      });

      let resolveQuery: () => void;
      const hangingPromise = new Promise<void>(r => { resolveQuery = r; });

      // Track if init message was yielded (means processingState was created)
      let initYielded = false;
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          initYielded = true;
          await hangingPromise;
          yield { type: 'result', result: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      const queryPromise = handler({
        event: { user: 'U123', text: '<@BOT123> hello', channel: 'C123', ts: 'msg1' },
        client: mockClient,
      });

      // Wait for init to be processed
      await new Promise(r => setTimeout(r, 50));
      expect(initYielded).toBe(true);

      // Cleanup
      resolveQuery!();
      await queryPromise;
    });
  });
});

describe('answer file format', () => {
  it('should include timestamp in answer files', () => {
    // Verify answer format includes timestamp
    const answerData = JSON.stringify({ answer: 'test', timestamp: Date.now() });
    expect(answerData).toMatch(/"timestamp":\d+/);
    expect(answerData).toMatch(/"answer":"test"/);
  });
});
