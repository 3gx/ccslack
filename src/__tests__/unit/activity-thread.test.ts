import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postActivityToThread,
  flushActivityBatch,
  postThinkingToThread,
  postResponseToThread,
  postStartingToThread,
  postErrorToThread,
  ActivityBatchState,
} from '../../activity-thread.js';
import type { ActivityEntry } from '../../blocks.js';

// Mock streaming module
vi.mock('../../streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({
    ts: 'upload-ts-123',
    uploadSucceeded: true,
  }),
}));

import { uploadMarkdownAndPngWithResponse } from '../../streaming.js';

// Helper to create mock Slack client
function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted-ts-123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as any;
}

describe('activity-thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('postActivityToThread', () => {
    it('should post simple text message to thread', async () => {
      const client = createMockClient();

      const result = await postActivityToThread(
        client,
        'C123',
        'parent-ts',
        ':white_check_mark: *Read* [0.5s]'
      );

      expect(result).toEqual({ ts: 'posted-ts-123' });
      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: 'parent-ts',
        text: ':white_check_mark: *Read* [0.5s]',
        mrkdwn: true,
      });
    });

    it('should upload .md file when content exceeds limit', async () => {
      const client = createMockClient();
      const longContent = 'A'.repeat(1000);

      const result = await postActivityToThread(
        client,
        'C123',
        'parent-ts',
        ':brain: *Thinking* [5.0s]',
        {
          fullMarkdown: longContent,
          charLimit: 500,
          userId: 'U456',
        }
      );

      expect(result).toEqual({ ts: 'upload-ts-123' });
      expect(uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
        client,
        'C123',
        longContent,
        ':brain: *Thinking* [5.0s]',
        'parent-ts',
        'U456',
        500
      );
      // Should NOT call postMessage when uploading
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('should not upload when content under limit', async () => {
      const client = createMockClient();
      const shortContent = 'Short thinking content';

      await postActivityToThread(
        client,
        'C123',
        'parent-ts',
        ':brain: *Thinking*',
        {
          fullMarkdown: shortContent,
          charLimit: 500,
        }
      );

      // Should NOT upload since under limit
      expect(uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenCalled();
    });

    it('should return null on error', async () => {
      const client = createMockClient();
      client.chat.postMessage.mockRejectedValue(new Error('Slack API error'));

      const result = await postActivityToThread(
        client,
        'C123',
        'parent-ts',
        'Some content'
      );

      expect(result).toBeNull();
    });
  });

  describe('flushActivityBatch', () => {
    it('should post batched tool entries to thread', async () => {
      const client = createMockClient();
      const state: ActivityBatchState = {
        activityThreadMsgTs: null,
        activityBatch: [
          { timestamp: 1000, type: 'tool_complete', tool: 'Read', durationMs: 500 },
          { timestamp: 2000, type: 'tool_complete', tool: 'Edit', durationMs: 800 },
        ],
        activityBatchStartIndex: 0,
        lastActivityPostTime: 0,
        threadParentTs: 'parent-ts',
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      expect(client.chat.postMessage).toHaveBeenCalled();
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.thread_ts).toBe('parent-ts');
      expect(call.text).toContain(':white_check_mark: *Read* [0.5s]');
      expect(call.text).toContain(':white_check_mark: *Edit* [0.8s]');

      // Batch should be cleared
      expect(state.activityBatch).toEqual([]);
      // Last post time should be updated
      expect(state.lastActivityPostTime).toBeGreaterThan(0);
    });

    it('should do nothing when batch is empty', async () => {
      const client = createMockClient();
      const state: ActivityBatchState = {
        activityThreadMsgTs: null,
        activityBatch: [],
        activityBatchStartIndex: 0,
        lastActivityPostTime: 0,
        threadParentTs: 'parent-ts',
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('should warn when no thread parent', async () => {
      const client = createMockClient();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const state: ActivityBatchState = {
        activityThreadMsgTs: null,
        activityBatch: [
          { timestamp: 1000, type: 'tool_complete', tool: 'Read', durationMs: 500 },
        ],
        activityBatchStartIndex: 0,
        lastActivityPostTime: 0,
        threadParentTs: null, // No parent!
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No thread parent'));
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('postThinkingToThread', () => {
    it('should post thinking with short content', async () => {
      const client = createMockClient();
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Analyzing the code...',
        durationMs: 2000,
      };

      const result = await postThinkingToThread(
        client,
        'C123',
        'parent-ts',
        entry,
        500
      );

      expect(result).toBe('posted-ts-123');
      expect(client.chat.postMessage).toHaveBeenCalled();
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain(':bulb: *Thinking*');
      // No duration in header (simplified format)
    });

    it('should upload .md for long thinking content', async () => {
      const client = createMockClient();
      const longContent = 'T'.repeat(1000);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: longContent,
        durationMs: 5000,
      };

      const result = await postThinkingToThread(
        client,
        'C123',
        'parent-ts',
        entry,
        500,
        'U456'
      );

      expect(result).toBe('upload-ts-123');
      expect(uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
        client,
        'C123',
        longContent,
        expect.stringContaining(':bulb: *Thinking*'),
        'parent-ts',
        'U456',
        500
      );
    });
  });

  describe('postResponseToThread', () => {
    it('should post response with short content', async () => {
      const client = createMockClient();

      const result = await postResponseToThread(
        client,
        'C123',
        'parent-ts',
        'Here is my response to your question.',
        3000,
        500
      );

      expect(result).toBe('posted-ts-123');
      expect(client.chat.postMessage).toHaveBeenCalled();
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain(':speech_balloon: *Response*');
      // No duration in header (simplified format)
    });

    it('should upload .md for long response', async () => {
      const client = createMockClient();
      const longContent = 'R'.repeat(1000);

      await postResponseToThread(
        client,
        'C123',
        'parent-ts',
        longContent,
        5000,
        500,
        'U456'
      );

      expect(uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
        client,
        'C123',
        longContent,
        expect.stringContaining('_Full content attached._'),
        'parent-ts',
        'U456',
        500
      );
    });
  });

  describe('postStartingToThread', () => {
    it('should post starting message', async () => {
      const client = createMockClient();

      const result = await postStartingToThread(client, 'C123', 'parent-ts');

      expect(result).toBe('posted-ts-123');
      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: 'parent-ts',
        text: ':brain: *Analyzing request...*',
        mrkdwn: true,
      });
    });
  });

  describe('postErrorToThread', () => {
    it('should post error message', async () => {
      const client = createMockClient();

      const result = await postErrorToThread(
        client,
        'C123',
        'parent-ts',
        'Connection timeout'
      );

      expect(result).toBe('posted-ts-123');
      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: 'parent-ts',
        text: ':x: *Error:* Connection timeout',
        mrkdwn: true,
      });
    });
  });
});
