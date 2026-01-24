import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncMessagesFromOffset, MessageSyncState, SyncResult } from '../../message-sync.js';
import * as sessionReader from '../../session-reader.js';
import * as sessionManager from '../../session-manager.js';
import * as sessionEventStream from '../../session-event-stream.js';
import * as blocks from '../../blocks.js';

// Mock session-reader module
vi.mock('../../session-reader.js', () => ({
  readNewMessages: vi.fn(() => Promise.resolve({ messages: [], newOffset: 0 })),
  extractTextContent: vi.fn((msg) => {
    if (typeof msg.message?.content === 'string') return msg.message.content;
    return msg.message?.content?.find((b: any) => b.type === 'text')?.text || '';
  }),
  groupMessagesByTurn: vi.fn(() => []),
  isTurnComplete: vi.fn((turn) => turn.trailingActivity.length === 0 && turn.segments.length > 0),
  extractPlanFilePathFromMessage: vi.fn(() => null),  // Plan detection for /watch
  hasExitPlanMode: vi.fn(() => false),  // ExitPlanMode detection for /watch
}));

// Mock session-manager module
vi.mock('../../session-manager.js', () => ({
  getMessageMapUuids: vi.fn(() => new Set<string>()),
  saveMessageMapping: vi.fn(),
  isSlackOriginatedUserUuid: vi.fn(() => false),  // Default: not Slack-originated
}));

// Mock session-event-stream module
vi.mock('../../session-event-stream.js', () => ({
  readActivityLog: vi.fn(() => Promise.resolve([])),
}));

// Mock blocks module
vi.mock('../../blocks.js', () => ({
  buildLiveActivityBlocks: vi.fn(() => [
    { type: 'section', text: { type: 'mrkdwn', text: ':brain: *Thinking...*' } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Fork here' } }] },
  ]),
  formatThreadActivityBatch: vi.fn(() => ':white_check_mark: *Read* [0.1s]'),
}));

// Mock activity-thread module
vi.mock('../../activity-thread.js', () => ({
  postActivityToThread: vi.fn(() => Promise.resolve({ ts: 'thread-reply-ts' })),
  postThinkingToThread: vi.fn(() => Promise.resolve('thinking-ts')),
}));

// Mock retry module
vi.mock('../../retry.js', () => ({
  withSlackRetry: vi.fn((fn) => fn()),
  withInfiniteRetry: vi.fn((fn) => fn()),
  sleep: vi.fn(() => Promise.resolve()),
}));

// Mock streaming module
import * as streaming from '../../streaming.js';
vi.mock('../../streaming.js', () => ({
  truncateWithClosedFormatting: vi.fn((text, limit) => text.substring(0, limit) + '\n\n_...truncated. Full response attached._'),
  uploadMarkdownWithResponse: vi.fn(() => Promise.resolve({ ts: 'upload-md-ts' })),
}));

// Mock fs module for getMessageMap
import * as fs from 'fs';
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    existsSync: vi.fn((path: string) => {
      if (path === './sessions.json') return true;
      return actual.existsSync(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (path === './sessions.json') {
        // Return mock messageMap
        return JSON.stringify({
          channels: {
            'channel-1': {
              messageMap: {},
            },
          },
        });
      }
      return actual.readFileSync(path, encoding as BufferEncoding);
    }),
  };
});

describe('message-sync', () => {
  let mockClient: any;
  let mockState: MessageSyncState;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
        update: vi.fn().mockResolvedValue({ ts: 'update-ts' }),
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
    vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([]);
    vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set<string>());
    vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([]);
    vi.mocked(streaming.uploadMarkdownWithResponse).mockResolvedValue({ ts: 'upload-md-ts' });
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

    it('should skip turns when all messages already in messageMap', async () => {
      const mockMessages = [
        { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'Hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      ];

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: mockMessages,
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: mockMessages[0],
        segments: [{ activityMessages: [], textOutput: mockMessages[1] }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set(['u1', 'a1']));

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      expect(result).toEqual({
        newOffset: 2000,
        syncedCount: 0,
        totalToSync: 0,
        wasAborted: false,
        allSucceeded: true,
      });
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('should post turn with user input, activity, and text response', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello world' },
      };
      const activityMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm...' }] },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) => {
        if (msg.uuid === 'u1') return 'Hello world';
        if (msg.uuid === 'a2') return 'Hi there!';
        return '';
      });
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking', thinkingContent: 'hmm...' },
      ]);

      // Import activity-thread to check calls
      const { postThinkingToThread } = await import('../../activity-thread.js');

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With threading: posts user input, text response, and Fork button as siblings
      // Activity goes to thread replies (via postThinkingToThread)
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(3);

      // First: user input with :inbox_tray: prefix
      expect(mockClient.chat.postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        channel: 'channel-1',
        text: expect.stringContaining(':inbox_tray:'),
      }));

      // Activity posted as thread reply (thinking entry)
      expect(postThinkingToThread).toHaveBeenCalled();

      // Second: text response
      expect(mockClient.chat.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        channel: 'channel-1',
        text: 'Hi there!',
      }));

      // Third: Fork button message (activity summary with Fork button, posted after segments)
      expect(mockClient.chat.postMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
        channel: 'channel-1',
        blocks: expect.any(Array),
        text: 'Activity summary',
      }));

      expect(result.syncedCount).toBe(3);
      expect(result.allSucceeded).toBe(true);
    });

    it('should use buildLiveActivityBlocks for activity summary (fallback when in thread)', async () => {
      // When already in a thread, activity uses fallback sibling posting with buildLiveActivityBlocks
      const threadState = {
        ...mockState,
        threadTs: 'thread-123',  // Already in a thread - can't create nested threads
        conversationKey: 'channel-1_thread-123',
      };

      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking...' }, { type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_complete', tool: 'Read', durationMs: 100 },
      ]);

      await syncMessagesFromOffset(threadState, '/path/to/file.jsonl', 0);

      // buildLiveActivityBlocks should be called for fallback (in-thread scenario)
      expect(blocks.buildLiveActivityBlocks).toHaveBeenCalled();
    });

    it('should skip user input if already posted (partial turn recovery)', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a1' ? 'Response' : 'Hello'
      );
      // User input already posted
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set(['u1']));

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Should only post text response, not user input
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Response',
      }));
    });

    it('should skip user input that originated from Slack bot (not terminal)', async () => {
      const userMsg = {
        type: 'user', uuid: 'slack-user-uuid', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello from Slack' },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['slack-user-uuid', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a1' ? 'Response' : 'Hello from Slack'
      );
      // User input NOT in messageMap (not posted yet)
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set());
      // But user input IS Slack-originated (from @Claude Code mention)
      vi.mocked(sessionManager.isSlackOriginatedUserUuid).mockImplementation(
        (_channelId, uuid, _threadTs) => uuid === 'slack-user-uuid'
      );

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Should NOT post user input (it's from Slack, already visible)
      // Should only post text response
      const postCalls = mockClient.chat.postMessage.mock.calls;
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][0].text).toBe('Response');

      // Verify isSlackOriginatedUserUuid was called
      expect(sessionManager.isSlackOriginatedUserUuid).toHaveBeenCalledWith(
        'channel-1',
        'slack-user-uuid',
        undefined // no threadTs
      );
    });

    it('should UPDATE activity when partial activity already posted (via activityMessages Map)', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg1 = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking...' }] },
      };
      const activityMsg2 = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg1, activityMsg2],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg1, activityMsg2],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_complete', tool: 'Read' },
      ]);

      // u1 and a1 already posted
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set(['u1', 'a1']));

      // NEW: Use activityMessages Map instead of messageMap lookup
      // Pre-populate with existing activity ts for this turn (keyed by userInput UUID)
      const activityMessages = new Map<string, string>();
      activityMessages.set('u1', 'existing-activity-ts');  // Turn's userInput UUID → Slack ts

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        activityMessages,
      });

      // Should call chat.update for activity (not postMessage)
      expect(mockClient.chat.update).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'channel-1',
        ts: 'existing-activity-ts',
        blocks: expect.any(Array),
        text: 'Activity summary updated',
      }));

      // Should NOT post user input again
      expect(mockClient.chat.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining(':inbox_tray:'),
      }));
    });

    it('should POST new activity when UPDATE fails with message_not_found', async () => {
      // This tests the fallback behavior when a Slack message was deleted
      // The code should detect message_not_found and post a new message instead
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg1 = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking...' }] },
      };
      const activityMsg2 = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg1, activityMsg2],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg1, activityMsg2],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_complete', tool: 'Read' },
      ]);

      // u1 and a1 already posted
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set(['u1', 'a1']));

      // NEW: Use activityMessages Map with deleted message ts
      const activityMessages = new Map<string, string>();
      activityMessages.set('u1', 'deleted-activity-ts');

      // Make chat.update fail with message_not_found error
      const messageNotFoundError = new Error('An API error occurred: message_not_found');
      (messageNotFoundError as any).data = { error: 'message_not_found' };
      mockClient.chat.update.mockRejectedValue(messageNotFoundError);

      // chat.postMessage should succeed for the fallback
      mockClient.chat.postMessage.mockResolvedValue({ ts: 'new-activity-ts' });

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        activityMessages,
      });

      // Should have tried to update first
      expect(mockClient.chat.update).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'channel-1',
        ts: 'deleted-activity-ts',
      }));

      // Should have fallen back to posting a new message (activity summary)
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'channel-1',
        blocks: expect.any(Array),
        text: 'Activity summary',
      }));
    });

    it('should NOT post new activity when UPDATE fails with other errors', async () => {
      // For non-message_not_found errors, we should NOT post a new message
      // (to avoid duplicates if the error is transient)
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg1 = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking...' }] },
      };
      const activityMsg2 = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg1, activityMsg2],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg1, activityMsg2],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_start', tool: 'Read' },
      ]);

      // u1 and a1 already posted (a2 is new)
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set(['u1', 'a1']));

      // NEW: Use activityMessages Map with existing activity ts
      const activityMessages = new Map<string, string>();
      activityMessages.set('u1', 'existing-activity-ts');

      // Make chat.update fail with a different error (not message_not_found)
      const rateLimitError = new Error('rate_limited');
      (rateLimitError as any).data = { error: 'rate_limited' };
      mockClient.chat.update.mockRejectedValue(rateLimitError);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        activityMessages,
      });

      // Should have tried to update
      expect(mockClient.chat.update).toHaveBeenCalled();

      // Should NOT have posted a new activity message (only user input is allowed)
      // Filter out user input posts - we should NOT have an activity summary post
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const activitySummaryCalls = postCalls.filter(
        (call: any) => call[0].text === 'Activity summary'
      );
      expect(activitySummaryCalls).toHaveLength(0);
    });

    it('should stop when aborted', async () => {
      const turns = [
        {
          userInput: { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'a' } },
          segments: [],
          trailingActivity: [],
          allMessageUuids: ['u1'],
        },
        {
          userInput: { type: 'user', uuid: 'u2', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'user', content: 'b' } },
          segments: [],
          trailingActivity: [],
          allMessageUuids: ['u2'],
        },
        {
          userInput: { type: 'user', uuid: 'u3', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'user', content: 'c' } },
          segments: [],
          trailingActivity: [],
          allMessageUuids: ['u3'],
        },
      ];

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: turns.map(t => t.userInput),
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue(turns);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('text');

      let callCount = 0;
      mockClient.chat.postMessage.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ts: `ts-${callCount}` });
      });

      // Abort after first turn
      const isAborted = vi.fn().mockImplementation(() => callCount >= 1);

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        isAborted,
      });

      expect(result.wasAborted).toBe(true);
      expect(result.syncedCount).toBe(1);
      expect(result.totalToSync).toBe(3);
    });

    it('should call onProgress callback for each turn', async () => {
      const textOutput1 = { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'response1' }] } };
      const textOutput2 = { type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:03Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'response2' }] } };
      const turns = [
        {
          userInput: { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'a' } },
          segments: [{ activityMessages: [], textOutput: textOutput1 }],
          trailingActivity: [],
          allMessageUuids: ['u1', 'a1'],
        },
        {
          userInput: { type: 'user', uuid: 'u2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'user', content: 'b' } },
          segments: [{ activityMessages: [], textOutput: textOutput2 }],
          trailingActivity: [],
          allMessageUuids: ['u2', 'a2'],
        },
      ];

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [...turns.map(t => t.userInput), textOutput1, textOutput2],
        newOffset: 4000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue(turns);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) => {
        if (msg.uuid === 'a1') return 'response1';
        if (msg.uuid === 'a2') return 'response2';
        return 'text';
      });

      const onProgress = vi.fn().mockResolvedValue(undefined);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      // Progress reports number of posted UUIDs (2 per turn: user + text)
      expect(onProgress).toHaveBeenNthCalledWith(1, 2, 2, textOutput1);
      expect(onProgress).toHaveBeenNthCalledWith(2, 4, 2, textOutput2);
    });

    it('should save message mapping for all posted messages', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a2' ? 'Response' : ''
      );
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
      ]);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Should save mappings for user input and text output
      // Activity goes to thread replies (no composite key needed since posted via postThinkingToThread)
      expect(sessionManager.saveMessageMapping).toHaveBeenCalledWith(
        'channel-1', 'msg-ts', expect.objectContaining({ sdkMessageId: 'u1', type: 'user' })
      );
      // Text output uses regular ts
      expect(sessionManager.saveMessageMapping).toHaveBeenCalledWith(
        'channel-1', 'msg-ts', expect.objectContaining({ sdkMessageId: 'a2', type: 'assistant' })
      );
    });

    it('should post activity as thread replies with threading enabled', async () => {
      // With threading, activity goes to thread replies under user input message
      // Each activity type (thinking, tools) gets its own thread reply
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg1 = {
        type: 'assistant', uuid: 'activity-1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking...' }] },
      };
      const activityMsg2 = {
        type: 'assistant', uuid: 'activity-2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg1, activityMsg2],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg1, activityMsg2],
        allMessageUuids: ['u1', 'activity-1', 'activity-2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking', thinkingContent: 'thinking...' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_complete', tool: 'Read' },
      ]);

      // Import activity-thread to check calls
      const { postThinkingToThread, postActivityToThread } = await import('../../activity-thread.js');

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Activity should be posted as thread replies
      expect(postThinkingToThread).toHaveBeenCalled();
      expect(postActivityToThread).toHaveBeenCalled();

      // User input should still be posted as sibling
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(':inbox_tray:'),
        })
      );
    });

    it('should not reprocess turn when all activity UUIDs are in messageMap', async () => {
      // This test verifies that the composite key fix allows proper deduplication
      // on subsequent /ff runs - all activity UUIDs should be recognized as posted
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const activityMsg1 = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
      };
      const activityMsg2 = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };
      const textMsg = {
        type: 'assistant', uuid: 't1', timestamp: '2024-01-01T00:00:03Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg1, activityMsg2, textMsg],
        newOffset: 4000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg1, activityMsg2], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 'a2', 't1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Done');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01Z'), type: 'thinking' },
        { timestamp: Date.parse('2024-01-01T00:00:02Z'), type: 'tool_complete', tool: 'Read' },
      ]);

      // ALL UUIDs already in messageMap (simulating second /ff run)
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['u1', 'a1', 'a2', 't1'])
      );

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Turn should be completely skipped (0 turns to process)
      expect(result.syncedCount).toBe(0);
      expect(result.totalToSync).toBe(0);

      // No Slack API calls should be made
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });

    it('should handle thread conversations', async () => {
      const threadState = {
        ...mockState,
        threadTs: 'thread-123',
        conversationKey: 'channel-1_thread-123',
      };

      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg],
        newOffset: 1000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [],
        allMessageUuids: ['u1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Hello');

      await syncMessagesFromOffset(threadState, '/path/to/file.jsonl', 0);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'channel-1',
          thread_ts: 'thread-123',
        })
      );
    });

    it('should use postTextMessage callback when provided', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a1' ? 'Response' : 'Hello'
      );

      const postTextMessage = vi.fn().mockResolvedValue(true);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        postTextMessage,
      });

      // Should use postTextMessage for text response (isLastMessage=true since only one turn/segment)
      expect(postTextMessage).toHaveBeenCalledWith(mockState, textMsg, true);
    });

    it('should truncate long text responses', async () => {
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a1' ? 'x'.repeat(1000) : 'Hello'
      );

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        charLimit: 100,
      });

      // Should have posted messages: user input, Fork button, text response
      // (no activity in this case, so no thread replies)
      expect(mockClient.chat.postMessage).toHaveBeenCalled();

      // Find the text response call (has truncated content)
      const textCalls = mockClient.chat.postMessage.mock.calls.filter(
        (call: any) => call[0].text?.includes('xxx')
      );
      expect(textCalls.length).toBeGreaterThan(0);
      const textCall = textCalls[0];
      expect(textCall[0].text.length).toBeLessThan(1000);
      expect(textCall[0].text).toContain('truncated');
    });

    it('should upload .md file for long user input (not just truncate)', async () => {
      const longUserInput = 'x'.repeat(1000);
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: longUserInput },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Short response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'u1' ? longUserInput : 'Short response'
      );

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        charLimit: 100,
      });

      // Long user input should use uploadMarkdownWithResponse (.md only, no PNG)
      expect(streaming.uploadMarkdownWithResponse).toHaveBeenCalledWith(
        mockClient,
        'channel-1',
        longUserInput,  // Original content for .md file
        expect.stringContaining(':inbox_tray:'),  // Prefix included
        undefined,  // threadTs
        undefined,  // userId (not available in MessageSyncState)
        100  // charLimit
      );
    });

    it('should NOT upload .md file for short user input', async () => {
      const shortUserInput = 'Hello';
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: shortUserInput },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'u1' ? shortUserInput : 'Response'
      );

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        charLimit: 100,
      });

      // Short user input should use simple text post
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(':inbox_tray:'),
        })
      );

      // Should NOT upload any files for short input
      expect(streaming.uploadMarkdownWithResponse).not.toHaveBeenCalled();
    });

    it('should NOT trigger onExitPlanMode twice when new messages added to same turn', async () => {
      // This test verifies the fix for duplicate plan display in /watch.
      // Scenario:
      // Poll 1: Turn has [user, ExitPlanMode] - plan displayed
      // Poll 2: Turn has [user, ExitPlanMode, newText] - plan should NOT display again
      //
      // The bug was that the scan checked ALL activity messages for ExitPlanMode,
      // not just NEW ones. So when the turn was re-processed (due to newText),
      // ExitPlanMode was found again and plan was displayed twice.

      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Plan something' },
      };
      const exitPlanModeMsg = {
        type: 'assistant', uuid: 'exit-plan-uuid', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] },
      };
      const newTextMsg = {
        type: 'assistant', uuid: 'new-text-uuid', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Ready for approval' }] },
      };

      // Configure hasExitPlanMode to return true for the ExitPlanMode message
      vi.mocked(sessionReader.hasExitPlanMode).mockImplementation((msg) =>
        msg.uuid === 'exit-plan-uuid'
      );

      // Poll 2 scenario: ExitPlanMode already posted (from Poll 1), but newText is not
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['u1', 'exit-plan-uuid'])  // ExitPlanMode already posted
      );

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, exitPlanModeMsg, newTextMsg],
        newOffset: 3000,
      });

      // Turn structure after CLI continues: ExitPlanMode moved to segment activity
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{
          activityMessages: [exitPlanModeMsg],  // ExitPlanMode now in segment (was in trailing)
          textOutput: newTextMsg,               // New text output
        }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'exit-plan-uuid', 'new-text-uuid'],
      }]);

      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'new-text-uuid' ? 'Ready for approval' : ''
      );
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([]);

      const onExitPlanMode = vi.fn().mockResolvedValue(undefined);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        onExitPlanMode,
      });

      // Key assertion: onExitPlanMode should NOT be called
      // because ExitPlanMode message UUID is already in alreadyPosted
      expect(onExitPlanMode).not.toHaveBeenCalled();

      // But the new text should still be posted
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Ready for approval',
        })
      );
    });

    it('should trigger onExitPlanMode when ExitPlanMode is NEW', async () => {
      // Complementary test: verify onExitPlanMode IS called when ExitPlanMode is new

      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1',
        message: { role: 'user', content: 'Plan something' },
      };
      const exitPlanModeMsg = {
        type: 'assistant', uuid: 'exit-plan-uuid', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] },
      };

      vi.mocked(sessionReader.hasExitPlanMode).mockImplementation((msg) =>
        msg.uuid === 'exit-plan-uuid'
      );
      vi.mocked(sessionReader.extractPlanFilePathFromMessage).mockReturnValue('/path/to/plan.md');

      // Nothing posted yet
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set());

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, exitPlanModeMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [exitPlanModeMsg],
        allMessageUuids: ['u1', 'exit-plan-uuid'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([]);

      const onExitPlanMode = vi.fn().mockResolvedValue(undefined);
      const onPlanFileDetected = vi.fn();

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0, {
        onExitPlanMode,
        onPlanFileDetected,
      });

      // onExitPlanMode SHOULD be called because ExitPlanMode is new
      expect(onExitPlanMode).toHaveBeenCalledWith('/path/to/plan.md');
      expect(onPlanFileDetected).toHaveBeenCalledWith('/path/to/plan.md');
    });
  });

  describe('groupMessagesByTurn', () => {
    // Test the actual implementation (not mocked)
    it('groups messages into turns at user input boundaries', async () => {
      // Unmock for this test
      const { groupMessagesByTurn } = await vi.importActual<typeof sessionReader>('../../session-reader.js');

      const messages = [
        { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
        { type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] } },
        { type: 'user', uuid: 'u2', timestamp: '2024-01-01T00:00:03Z', sessionId: 's1', message: { role: 'user', content: 'next' } },
        { type: 'assistant', uuid: 'a3', timestamp: '2024-01-01T00:00:04Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'response2' }] } },
      ];

      const turns = groupMessagesByTurn(messages as any);

      expect(turns).toHaveLength(2);
      expect(turns[0].userInput.uuid).toBe('u1');
      expect(turns[0].segments).toHaveLength(1);
      expect(turns[0].segments[0].activityMessages[0].uuid).toBe('a1');
      expect(turns[0].segments[0].textOutput?.uuid).toBe('a2');
      expect(turns[0].allMessageUuids).toEqual(['u1', 'a1', 'a2']);

      expect(turns[1].userInput.uuid).toBe('u2');
      expect(turns[1].segments).toHaveLength(1);
      expect(turns[1].segments[0].textOutput?.uuid).toBe('a3');
      expect(turns[1].allMessageUuids).toEqual(['u2', 'a3']);
    });

    it('handles tool_result messages (not turn boundaries)', async () => {
      const { groupMessagesByTurn } = await vi.importActual<typeof sessionReader>('../../session-reader.js');

      const messages = [
        { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
        // tool_result is array content, not string - should NOT start new turn
        { type: 'user', uuid: 'u2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', content: 'file content' }] } },
        { type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:03Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ];

      const turns = groupMessagesByTurn(messages as any);

      // Should be one turn (tool_result doesn't start new turn)
      expect(turns).toHaveLength(1);
      expect(turns[0].userInput.uuid).toBe('u1');
      expect(turns[0].allMessageUuids).toEqual(['u1', 'a1', 'a2']);
    });

    it('handles turn with activity but no text output', async () => {
      const { groupMessagesByTurn } = await vi.importActual<typeof sessionReader>('../../session-reader.js');

      const messages = [
        { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
        { type: 'user', uuid: 'u2', timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'user', content: 'another' } },
      ];

      const turns = groupMessagesByTurn(messages as any);

      expect(turns).toHaveLength(2);
      expect(turns[0].userInput.uuid).toBe('u1');
      expect(turns[0].trailingActivity).toHaveLength(1);
      expect(turns[0].segments).toHaveLength(0);
      expect(turns[1].userInput.uuid).toBe('u2');
    });

    it('handles turn with text output but no activity', async () => {
      const { groupMessagesByTurn } = await vi.importActual<typeof sessionReader>('../../session-reader.js');

      const messages = [
        { type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'direct response' }] } },
      ];

      const turns = groupMessagesByTurn(messages as any);

      expect(turns).toHaveLength(1);
      expect(turns[0].userInput.uuid).toBe('u1');
      expect(turns[0].segments).toHaveLength(1);
      expect(turns[0].segments[0].activityMessages).toHaveLength(0);
      expect(turns[0].segments[0].textOutput?.uuid).toBe('a1');
    });
  });

  describe('segment-specific activity filtering', () => {
    // These tests verify the logical boundary-based activity filtering
    // which fixes the issue where tool_complete events (with user message timestamps)
    // were being filtered out due to timestamp mismatch with tool_start events.

    it('should include tool_complete with user message timestamp in segment range', async () => {
      // Timeline:
      // T1: userInput
      // T2: assistant msg (thinking + tool_use) → tool_start
      // T3: user msg (tool_result) → tool_complete timestamp = T3
      // T4: assistant msg (text) → textOutput
      //
      // Segment range should be [T1, T4] which includes T3
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00.000Z', sessionId: 's1',
        message: { role: 'user', content: 'Read a file for me' },
      };
      const toolUseMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reading...' }, { type: 'tool_use', name: 'Read' }] },
      };
      // tool_result has a DIFFERENT timestamp (T3) from tool_use (T2)
      // This is the key scenario that the fix addresses
      const textMsg = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:05.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the file content' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, toolUseMsg, textMsg],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [toolUseMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a2' ? 'Here is the file content' : ''
      );

      // Activity log with tool_complete at T3 (3 seconds after tool_start at T1)
      // This simulates a tool that takes 2 seconds to complete
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'thinking', thinkingContent: 'reading...' },
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'tool_start', tool: 'Read' },
        // tool_complete has user msg timestamp (when tool_result arrives), NOT assistant msg timestamp
        { timestamp: Date.parse('2024-01-01T00:00:03.000Z'), type: 'tool_complete', tool: 'Read', durationMs: 2000 },
      ]);

      // Import activity-thread to check calls
      const { postThinkingToThread, postActivityToThread } = await import('../../activity-thread.js');

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With threading, activity goes to thread replies
      // Thinking and tools are posted separately
      expect(postThinkingToThread).toHaveBeenCalled();
      expect(postActivityToThread).toHaveBeenCalled();
    });

    it('should post activity for segment within timestamp range (interleaved approach)', async () => {
      // With interleaved approach, each segment gets its own activity message
      // Activity filtering is at segment level (from previous segment end to this segment's text)
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00.000Z', sessionId: 's1',
        message: { role: 'user', content: 'Do something' },
      };
      const activityMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
      };
      const textMsg = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:02.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 3000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 'a2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a2' ? 'Done' : ''
      );

      // Activity log includes entry at T1 (before text at T2) - should be included
      // Entry at T5 (after text) would be trailing activity, not in this segment
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'thinking', thinkingContent: '...' },
      ]);

      // Import activity-thread to check calls
      const { postThinkingToThread } = await import('../../activity-thread.js');

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With threading, thinking goes to thread reply
      expect(postThinkingToThread).toHaveBeenCalled();
    });

    it('should return activity entries for segment with no activityMessages', async () => {
      // This tests the case where activityMessages is empty but there's still
      // activity in the timestamp range (e.g., thinking embedded in textOutput)
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00.000Z', sessionId: 's1',
        message: { role: 'user', content: 'Hello' },
      };
      // Text output that might have thinking embedded
      const textMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:02.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hi!' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, textMsg],
        newOffset: 2000,
      });
      // Segment has empty activityMessages but textOutput has thinking
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) =>
        msg.uuid === 'a1' ? 'Hi!' : ''
      );

      // Activity log has thinking in the range
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:02.000Z'), type: 'thinking', thinkingContent: 'hmm' },
      ]);

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With empty activityMessages in segments, the turn still gets activity from the turn-level activity log
      // This is testing that the unified activity approach handles empty segment activityMessages
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
    });

    it('should include all trailing activity with no upper bound', async () => {
      // Trailing activity is for in-progress turns - should have no upper timestamp bound
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00.000Z', sessionId: 's1',
        message: { role: 'user', content: 'Do multiple things' },
      };
      const activityMsg = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'tool_use', name: 'Read' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg],
        newOffset: 2000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [],
        trailingActivity: [activityMsg],
        allMessageUuids: ['u1', 'a1'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockReturnValue('');

      // Activity log with entries at various future timestamps
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'thinking', thinkingContent: '...' },
        { timestamp: Date.parse('2024-01-01T00:00:05.000Z'), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.parse('2024-01-01T00:00:10.000Z'), type: 'tool_complete', tool: 'Read', durationMs: 5000 },
        { timestamp: Date.parse('2024-01-01T00:01:00.000Z'), type: 'tool_start', tool: 'Write' },
      ]);

      // Import activity-thread to check calls
      const { postThinkingToThread, postActivityToThread } = await import('../../activity-thread.js');

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With threading, activity goes to thread replies
      expect(postThinkingToThread).toHaveBeenCalled();
      expect(postActivityToThread).toHaveBeenCalled();
    });

    it('should post INTERLEAVED activity messages for multi-segment turn', async () => {
      // With interleaved approach, we post activity per segment (not one for entire turn)
      // Each segment gets: activity as thread reply → text message as sibling
      const userMsg = {
        type: 'user', uuid: 'u1', timestamp: '2024-01-01T00:00:00.000Z', sessionId: 's1',
        message: { role: 'user', content: 'Do two things' },
      };
      const activity1 = {
        type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:00:01.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] },
      };
      const text1 = {
        type: 'assistant', uuid: 't1', timestamp: '2024-01-01T00:00:02.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First done' }] },
      };
      const activity2 = {
        type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:00:03.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write' }] },
      };
      const text2 = {
        type: 'assistant', uuid: 't2', timestamp: '2024-01-01T00:00:04.000Z', sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second done' }] },
      };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activity1, text1, activity2, text2],
        newOffset: 5000,
      });
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [
          { activityMessages: [activity1], textOutput: text1 },
          { activityMessages: [activity2], textOutput: text2 },
        ],
        trailingActivity: [],
        allMessageUuids: ['u1', 'a1', 't1', 'a2', 't2'],
      }]);
      vi.mocked(sessionReader.extractTextContent).mockImplementation((msg) => {
        if (msg.uuid === 't1') return 'First done';
        if (msg.uuid === 't2') return 'Second done';
        return '';
      });

      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.parse('2024-01-01T00:00:01.500Z'), type: 'tool_complete', tool: 'Read', durationMs: 500 },
        { timestamp: Date.parse('2024-01-01T00:00:03.000Z'), type: 'tool_start', tool: 'Write' },
        { timestamp: Date.parse('2024-01-01T00:00:03.500Z'), type: 'tool_complete', tool: 'Write', durationMs: 500 },
      ]);

      // Import activity-thread to check calls
      const { postActivityToThread } = await import('../../activity-thread.js');

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // With threading, each segment's tools go to thread replies
      // postActivityToThread called twice (once per segment)
      expect(postActivityToThread).toHaveBeenCalledTimes(2);
    });
  });

  describe('segment activity deduplication (infinite loop prevention)', () => {
    it('should persist segment activity UUIDs via saveMessageMapping to prevent reprocessing', async () => {
      // This test verifies the fix for the infinite loop bug where segment activity
      // messages were not being persisted to messageMap, causing turns to be
      // reprocessed indefinitely because allMessageUuids included activity UUIDs
      // that were never marked as posted.

      const userMsg = { uuid: 'u1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'Hello' } };
      const activityMsg = { uuid: 'activity-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } };
      const textMsg = { uuid: 'text-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 1000,
      });

      // allMessageUuids includes the activity message UUID
      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'activity-1', 'text-1'],  // activity-1 is included!
      }]);

      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Done');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([
        { timestamp: Date.parse('2024-01-01T00:00:01.000Z'), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.parse('2024-01-01T00:00:01.500Z'), type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ]);

      // First sync - nothing posted yet
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(new Set<string>());

      await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Verify saveMessageMapping was called for the segment activity message
      expect(sessionManager.saveMessageMapping).toHaveBeenCalledWith(
        'channel-1',
        'activity_activity-1',  // Key format: activity_${uuid}
        expect.objectContaining({
          sdkMessageId: 'activity-1',
          sessionId: 'session-123',
          type: 'assistant',
        })
      );
    });

    it('should skip turn when all UUIDs including segment activity are already posted', async () => {
      // This test simulates the second poll after the fix - the turn should be
      // skipped because all UUIDs (including activity) are in alreadyPosted

      const userMsg = { uuid: 'u1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'Hello' } };
      const activityMsg = { uuid: 'activity-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } };
      const textMsg = { uuid: 'text-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 1000,
      });

      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'activity-1', 'text-1'],
      }]);

      // Simulate second poll: ALL UUIDs including activity are now in messageMap
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['u1', 'activity-1', 'text-1'])
      );

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Turn should be skipped (0 turns to process)
      expect(result.syncedCount).toBe(0);
      expect(result.totalToSync).toBe(0);

      // No new messages should be posted
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('should reprocess turn if segment activity UUID is missing from alreadyPosted (bug scenario)', async () => {
      // This test demonstrates what happens WITHOUT the fix - if activity UUID
      // is not in alreadyPosted, the turn gets reprocessed

      const userMsg = { uuid: 'u1', type: 'user' as const, timestamp: '2024-01-01T00:00:00Z', sessionId: 's1', message: { role: 'user', content: 'Hello' } };
      const activityMsg = { uuid: 'activity-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:01Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } };
      const textMsg = { uuid: 'text-1', type: 'assistant' as const, timestamp: '2024-01-01T00:00:02Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } };

      vi.mocked(sessionReader.readNewMessages).mockResolvedValue({
        messages: [userMsg, activityMsg, textMsg],
        newOffset: 1000,
      });

      vi.mocked(sessionReader.groupMessagesByTurn).mockReturnValue([{
        userInput: userMsg,
        segments: [{ activityMessages: [activityMsg], textOutput: textMsg }],
        trailingActivity: [],
        allMessageUuids: ['u1', 'activity-1', 'text-1'],
      }]);

      vi.mocked(sessionReader.extractTextContent).mockReturnValue('Done');
      vi.mocked(sessionEventStream.readActivityLog).mockResolvedValue([]);

      // Simulate bug scenario: activity-1 is MISSING from alreadyPosted
      // (user and text are present, but activity was never persisted)
      vi.mocked(sessionManager.getMessageMapUuids).mockReturnValue(
        new Set(['u1', 'text-1'])  // activity-1 missing!
      );

      const result = await syncMessagesFromOffset(mockState, '/path/to/file.jsonl', 0);

      // Turn IS processed because activity-1 is not in alreadyPosted
      // This is the bug scenario - before the fix, this would cause infinite loop
      expect(result.totalToSync).toBe(1);  // 1 turn to process
    });
  });
});
