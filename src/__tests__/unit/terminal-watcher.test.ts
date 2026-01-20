import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startWatching,
  stopWatching,
  isWatching,
  updateWatchRate,
  getWatcher,
  onSessionCleared,
  stopAllWatchers,
} from '../../terminal-watcher.js';
import { Session } from '../../session-manager.js';
import * as sessionManager from '../../session-manager.js';
import * as sessionReader from '../../session-reader.js';
import * as streaming from '../../streaming.js';

// Mock session-reader module
vi.mock('../../session-reader.js', () => ({
  getSessionFilePath: vi.fn(() => '/mock/path/session.jsonl'),
  sessionFileExists: vi.fn(() => true),
  getFileSize: vi.fn(() => 1000),
  readNewMessages: vi.fn(() => Promise.resolve({ messages: [], newOffset: 1000 })),
  extractTextContent: vi.fn((msg) => msg.message?.content?.[0]?.text || ''),
  buildActivityEntriesFromMessage: vi.fn(() => []),  // Default to no activity
}));

// Mock session-manager (for getSession, getThreadSession, saveMessageMapping, saveActivityLog, getMessageMapUuids)
vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    getSession: vi.fn(() => ({ threadCharLimit: 500, stripEmptyTag: false })),
    getThreadSession: vi.fn(() => null),
    saveMessageMapping: vi.fn(),
    saveActivityLog: vi.fn(),
    getMessageMapUuids: vi.fn(() => new Set<string>()),  // Default to empty set (no messages posted yet)
  };
});

// Mock utils
vi.mock('../../utils.js', () => ({
  markdownToSlack: vi.fn((text) => text),
  stripMarkdownCodeFence: vi.fn((text) => text),
}));

// Mock retry
vi.mock('../../retry.js', () => ({
  withSlackRetry: vi.fn((fn) => fn()),
}));

// Mock streaming (for uploadMarkdownAndPngWithResponse, truncateWithClosedFormatting)
vi.mock('../../streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn(() => Promise.resolve({ ts: 'upload-ts' })),
  truncateWithClosedFormatting: vi.fn((text, limit) => text.substring(0, limit) + '\n\n_...truncated. Full response attached._'),
}));

describe('terminal-watcher', () => {
  let mockClient: any;
  let mockSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Stop any leftover watchers from previous tests
    stopAllWatchers();

    // Reset mocks to default values (important after tests that change them)
    vi.mocked(sessionReader.sessionFileExists).mockReturnValue(true);
    vi.mocked(sessionReader.getSessionFilePath).mockReturnValue('/mock/path/session.jsonl');
    vi.mocked(sessionReader.getFileSize).mockReturnValue(1000);
    vi.mocked(sessionReader.readNewMessages).mockResolvedValue({ messages: [], newOffset: 1000 });

    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    };

    mockSession = {
      sessionId: 'test-session-123',
      workingDir: '/test/project',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/test/project',
      configuredBy: null,
      configuredAt: null,
    };
  });

  afterEach(() => {
    stopAllWatchers();
    vi.useRealTimers();
  });

  describe('startWatching', () => {
    it('should start watching a valid session', () => {
      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(result.success).toBe(true);
      expect(isWatching('channel-1')).toBe(true);
    });

    it('should return error when session has no sessionId', () => {
      const sessionWithoutId = { ...mockSession, sessionId: null };

      const result = startWatching('channel-1', undefined, sessionWithoutId, mockClient, 'status-ts');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active session');
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should return error when session file does not exist', () => {
      vi.mocked(sessionReader.sessionFileExists).mockReturnValue(false);

      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session file not found');
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should stop existing watcher before starting new one', () => {
      // Start first watcher
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      expect(isWatching('channel-1')).toBe(true);

      // Start second watcher on same channel
      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-2');

      expect(result.success).toBe(true);
      expect(isWatching('channel-1')).toBe(true);
    });

    it('should handle thread conversations separately', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts-2');

      expect(isWatching('channel-1')).toBe(true);
      expect(isWatching('channel-1', 'thread-ts')).toBe(true);
    });

    it('should use session updateRateSeconds for polling interval', () => {
      const sessionWithCustomRate = { ...mockSession, updateRateSeconds: 5 };

      startWatching('channel-1', undefined, sessionWithCustomRate, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(5000);
    });

    it('should default to 2 seconds if updateRateSeconds not set', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(2000);
    });
  });

  describe('stopWatching', () => {
    it('should stop an active watcher', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      expect(isWatching('channel-1')).toBe(true);

      const result = stopWatching('channel-1');

      expect(result).toBe(true);
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should return false when no watcher exists', () => {
      const result = stopWatching('nonexistent-channel');

      expect(result).toBe(false);
    });

    it('should stop thread watcher independently', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts-2');

      stopWatching('channel-1', 'thread-ts');

      expect(isWatching('channel-1')).toBe(true);
      expect(isWatching('channel-1', 'thread-ts')).toBe(false);
    });
  });

  describe('isWatching', () => {
    it('should return true for active watcher', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(isWatching('channel-1')).toBe(true);
    });

    it('should return false for non-watched channel', () => {
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should differentiate between channel and thread', () => {
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts');

      expect(isWatching('channel-1')).toBe(false);
      expect(isWatching('channel-1', 'thread-ts')).toBe(true);
    });
  });

  describe('updateWatchRate', () => {
    it('should update rate for active watcher', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const result = updateWatchRate('channel-1', undefined, 5);

      expect(result).toBe(true);
      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(5000);
    });

    it('should return false when no watcher exists', () => {
      const result = updateWatchRate('nonexistent', undefined, 5);

      expect(result).toBe(false);
    });
  });

  describe('getWatcher', () => {
    it('should return watcher state for active watcher', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');

      expect(watcher).toBeDefined();
      expect(watcher?.channelId).toBe('channel-1');
      expect(watcher?.sessionId).toBe('test-session-123');
    });

    it('should return undefined for non-watched channel', () => {
      const watcher = getWatcher('nonexistent');

      expect(watcher).toBeUndefined();
    });
  });

  describe('onSessionCleared', () => {
    it('should stop watcher and notify when session is cleared', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      onSessionCleared('channel-1');

      // Allow async notification to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(isWatching('channel-1')).toBe(false);
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          ts: 'status-ts',
          text: expect.stringContaining('session cleared'),
        })
      );
    });

    it('should do nothing when no watcher exists', () => {
      onSessionCleared('nonexistent');

      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });
  });

  describe('stopAllWatchers', () => {
    it('should stop all active watchers', () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      startWatching('channel-2', undefined, mockSession, mockClient, 'status-ts-2');
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts-3');

      stopAllWatchers();

      expect(isWatching('channel-1')).toBe(false);
      expect(isWatching('channel-2')).toBe(false);
      expect(isWatching('channel-1', 'thread-ts')).toBe(false);
    });
  });

  describe('polling behavior', () => {
    it('should poll for new messages at configured interval', async () => {
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [],
        newOffset: 1000,
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer by poll interval
      await vi.advanceTimersByTimeAsync(2000);

      expect(sessionReader.readNewMessages).toHaveBeenCalled();
    });

    it('should post new messages to Slack', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello from terminal' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello from terminal');

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          text: expect.stringContaining('Hello from terminal'),
        })
      );
    });

    it('should add prefix for user messages', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'User input' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('User input');

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Terminal Input'),
        })
      );
    });

    it('should add prefix for assistant messages', async () => {
      const mockMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Assistant response');

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Assistant messages now use uploadMarkdownAndPngWithResponse
      expect(streaming.uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
        mockClient,
        'channel-1',
        'Assistant response',  // strippedMarkdown
        expect.stringContaining('Terminal Output'),  // prefix + slackText
        undefined,  // threadTs
        undefined,  // userId
        500,  // charLimit from session
        false,  // stripEmptyTag
        undefined  // forkInfo (undefined for main channel, only set for threads)
      );
    });

    it('should truncate long messages for user input', async () => {
      const longText = 'x'.repeat(1000);
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue(longText);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer and allow promises to settle
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // User messages use truncateWithClosedFormatting when over limit
      expect(streaming.truncateWithClosedFormatting).toHaveBeenCalledWith(
        longText,
        500  // charLimit from session
      );
    });

  });

  describe('status message movement', () => {
    it('should delete old status message after posting new messages', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'Hello from terminal' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello from terminal');

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should delete old status message
      expect(mockClient.chat.delete).toHaveBeenCalledWith({
        channel: 'channel-1',
        ts: 'status-ts',
      });
    });

    it('should post new status message at bottom after posting new messages', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'Hello from terminal' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello from terminal');

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should post new status message with Stop Watching button
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'actions',
              elements: expect.arrayContaining([
                expect.objectContaining({
                  action_id: 'stop_terminal_watch',
                  text: expect.objectContaining({ text: 'Stop Watching' }),
                }),
              ]),
            }),
          ]),
        })
      );
    });

    it('should update watcher state with new status message ts', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'Hello' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Track postMessage calls and return different ts based on call content
      let callCount = 0;
      mockClient.chat.postMessage.mockImplementation(() => {
        callCount++;
        // First call is content message, second is status message
        return Promise.resolve({ ts: callCount === 1 ? 'content-msg-ts' : 'new-status-ts' });
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'old-status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Watcher should have updated statusMsgTs
      const watcher = getWatcher('channel-1');
      expect(watcher?.statusMsgTs).toBe('new-status-ts');
    });

    it('should not move status message if no new messages', async () => {
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [],
        newOffset: 1000,
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT delete or post status message when no new content
      expect(mockClient.chat.delete).not.toHaveBeenCalled();
      // Only the initial postMessage from startWatching should have happened (none in this case)
    });

    it('should include watching text with update rate in status message', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'Hello' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      const sessionWithRate = { ...mockSession, updateRateSeconds: 5 };
      startWatching('channel-1', undefined, sessionWithRate, mockClient, 'status-ts');

      await vi.advanceTimersByTimeAsync(5000);

      // Should include rate in watching text
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'context',
              elements: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining('Updates every 5s'),
                }),
              ]),
            }),
          ]),
        })
      );
    });

    it('should handle delete error gracefully and still post new status', async () => {
      const mockMessage = {
        type: 'user',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'Hello' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Simulate delete error (message already deleted)
      mockClient.chat.delete.mockRejectedValue(new Error('message_not_found'));

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      await vi.advanceTimersByTimeAsync(2000);

      // Should still post new status message despite delete error
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'actions',
            }),
          ]),
        })
      );
    });
  });

  describe('offset advancement behavior', () => {
    it('should not advance offset when posting fails', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'fail-msg-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Make posting fail
      mockClient.chat.postMessage.mockRejectedValue(new Error('Rate limited'));

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll - should fail
      await vi.advanceTimersByTimeAsync(2000);

      // Get watcher state to check offset
      const watcher = getWatcher('channel-1');

      // Offset should NOT have advanced (still at initial 1000)
      expect(watcher?.fileOffset).toBe(1000);
    });

    it('should advance offset when all messages post successfully', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'success-msg-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Make posting succeed
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'msg-ts' });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll - should succeed
      await vi.advanceTimersByTimeAsync(2000);

      // Get watcher state to check offset
      const watcher = getWatcher('channel-1');

      // Offset should have advanced to 2000
      expect(watcher?.fileOffset).toBe(2000);
    });

    it('should skip messages already in messageMap', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'already-posted-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Mock that this message is already posted
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['already-posted-123'])
      );

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'msg-ts' });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT have posted the message (it was skipped)
      // Only the status message move should have posted
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const contentPosts = postCalls.filter(
        call => (call[0] as any).text?.includes('Terminal Input')
      );
      expect(contentPosts.length).toBe(0);

      // Offset should still advance (message was skipped, not failed)
      const watcher = getWatcher('channel-1');
      expect(watcher?.fileOffset).toBe(2000);
    });

    it('should retry failed messages on next poll', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'retry-msg-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      // Note: startWatching calls pollForChanges immediately, then on interval
      // So we need 3 mock values: immediate poll (fail), timer poll (fail check), timer poll (success)
      vi.mocked(sessionReader.readNewMessages)
        .mockResolvedValueOnce({ messages: [mockMessage], newOffset: 2000 }) // Immediate poll
        .mockResolvedValueOnce({ messages: [mockMessage], newOffset: 2000 }) // Re-read on timer poll
        .mockResolvedValue({ messages: [], newOffset: 2000 }); // Subsequent polls

      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // First attempt (immediate poll) fails, second attempt (timer poll) succeeds
      // Note: moveStatusMessageToBottom also calls postMessage, so we need to account for that
      mockClient.chat.postMessage
        .mockRejectedValueOnce(new Error('Rate limited')) // Content message (immediate poll)
        .mockResolvedValue({ ts: 'msg-ts' }); // All subsequent calls succeed

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Immediate poll happened - should have failed
      // Allow microtasks to settle
      await vi.advanceTimersByTimeAsync(0);

      let watcher = getWatcher('channel-1');
      expect(watcher?.fileOffset).toBe(1000); // Not advanced after immediate poll failure

      // Timer poll - should succeed (message is re-read because offset didn't advance)
      await vi.advanceTimersByTimeAsync(2000);

      watcher = getWatcher('channel-1');
      expect(watcher?.fileOffset).toBe(2000); // Now advanced after successful retry
    });

    it('should not double-post messages after retry', async () => {
      const mockMessage = {
        type: 'user',
        uuid: 'no-double-post-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      };

      // Both polls return the same message (simulating re-read after failure)
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      // Track message map state
      let messageMapUuids = new Set<string>();
      vi.mocked(sessionManager.getMessageMapUuids).mockImplementation(() => messageMapUuids);
      vi.mocked(sessionManager.saveMessageMapping).mockImplementation((channelId, ts, mapping) => {
        messageMapUuids.add(mapping.sdkMessageId);
      });

      // First attempt succeeds
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'msg-ts' });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll - posts message
      await vi.advanceTimersByTimeAsync(2000);

      // Second poll - same message returned but should be skipped (in messageMap)
      await vi.advanceTimersByTimeAsync(2000);

      // Count how many times Terminal Input was posted
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const contentPosts = postCalls.filter(
        call => (call[0] as any).text?.includes('Terminal Input')
      );

      // Should only be posted once, not twice
      expect(contentPosts.length).toBe(1);
    });
  });
});
