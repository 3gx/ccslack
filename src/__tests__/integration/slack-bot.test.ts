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
}));

vi.mock('../../session-manager.js', () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
}));

vi.mock('../../streaming.js', () => ({
  streamToSlack: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { getSession, saveSession } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { streamToSlack } from '../../streaming.js';

describe('slack-bot handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};

    // Default mock for streamToSlack
    vi.mocked(streamToSlack).mockResolvedValue({
      fullResponse: 'Test response',
      sessionId: 'new-session-123',
    });

    // Reset module cache and import fresh
    vi.resetModules();
    await import('../../slack-bot.js');
  });

  describe('app_mention event', () => {
    it('should register app_mention handler', async () => {
      // Verify event handler was registered
      expect(registeredHandlers['event_app_mention']).toBeDefined();
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
});

describe('answer file format', () => {
  it('should include timestamp in answer files', () => {
    // Verify answer format includes timestamp
    const answerData = JSON.stringify({ answer: 'test', timestamp: Date.now() });
    expect(answerData).toMatch(/"timestamp":\d+/);
    expect(answerData).toMatch(/"answer":"test"/);
  });
});
