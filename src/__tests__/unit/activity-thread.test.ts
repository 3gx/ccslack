import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postActivityToThread,
  flushActivityBatch,
  postThinkingToThread,
  postResponseToThread,
  postStartingToThread,
  postErrorToThread,
  ActivityBatchState,
  getMessagePermalink,
} from '../../activity-thread.js';
import type { ActivityEntry } from '../../blocks.js';

// Mock streaming module
vi.mock('../../streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({
    ts: 'upload-ts-123',
    uploadSucceeded: true,
  }),
}));

// Mock retry module
vi.mock('../../retry.js', () => ({
  withSlackRetry: vi.fn((fn: () => Promise<any>) => fn()),
}));

import { uploadMarkdownAndPngWithResponse } from '../../streaming.js';

// Helper to create mock Slack client
function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted-ts-123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://slack.com/archives/C123/p123456' }),
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
        postedBatchTs: null,
        postedBatchToolUseIds: new Set(),
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      expect(client.chat.postMessage).toHaveBeenCalled();
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.thread_ts).toBe('parent-ts');
      // Thread format uses tool emoji and bullet point details (not checkmark)
      expect(call.text).toContain(':mag: *Read*');
      expect(call.text).toContain('• Duration: 0.5s');
      expect(call.text).toContain(':memo: *Edit*');
      expect(call.text).toContain('• Duration: 0.8s');

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
        postedBatchTs: null,
        postedBatchToolUseIds: new Set(),
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
        postedBatchTs: null,
        postedBatchToolUseIds: new Set(),
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
    it('should post response with short content and return ts + permalink', async () => {
      const client = createMockClient();

      const result = await postResponseToThread(
        client,
        'C123',
        'parent-ts',
        'Here is my response to your question.',
        3000,
        500
      );

      expect(result).toEqual({
        ts: 'posted-ts-123',
        permalink: 'https://slack.com/archives/C123/p123456',
      });
      expect(client.chat.postMessage).toHaveBeenCalled();
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain(':speech_balloon: *Response*');
      // Verify getPermalink was called
      expect(client.chat.getPermalink).toHaveBeenCalledWith({
        channel: 'C123',
        message_ts: 'posted-ts-123',
      });
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

  describe('getMessagePermalink', () => {
    it('should return permalink from Slack API', async () => {
      const client = createMockClient();

      const permalink = await getMessagePermalink(client, 'C123', '1234567890.123456');

      expect(permalink).toBe('https://slack.com/archives/C123/p123456');
      expect(client.chat.getPermalink).toHaveBeenCalledWith({
        channel: 'C123',
        message_ts: '1234567890.123456',
      });
    });

    it('should return fallback URL when API fails', async () => {
      const client = createMockClient();
      client.chat.getPermalink.mockRejectedValue(new Error('API error'));

      const permalink = await getMessagePermalink(client, 'C123', '1234567890.123456');

      // Fallback format: removes dot from timestamp
      expect(permalink).toBe('https://slack.com/archives/C123/p1234567890123456');
    });
  });

  describe('permalink capture', () => {
    it('should capture permalink on entry when posting thinking to thread', async () => {
      const client = createMockClient();
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Analyzing the code...',
        durationMs: 2000,
      };

      await postThinkingToThread(client, 'C123', 'parent-ts', entry, 500);

      // Entry should be updated with permalink info
      expect(entry.threadMessageTs).toBe('posted-ts-123');
      expect(entry.threadMessageLink).toBe('https://slack.com/archives/C123/p123456');
    });

    it('should capture permalink on all entries when flushing activity batch', async () => {
      const client = createMockClient();
      const entry1: ActivityEntry = { timestamp: 1000, type: 'tool_complete', tool: 'Read', durationMs: 500 };
      const entry2: ActivityEntry = { timestamp: 2000, type: 'tool_complete', tool: 'Edit', durationMs: 800 };
      const state: ActivityBatchState = {
        activityThreadMsgTs: null,
        activityBatch: [entry1, entry2],
        activityBatchStartIndex: 0,
        lastActivityPostTime: 0,
        threadParentTs: 'parent-ts',
        postedBatchTs: null,
        postedBatchToolUseIds: new Set(),
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      // Both entries should have the same permalink (same batch message)
      expect(entry1.threadMessageTs).toBe('posted-ts-123');
      expect(entry1.threadMessageLink).toBe('https://slack.com/archives/C123/p123456');
      expect(entry2.threadMessageTs).toBe('posted-ts-123');
      expect(entry2.threadMessageLink).toBe('https://slack.com/archives/C123/p123456');
    });

    it('should not set permalink when batch post fails', async () => {
      const client = createMockClient();
      client.chat.postMessage.mockRejectedValue(new Error('Post failed'));
      const entry: ActivityEntry = { timestamp: 1000, type: 'tool_complete', tool: 'Read', durationMs: 500 };
      const state: ActivityBatchState = {
        activityThreadMsgTs: null,
        activityBatch: [entry],
        activityBatchStartIndex: 0,
        lastActivityPostTime: 0,
        threadParentTs: 'parent-ts',
        postedBatchTs: null,
        postedBatchToolUseIds: new Set(),
      };

      await flushActivityBatch(state, client, 'C123', 500, 'timer');

      // Entry should NOT have permalink since post failed
      expect(entry.threadMessageTs).toBeUndefined();
      expect(entry.threadMessageLink).toBeUndefined();
    });

    it('should capture permalink on starting entry when entry is provided', async () => {
      const client = createMockClient();
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'starting',
      };

      await postStartingToThread(client, 'C123', 'parent-ts', entry);

      // Entry should be updated with permalink info
      expect(entry.threadMessageTs).toBe('posted-ts-123');
      expect(entry.threadMessageLink).toBe('https://slack.com/archives/C123/p123456');
    });

    it('should not crash when starting entry is not provided', async () => {
      const client = createMockClient();

      // Should work without entry parameter (backward compatible)
      const result = await postStartingToThread(client, 'C123', 'parent-ts');

      expect(result).toBe('posted-ts-123');
      expect(client.chat.postMessage).toHaveBeenCalled();
    });

    it('should capture permalink on response entry via postResponseToThread', async () => {
      const client = createMockClient();

      const result = await postResponseToThread(
        client,
        'C123',
        'parent-ts',
        'Response content',
        1000,
        500
      );

      // Result should contain both ts and permalink
      expect(result).toEqual({
        ts: 'posted-ts-123',
        permalink: 'https://slack.com/archives/C123/p123456',
      });
    });
  });
});
