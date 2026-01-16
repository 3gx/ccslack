import { vi } from 'vitest';

/**
 * Test fixtures for Slack message events and interactions
 */

export const mockAppMention = {
  type: 'app_mention' as const,
  user: 'U123456',
  text: '<@U987654> help me debug this',
  channel: 'C123456',
  ts: '1234567890.123456',
  thread_ts: undefined,
};

export const mockDMMessage = {
  type: 'message' as const,
  channel_type: 'im' as const,
  user: 'U123456',
  text: 'hello bot',
  channel: 'D123456',
  ts: '1234567890.654321',
};

export const mockButtonClick = {
  type: 'block_actions' as const,
  user: { id: 'U123456' },
  actions: [{
    type: 'button',
    action_id: 'answer_q_123456789_0',
    value: 'yes',
  }],
  channel: { id: 'C123456' },
  message: { ts: 'msg123' },
  trigger_id: 'trigger123',
};

export const mockAbortButtonClick = {
  type: 'block_actions' as const,
  user: { id: 'U123456' },
  actions: [{
    type: 'button',
    action_id: 'abort_q_123456789',
    value: 'abort',
  }],
  channel: { id: 'C123456' },
  message: { ts: 'msg123' },
};

export const mockFreetextButtonClick = {
  type: 'block_actions' as const,
  user: { id: 'U123456' },
  actions: [{
    type: 'button',
    action_id: 'freetext_q_123456789',
    value: 'freetext',
  }],
  channel: { id: 'C123456' },
  message: { ts: 'msg123' },
  trigger_id: 'trigger456',
};

export const mockModalSubmission = {
  type: 'view_submission' as const,
  user: { id: 'U123456' },
  view: {
    callback_id: 'freetext_modal_q_123456789',
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
};

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
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
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
