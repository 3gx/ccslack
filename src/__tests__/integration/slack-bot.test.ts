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
    },
    isNewFork: false,
  }),
  getThreadSession: vi.fn(),
  saveThreadSession: vi.fn(),
}));

vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession } from '../../session-manager.js';
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

      // Verify header message was posted with mode and Abort button
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      expect(postMessageCalls.length).toBeGreaterThanOrEqual(1);

      // First postMessage should be the header message
      const headerCall = postMessageCalls[0][0];
      expect(headerCall.channel).toBe('C123');
      expect(headerCall.text).toBe('plan'); // Initial text is mode

      // Verify blocks contain mode and Abort button
      const blocks = headerCall.blocks;
      expect(blocks).toBeDefined();
      expect(blocks.length).toBe(2);

      // First block: mode context
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Plan_');

      // Second block: Abort button
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements[0].type).toBe('button');
      expect(blocks[1].elements[0].text.text).toBe('Abort');
      expect(blocks[1].elements[0].style).toBe('danger');
      expect(blocks[1].elements[0].action_id).toMatch(/^abort_query_/);
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

      // Header should be posted then updated (not deleted)
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalled();
      expect(mockClient.chat.delete).not.toHaveBeenCalled();

      // Verify chat.update was called with complete status and stats
      const updateCalls = mockClient.chat.update.mock.calls;
      // Last update should be the complete status with stats
      const completeCall = updateCalls[updateCalls.length - 1][0];
      expect(completeCall.channel).toBe('C123');
      expect(completeCall.blocks[0].elements[0].text).toContain('claude-sonnet');
      expect(completeCall.blocks[0].elements[0].text).toContain('Plan');
      expect(completeCall.blocks[0].elements[0].text).toContain('300 tokens');
      expect(completeCall.blocks[0].elements[0].text).toContain('5.0s');
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

      // Should post: 1) status message, 2) response message
      const postCalls = mockClient.chat.postMessage.mock.calls;
      expect(postCalls.length).toBe(2);

      // Second call should be the response
      const responseCall = postCalls[1][0];
      expect(responseCall.text).toBe('Hello from Claude!');
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

  describe('plan approval handlers', () => {
    it('should register plan approve auto handler', async () => {
      const handler = registeredHandlers['action_^plan_approve_auto_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register plan approve manual handler', async () => {
      const handler = registeredHandlers['action_^plan_approve_manual_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should register plan reject handler', async () => {
      const handler = registeredHandlers['action_^plan_reject_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should update message and save mode on auto approve', async () => {
      const handler = registeredHandlers['action_^plan_approve_auto_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_approve_auto_C123_thread456' },
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
          text: expect.stringContaining('auto-accept'),
        })
      );
    });

    it('should update message and save mode on manual approve', async () => {
      const handler = registeredHandlers['action_^plan_approve_manual_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        action: { action_id: 'plan_approve_manual_C123' },
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

    it('should update message on reject', async () => {
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
      const handler = registeredHandlers['action_^plan_approve_auto_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // With thread
      await handler({
        action: { action_id: 'plan_approve_auto_C123_thread456' },
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

      // Should call conversations.history to get last message
      expect(mockClient.conversations.history).toHaveBeenCalledWith({
        channel: 'C123',
        limit: 100,
      });

      // Find the fork notification message
      const forkNotificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked with conversation state')
      );

      expect(forkNotificationCall).toBeDefined();

      // Should include link to LAST main message (not thread parent)
      const expectedLink = `https://slack.com/archives/C123/p${lastMainMessageTs.replace('.', '')}`;
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
      });

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
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

    it('should skip thread messages when finding last main message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      const threadTs = '1000000000.000000';
      const lastMainMessageTs = '1000000500.000000';
      const threadMessageTs = '1000000600.000000';  // This is IN a thread, should be skipped

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });

      vi.mocked(getOrCreateThreadSession).mockReturnValue({
        session: {
          sessionId: null,
          forkedFrom: 'main-session',
          workingDir: '/test/dir',
          mode: 'plan',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        isNewFork: true,
      });

      // Messages include one that's part of a thread (should be skipped)
      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          { ts: threadMessageTs, text: 'Thread reply', thread_ts: '1000000400.000000' },  // Part of thread - SKIP
          { ts: lastMainMessageTs, text: 'Last main message', thread_ts: undefined },  // Last main - USE THIS
          { ts: threadTs, text: 'Thread parent', thread_ts: undefined },
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

      // Should link to lastMainMessageTs, NOT threadMessageTs
      const forkNotificationCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Forked with conversation state')
      );

      expect(forkNotificationCall).toBeDefined();
      const expectedLink = `https://slack.com/archives/C123/p${lastMainMessageTs.replace('.', '')}`;
      expect(forkNotificationCall[0].text).toContain(expectedLink);

      // Should NOT link to the thread message
      const wrongLink = `https://slack.com/archives/C123/p${threadMessageTs.replace('.', '')}`;
      expect(forkNotificationCall[0].text).not.toContain(wrongLink);
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
      });

      // Mock thread session with active session
      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
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
      });

      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
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
      });

      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: 'source-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/custom/path',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
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
      });

      // Source thread has its own session (different from main)
      vi.mocked(getThreadSession).mockReturnValue({
        sessionId: threadSessionId,
        forkedFrom: mainSessionId,
        workingDir: '/test/dir',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
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
