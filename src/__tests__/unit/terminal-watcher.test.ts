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
  extractTextContent: vi.fn((msg) => {
    if (typeof msg?.message?.content === 'string') return msg.message.content;
    return msg?.message?.content?.find((b: any) => b.type === 'text')?.text || '';
  }),
  buildActivityEntriesFromMessage: vi.fn(() => []),  // Default to no activity
  groupMessagesByTurn: vi.fn(() => []),  // Default to empty turns
  isTurnComplete: vi.fn((turn) => turn.trailingActivity.length === 0 && turn.segments.length > 0),
  extractPlanFilePathFromMessage: vi.fn(() => null),  // Plan detection for /watch
  hasExitPlanMode: vi.fn(() => false),  // ExitPlanMode detection for /watch
}));

// Mock session-manager (for getSession, getThreadSession, saveMessageMapping, mergeActivityLog, getMessageMapUuids)
vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    getSession: vi.fn(() => ({ threadCharLimit: 500 })),
    getThreadSession: vi.fn(() => null),
    saveMessageMapping: vi.fn(),
    saveSession: vi.fn(),  // For planFilePath persistence
    saveThreadSession: vi.fn(),  // For planFilePath persistence in threads
    mergeActivityLog: vi.fn(),  // Now using merge instead of save
    getMessageMapUuids: vi.fn(() => new Set<string>()),  // Default to empty set (no messages posted yet)
    isSlackOriginatedUserUuid: vi.fn(() => false),  // Default: not Slack-originated (terminal input)
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

// Mock streaming (for uploadMarkdownAndPngWithResponse, uploadMarkdownWithResponse, truncateWithClosedFormatting)
vi.mock('../../streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn(() => Promise.resolve({ ts: 'upload-ts' })),
  uploadMarkdownWithResponse: vi.fn(() => Promise.resolve({ ts: 'upload-md-ts' })),
  truncateWithClosedFormatting: vi.fn((text, limit) => text.substring(0, limit) + '\n\n_...truncated. Full response attached._'),
}));

// Mock session-event-stream
vi.mock('../../session-event-stream.js', () => ({
  readActivityLog: vi.fn(() => Promise.resolve([])),
}));

// Mock activity-thread (for thread-based activity posting)
vi.mock('../../activity-thread.js', () => ({
  postActivityToThread: vi.fn(() => Promise.resolve({ ts: 'thread-reply-ts' })),
  postThinkingToThread: vi.fn(() => Promise.resolve('thinking-ts')),
}));

// Import mocked activity-thread for use in tests
import * as activityThread from '../../activity-thread.js';

// Mock blocks
vi.mock('../../blocks.js', () => ({
  buildLiveActivityBlocks: vi.fn(() => [
    { type: 'section', text: { type: 'mrkdwn', text: ':brain: *Thinking...*' } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Fork here' } }] },
  ]),
  buildWatchingStatusSection: vi.fn((sessionId: string, updateRateSeconds: number) => ({
    type: 'actions',
    block_id: `terminal_watch_${sessionId}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: `🛑 Stop Watching (${updateRateSeconds}s)`, emoji: true },
      action_id: 'stop_terminal_watch',
      style: 'danger',
      value: JSON.stringify({ sessionId }),
    }],
  })),
  formatThreadActivityBatch: vi.fn(() => ':white_check_mark: *Read* [0.1s]'),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ channels: {} })),
  writeFileSync: vi.fn(),
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

    // Reset session manager mocks that may have custom implementations from previous tests
    vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set<string>());
    vi.mocked(sessionManager.saveMessageMapping).mockImplementation(() => {});
    vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mockResolvedValue({ ts: 'upload-ts' });
    vi.mocked(streaming.uploadMarkdownWithResponse).mockResolvedValue({ ts: 'upload-md-ts' });

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
    it('should start watching a valid session', async () => {
      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(result.success).toBe(true);
      expect(isWatching('channel-1')).toBe(true);
    });

    it('should return error when session has no sessionId', async () => {
      const sessionWithoutId = { ...mockSession, sessionId: null };

      const result = startWatching('channel-1', undefined, sessionWithoutId, mockClient, 'status-ts');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active session');
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should return error when session file does not exist', async () => {
      vi.mocked(sessionReader.sessionFileExists).mockReturnValue(false);

      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session file not found');
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should stop existing watcher before starting new one', async () => {
      // Start first watcher
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      expect(isWatching('channel-1')).toBe(true);

      // Start second watcher on same channel
      const result = startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-2');

      expect(result.success).toBe(true);
      expect(isWatching('channel-1')).toBe(true);
    });

    it('should handle thread conversations separately', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts-2');

      expect(isWatching('channel-1')).toBe(true);
      expect(isWatching('channel-1', 'thread-ts')).toBe(true);
    });

    it('should use session updateRateSeconds for polling interval', async () => {
      const sessionWithCustomRate = { ...mockSession, updateRateSeconds: 5 };

      startWatching('channel-1', undefined, sessionWithCustomRate, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(5000);
    });

    it('should default to 3 seconds if updateRateSeconds not set', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(3000);
    });
  });

  describe('stopWatching', () => {
    it('should stop an active watcher', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      expect(isWatching('channel-1')).toBe(true);

      const result = stopWatching('channel-1');

      expect(result).toBe(true);
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should return false when no watcher exists', async () => {
      const result = stopWatching('nonexistent-channel');

      expect(result).toBe(false);
    });

    it('should stop thread watcher independently', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts-1');
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts-2');

      stopWatching('channel-1', 'thread-ts');

      expect(isWatching('channel-1')).toBe(true);
      expect(isWatching('channel-1', 'thread-ts')).toBe(false);
    });
  });

  describe('isWatching', () => {
    it('should return true for active watcher', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      expect(isWatching('channel-1')).toBe(true);
    });

    it('should return false for non-watched channel', async () => {
      expect(isWatching('channel-1')).toBe(false);
    });

    it('should differentiate between channel and thread', async () => {
      startWatching('channel-1', 'thread-ts', mockSession, mockClient, 'status-ts');

      expect(isWatching('channel-1')).toBe(false);
      expect(isWatching('channel-1', 'thread-ts')).toBe(true);
    });
  });

  describe('updateWatchRate', () => {
    it('should update rate for active watcher', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const result = updateWatchRate('channel-1', undefined, 5);

      expect(result).toBe(true);
      const watcher = getWatcher('channel-1');
      expect(watcher?.updateRateMs).toBe(5000);
    });

    it('should return false when no watcher exists', async () => {
      const result = updateWatchRate('nonexistent', undefined, 5);

      expect(result).toBe(false);
    });
  });

  describe('getWatcher', () => {
    it('should return watcher state for active watcher', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');

      expect(watcher).toBeDefined();
      expect(watcher?.channelId).toBe('channel-1');
      expect(watcher?.sessionId).toBe('test-session-123');
    });

    it('should return undefined for non-watched channel', async () => {
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

    it('should do nothing when no watcher exists', async () => {
      onSessionCleared('nonexistent');

      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });
  });

  describe('stopAllWatchers', () => {
    it('should stop all active watchers', async () => {
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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['123'],
      }]);

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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['123'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Terminal Input'),
        })
      );
    });

    it('should add prefix for assistant messages', async () => {
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'prompt' },
      };
      const mockMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Assistant response');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [], textOutput: mockMessage as any }],
        trailingActivity: [],
        allMessageUuids: ['user-0', '123'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Assistant messages now use uploadMarkdownAndPngWithResponse
      // Note: Fork button is now on activity message in blocks.ts, not response message
      expect(streaming.uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
        mockClient,
        'channel-1',
        'Assistant response',  // strippedMarkdown
        expect.stringContaining('Terminal Output'),  // prefix + slackText
        undefined,  // threadTs
        undefined,  // userId
        500  // charLimit from session
        // forkInfo and isFinalSegment removed - Fork button now on activity message
      );
    });

    it('should post tool-only messages without file attachments', async () => {
      // In turn-based model, a turn starts with user input, tool-only messages are activity
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'do something' },
      };
      const mockToolMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockToolMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [],
        trailingActivity: [mockToolMessage as any],
        allMessageUuids: ['user-0', '123'],
      }]);
      // Need activity entries for activity summary to be posted
      // Activity timestamp should fall within the turn's time range
      const { readActivityLog } = await import('../../session-event-stream.js');
      vi.mocked(readActivityLog).mockResolvedValue([
        { type: 'tool_complete', tool: 'Read', timestamp: Date.parse('2024-01-01T00:00:01Z') } as any,
      ]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT use uploadMarkdownAndPngWithResponse for activity-only turns
      expect(streaming.uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();

      // Activity is now posted as thread replies for in-progress turns (trailingActivity)
      expect(activityThread.postActivityToThread).toHaveBeenCalled();
    });

    it('should post multiple tool-only messages without file attachments', async () => {
      // In turn-based model, a turn starts with user input, tool-only messages are activity
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'do something' },
      };
      const mockToolMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Write' },
        ] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockToolMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [],
        trailingActivity: [mockToolMessage as any],
        allMessageUuids: ['user-0', '123'],
      }]);
      // Need activity entries for activity summary to be posted
      // Activity timestamps should fall within the turn's time range
      const { readActivityLog } = await import('../../session-event-stream.js');
      vi.mocked(readActivityLog).mockResolvedValue([
        { type: 'tool_complete', tool: 'Read', timestamp: Date.parse('2024-01-01T00:00:01Z') } as any,
        { type: 'tool_complete', tool: 'Write', timestamp: Date.parse('2024-01-01T00:00:01Z') + 1 } as any,
      ]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT use uploadMarkdownAndPngWithResponse for activity-only turns
      expect(streaming.uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();

      // Activity is now posted as thread replies for in-progress turns (trailingActivity)
      expect(activityThread.postActivityToThread).toHaveBeenCalled();
    });

    it('should still use file attachments for mixed content (text + tools)', async () => {
      // In turn-based model, text response gets file attachments
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'do something' },
      };
      const mockTextMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'Here is the file:' },
          { type: 'tool_use', name: 'Read' },
        ] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockTextMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Here is the file:');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [], textOutput: mockTextMessage as any }],
        trailingActivity: [],
        allMessageUuids: ['user-0', '123'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Should use uploadMarkdownAndPngWithResponse for text output
      expect(streaming.uploadMarkdownAndPngWithResponse).toHaveBeenCalled();
    });

    it('should upload .md file for long user input (not just truncate)', async () => {
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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['123'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer and allow promises to settle
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // Long user input should use uploadMarkdownWithResponse (.md only, no PNG)
      expect(streaming.uploadMarkdownWithResponse).toHaveBeenCalledWith(
        mockClient,
        'channel-1',
        longText,  // Original markdown for .md file
        expect.stringContaining('Terminal Input'),  // Prefix + content
        undefined,  // threadTs
        undefined,  // userId
        500  // charLimit
      );

      // Should NOT use uploadMarkdownAndPngWithResponse for user input
      expect(streaming.uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();
    });

    it('should NOT upload .md file for short user input', async () => {
      const shortText = 'Hello from terminal';
      const mockMessage = {
        type: 'user',
        uuid: '456',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'text', text: shortText }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue(shortText);
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['456'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);

      // Short user input should use simple text post
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Terminal Input'),
        })
      );

      // Should NOT upload any files for short input
      expect(streaming.uploadMarkdownWithResponse).not.toHaveBeenCalled();
      expect(streaming.uploadMarkdownAndPngWithResponse).not.toHaveBeenCalled();
    });

    it('should NOT post fallback when uploadSucceeded is true (prevents duplicate)', async () => {
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'prompt' },
      };
      const mockMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Assistant response');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [], textOutput: mockMessage as any }],
        trailingActivity: [],
        allMessageUuids: ['user-0', '123'],
      }]);

      // Mock upload returning uploadSucceeded=true but ts=undefined
      // This simulates files.uploadV2 succeeding but ts extraction failing
      vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mockResolvedValue({
        ts: undefined,
        postedMessages: [],
        uploadSucceeded: true,
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT have posted a fallback message via chat.postMessage
      // Only the status message and user input should be posted
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const fallbackPosts = postCalls.filter(
        (call: any[]) => (call[0] as any).text?.includes('Terminal Output')
      );
      expect(fallbackPosts.length).toBe(0);

      // CRITICAL: Should save mapping with synthetic ts for deduplication
      expect(sessionManager.saveMessageMapping).toHaveBeenCalledWith(
        'channel-1',
        'uploaded-no-ts-123',  // Synthetic ts based on message UUID
        expect.objectContaining({
          sdkMessageId: '123',
          sessionId: 'test-session-123',
          type: 'assistant',
        })
      );
    });

    it('should NOT re-post message on subsequent polls when uploadSucceeded with synthetic ts', async () => {
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'prompt' },
      };
      const mockMessage = {
        type: 'assistant',
        uuid: 'dedup-test-123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Assistant response');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [], textOutput: mockMessage as any }],
        trailingActivity: [],
        allMessageUuids: ['user-0', 'dedup-test-123'],
      }]);

      // Track messageMap state to simulate real deduplication
      let messageMapUuids = new Set<string>();
      vi.mocked(sessionManager.getMessageMapUuids).mockImplementation(() => messageMapUuids);
      vi.mocked(sessionManager.saveMessageMapping).mockImplementation((channelId, ts, mapping) => {
        messageMapUuids.add(mapping.sdkMessageId);
      });

      // Mock upload returning uploadSucceeded=true but ts=undefined
      vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mockResolvedValue({
        ts: undefined,
        postedMessages: [],
        uploadSucceeded: true,
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll - should upload and save synthetic mapping
      await vi.advanceTimersByTimeAsync(2000);

      const uploadCallsAfterFirstPoll = vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mock.calls.length;

      // Second poll - should skip because UUID is now in messageMap
      await vi.advanceTimersByTimeAsync(2000);

      const uploadCallsAfterSecondPoll = vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mock.calls.length;

      // Upload should NOT have been called again on second poll
      expect(uploadCallsAfterSecondPoll).toBe(uploadCallsAfterFirstPoll);
    });

    it('should post fallback when upload returns null (actual failure)', async () => {
      const mockUserInput = {
        type: 'user',
        uuid: 'user-0',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'prompt' },
      };
      const mockMessage = {
        type: 'assistant',
        uuid: '123',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Assistant response');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [], textOutput: mockMessage as any }],
        trailingActivity: [],
        allMessageUuids: ['user-0', '123'],
      }]);

      // Mock upload returning null (actual failure)
      vi.mocked(streaming.uploadMarkdownAndPngWithResponse).mockResolvedValue(null);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');
      await vi.advanceTimersByTimeAsync(2000);

      // SHOULD have posted a fallback message via chat.postMessage
      // May be posted multiple times due to immediate + timer polls (messageMap not fully mocked)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const fallbackPosts = postCalls.filter(
        (call: any[]) => (call[0] as any).text?.includes('Terminal Output')
      );
      expect(fallbackPosts.length).toBeGreaterThanOrEqual(1);
    });

  });

  describe('anchor message behavior (thread-based output)', () => {
    // With thread-based output, the anchor message stays in place
    // and all terminal activity is posted as thread replies.
    // The anchor message is NOT moved after posting messages.

    it('should not move or delete anchor message when messages are synced', async () => {
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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['123'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'anchor-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Anchor message should NOT be deleted (stays in place)
      expect(mockClient.chat.delete).not.toHaveBeenCalled();
    });

    it('should not modify anchor when no new messages', async () => {
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [],
        newOffset: 1000,
      });

      startWatching('channel-1', undefined, mockSession, mockClient, 'anchor-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT delete or update anchor message when no new content
      expect(mockClient.chat.delete).not.toHaveBeenCalled();
      expect(mockClient.chat.update).not.toHaveBeenCalled();
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

    it('should NOT advance offset - relies on messageMap for deduplication', async () => {
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

      // Offset should NOT advance - we rely on messageMap for deduplication
      expect(watcher?.fileOffset).toBe(1000);
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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['already-posted-123'],
      }]);

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

      // Offset should NOT advance - we rely on messageMap for deduplication
      const watcher = getWatcher('channel-1');
      expect(watcher?.fileOffset).toBe(1000);
    });

    it('should retry failed messages on next poll via messageMap', async () => {
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
      expect(watcher?.fileOffset).toBe(1000); // Not advanced (offset never advances)

      // Timer poll - should succeed (message is re-read from same offset, messageMap filters duplicates)
      await vi.advanceTimersByTimeAsync(2000);

      watcher = getWatcher('channel-1');
      expect(watcher?.fileOffset).toBe(1000); // Still not advanced - we rely on messageMap
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
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessage as any,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['no-double-post-123'],
      }]);

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

    it('should not re-process empty messages on subsequent polls (prevents infinite loop)', async () => {
      // In turn-based model, empty user messages don't form turns and are simply ignored
      // This prevents infinite loops because there's nothing to post or track
      const emptyMessage = {
        type: 'user',
        uuid: 'empty-msg-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: [] },  // No text content
      };

      // Return same empty message on every read (simulating no offset advance)
      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [emptyMessage],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.buildActivityEntriesFromMessage).mockReturnValue([]);
      // Empty messages don't form turns (isUserTextInput returns false for empty arrays)
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([]);

      // Track messageMap state
      let messageMapUuids = new Set<string>();
      vi.mocked(sessionManager.getMessageMapUuids).mockImplementation(() => messageMapUuids);
      vi.mocked(sessionManager.saveMessageMapping).mockImplementation((channelId, ts, mapping) => {
        messageMapUuids.add(mapping.sdkMessageId);
      });

      mockClient.chat.postMessage.mockResolvedValue({ ts: 'msg-ts' });

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // First poll - no turns formed, nothing to post
      await vi.advanceTimersByTimeAsync(2000);

      // Second poll - same message returned, still no turns, no action
      await vi.advanceTimersByTimeAsync(2000);

      // In turn-based model, empty messages that don't form turns
      // are not posted and not tracked - this is fine because:
      // 1. No posting means no rate limit issues
      // 2. No tracking means low memory overhead
      // 3. No infinite loop because we're not stuck trying to post anything

      // Verify no content messages were posted (only status messages if any)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const contentPosts = postCalls.filter(
        call => (call[0] as any).text?.includes('Terminal')
      );
      expect(contentPosts.length).toBe(0);

      // saveMessageMapping should NOT be called for empty messages that don't form turns
      const emptyMsgCalls = (sessionManager.saveMessageMapping as any).mock.calls.filter(
        (call: any[]) => call[2]?.sdkMessageId === 'empty-msg-uuid'
      );
      expect(emptyMsgCalls.length).toBe(0);
    });
  });

  describe('planFilePath persistence', () => {
    it('should initialize planFilePath from session on startup', async () => {
      const sessionWithPlanFile = {
        ...mockSession,
        planFilePath: '/path/to/existing-plan.md',
      };

      startWatching('channel-1', undefined, sessionWithPlanFile, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.planFilePath).toBe('/path/to/existing-plan.md');
    });

    it('should initialize planFilePath to null when session has no planFilePath', async () => {
      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      const watcher = getWatcher('channel-1');
      expect(watcher?.planFilePath).toBeNull();
    });

    it('should persist planFilePath to session when detected in main channel', async () => {
      // Mock plan file detection during message sync
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue('/path/to/new-plan.md');

      const mockUserInput = {
        type: 'user',
        uuid: 'user-plan-1',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'enter plan mode' },
      };
      const mockEnterPlanMode = {
        type: 'assistant',
        uuid: 'enter-plan-1',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'EnterPlanMode' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockEnterPlanMode],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [mockEnterPlanMode as any], textOutput: null }],
        trailingActivity: [],
        allMessageUuids: ['user-plan-1', 'enter-plan-1'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should have persisted planFilePath to main channel session
      expect(sessionManager.saveSession).toHaveBeenCalledWith('channel-1', {
        planFilePath: '/path/to/new-plan.md',
      });
      expect(sessionManager.saveThreadSession).not.toHaveBeenCalled();

      // Reset mock for next test
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue(null);
    });

    it('should persist planFilePath to thread session when detected in thread', async () => {
      // Mock plan file detection during message sync
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue('/path/to/thread-plan.md');

      const mockUserInput = {
        type: 'user',
        uuid: 'user-plan-thread',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'enter plan mode' },
      };
      const mockEnterPlanMode = {
        type: 'assistant',
        uuid: 'enter-plan-thread',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'EnterPlanMode' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockEnterPlanMode],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [mockEnterPlanMode as any], textOutput: null }],
        trailingActivity: [],
        allMessageUuids: ['user-plan-thread', 'enter-plan-thread'],
      }]);

      // Start watching a thread
      startWatching('channel-1', 'thread-ts-123', mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should have persisted planFilePath to thread session
      expect(sessionManager.saveThreadSession).toHaveBeenCalledWith('channel-1', 'thread-ts-123', {
        planFilePath: '/path/to/thread-plan.md',
      });
      expect(sessionManager.saveSession).not.toHaveBeenCalled();

      // Reset mock for next test
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue(null);
    });

    it('should update watcher state planFilePath when detected', async () => {
      // Mock plan file detection during message sync
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue('/path/to/detected-plan.md');

      const mockUserInput = {
        type: 'user',
        uuid: 'user-plan-update',
        timestamp: '2024-01-01T00:00:00Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'enter plan mode' },
      };
      const mockEnterPlanMode = {
        type: 'assistant',
        uuid: 'enter-plan-update',
        timestamp: '2024-01-01T00:00:01Z',
        sessionId: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'EnterPlanMode' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [mockUserInput, mockEnterPlanMode],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockUserInput as any,
        segments: [{ activityMessages: [mockEnterPlanMode as any], textOutput: null }],
        trailingActivity: [],
        allMessageUuids: ['user-plan-update', 'enter-plan-update'],
      }]);

      startWatching('channel-1', undefined, mockSession, mockClient, 'status-ts');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Watcher state should be updated
      const watcher = getWatcher('channel-1');
      expect(watcher?.planFilePath).toBe('/path/to/detected-plan.md');

      // Reset mock for next test
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue(null);
    });
  });
});
