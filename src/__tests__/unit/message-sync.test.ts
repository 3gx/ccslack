import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncMessagesFromOffset, MessageSyncState, SyncResult } from '../../message-sync.js';
import * as sessionReader from '../../session-reader.js';
import * as sessionManager from '../../session-manager.js';

// Mock session-reader module
vi.mock('../../session-reader.js', () => ({
  readNewMessages: vi.fn(() => Promise.resolve({ messages: [], newOffset: 0 })),
  extractTextContent: vi.fn((msg) => msg.message?.content?.[0]?.text || ''),
  buildActivityEntriesFromMessage: vi.fn(() => []),
}));

// Mock session-manager module
vi.mock('../../session-manager.js', () => ({
  getMessageMapUuids: vi.fn(() => new Set<string>()),
  saveMessageMapping: vi.fn(),
  saveActivityLog: vi.fn(),
}));

// Mock retry module
vi.mock('../../retry.js', () => ({
  withSlackRetry: vi.fn((fn) => fn()),
  withInfiniteRetry: vi.fn((fn) => fn()),
  sleep: vi.fn(() => Promise.resolve()),
}));

describe('message-sync', () => {
  let mockClient: any;
  let mockState: MessageSyncState;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      },
    };

    mockState = {
      conversationKey: 'channel-1',
      channelId: 'channel-1',
      threadTs: undefined,
      sessionId: 'session-123',
      workingDir: '/test/project',
      client: mockClient,
    };

    // Reset mocks to default values
    vi.mocked(sessionReader.readNewMessages).mockResolvedValue({ messages: [], newOffset: 0 });
    vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) => msg.message?.content?.[0]?.text || '');
    vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([]);
    vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set<string>());
  });

  describe('syncMessagesFromOffset', () => {
    it('should return empty result when no messages', async () => {
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [],
        newOffset: 1000,
      });

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(result).toEqual({
        newOffset: 1000,
        syncedCount: 0,
        totalToSync: 0,
        wasAborted: false,
        allSucceeded: true,
      });
    });

    it('should skip messages already in messageMap', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'already-posted-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['already-posted-uuid'])
      );

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(result).toEqual({
        newOffset: 2000,
        syncedCount: 0,
        totalToSync: 0,
        wasAborted: false,
        allSucceeded: true,
      });
      // Should not have called postTextMessage or posted anything
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('should post text messages using postTextMessage callback', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'text-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello world');

      const postTextMessage = vi.fn().mockResolvedValue(true);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
      });

      expect(postTextMessage).toHaveBeenCalledWith(mockState, mockMessage);
      expect(result.syncedCount).toBe(1);
      expect(result.allSucceeded).toBe(true);
    });

    it('should post activity-only messages directly', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'activity-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Should post activity summary directly via chat.postMessage
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          text: expect.stringContaining('Terminal Activity'),
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'section',
              text: expect.objectContaining({
                text: expect.stringContaining('1 thinking'),
              }),
            }),
          ]),
        })
      );
      expect(result.syncedCount).toBe(1);
      expect(result.allSucceeded).toBe(true);
    });

    it('should handle messages with tool activity', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'tool-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
      ]);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Terminal Activity'),
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'section',
              text: expect.objectContaining({
                text: expect.stringContaining('tools: Read'),
              }),
            }),
          ]),
        })
      );
      expect(result.syncedCount).toBe(1);
    });

    it('should skip messages with no text and no activity', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'empty-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([]);

      const postTextMessage = vi.fn().mockResolvedValue(true);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
      });

      // Should not post anything
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(postTextMessage).not.toHaveBeenCalled();
      expect(result.syncedCount).toBe(1); // Counts as "synced" (skipped)
      expect(result.allSucceeded).toBe(true);
    });

    it('should stop when aborted', async () => {
      const messages = [
        { type: 'user', uuid: 'msg-1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'a' }] } },
        { type: 'user', uuid: 'msg-2', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'b' }] } },
        { type: 'user', uuid: 'msg-3', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'c' }] } },
      ];

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages,
        newOffset: 3000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('text');

      let callCount = 0;
      const postTextMessage = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(true);
      });

      // Abort after first message
      let abortAfter = 1;
      const isAborted = vi.fn().mockImplementation(() => callCount >= abortAfter);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
        isAborted,
      });

      expect(result.wasAborted).toBe(true);
      expect(result.syncedCount).toBe(1);
      expect(result.totalToSync).toBe(3);
    });

    it('should call onProgress callback', async () => {
      const messages = [
        { type: 'user', uuid: 'msg-1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'a' }] } },
        { type: 'user', uuid: 'msg-2', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: 'b' }] } },
      ];

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages,
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('text');

      const postTextMessage = vi.fn().mockResolvedValue(true);
      const onProgress = vi.fn().mockResolvedValue(undefined);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, messages[0]);
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, messages[1]);
    });

    it('should save message mapping for activity-only messages', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'activity-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(sessionManager.saveMessageMapping).toHaveBeenCalledWith(
        'channel-1',
        'msg-ts',
        expect.objectContaining({
          sdkMessageId: 'activity-msg-uuid',
          sessionId: 'session-123',
          type: 'assistant',
        })
      );
    });

    it('should save activity log for activity-only messages', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'activity-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(sessionManager.saveActivityLog).toHaveBeenCalledWith(
        expect.stringContaining('channel-1_sync_activity-msg-uuid'),
        expect.arrayContaining([
          expect.objectContaining({ type: 'thinking' }),
        ])
      );
    });

    it('should track allSucceeded correctly when text posting fails', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'fail-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      const postTextMessage = vi.fn().mockResolvedValue(false);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
        infiniteRetry: false,
      });

      expect(result.allSucceeded).toBe(false);
      expect(result.syncedCount).toBe(0);
    });

    it('should track allSucceeded correctly when activity posting fails', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'activity-fail-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      // Make posting fail
      mockClient.chat.postMessage.mockRejectedValue(new Error('Rate limited'));

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        infiniteRetry: false,
      });

      expect(result.allSucceeded).toBe(false);
      expect(result.syncedCount).toBe(0);
    });

    it('should handle thread conversations', async () => {
      const threadState = {
        ...mockState,
        threadTs: 'thread-123',
        conversationKey: 'channel-1_thread-123',
      };

      const mockMessage = {
        type: 'assistant',
        uuid: 'thread-activity-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      await syncMessagesFromOffset(threadState, '/path/to/file.jsonl', 0);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          thread_ts: 'thread-123',
        })
      );
    });

    it('should include View Log button for activity-only messages', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: 'view-log-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'actions',
              elements: expect.arrayContaining([
                expect.objectContaining({
                  type: 'button',
                  text: expect.objectContaining({ text: 'View Log' }),
                  action_id: expect.stringContaining('view_activity_log_'),
                }),
              ]),
            }),
          ]),
        })
      );
    });
  });
});
