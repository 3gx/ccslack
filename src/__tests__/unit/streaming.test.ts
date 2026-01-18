import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startStreamingSession, streamToSlack, uploadMarkdownWithResponse } from '../../streaming.js';
import { createMockSlackClient } from '../__fixtures__/slack-messages.js';
import { createMockClaudeStream, mockSystemInit, mockAssistantText, mockAssistantContentBlocks, mockResult } from '../__fixtures__/claude-messages.js';

describe('streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startStreamingSession', () => {
    it('should try native streaming first', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.startStream = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      expect(mockClient.chat.startStream).toHaveBeenCalledWith({
        channel: 'C123',
        recipient_user_id: 'U123',
      });
      expect(session.appendText).toBeDefined();
      expect(session.finish).toBeDefined();
      expect(session.error).toBeDefined();
      expect(session.messageTs).toBeNull(); // Native streaming has no message to delete
    });

    it('should fall back to chat.postMessage when native fails', async () => {
      const mockClient = createMockSlackClient();

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
        threadTs: '12345.67890',
      });

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '12345.67890',
        text: '\u200B', // Zero-width space - invisible placeholder
      });
      expect(session.appendText).toBeDefined();
      expect(session.messageTs).toBe('msg123'); // Fallback exposes messageTs for abort cleanup
    });

    it('should use native appendStream when available', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.startStream = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });
      mockClient.chat.appendStream = vi.fn().mockResolvedValue({});

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      await session.appendText('Hello');

      expect(mockClient.chat.appendStream).toHaveBeenCalledWith({
        stream_id: 'stream-123',
        markdown_text: 'Hello',
      });
    });

    it('should use native stopStream for finish', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.startStream = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });
      mockClient.chat.stopStream = vi.fn().mockResolvedValue({});

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      await session.finish();

      expect(mockClient.chat.stopStream).toHaveBeenCalledWith({
        stream_id: 'stream-123',
      });
    });

    it('should use native stopStream with error message for error', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.startStream = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });
      mockClient.chat.stopStream = vi.fn().mockResolvedValue({});

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      await session.error('Something went wrong');

      expect(mockClient.chat.stopStream).toHaveBeenCalledWith({
        stream_id: 'stream-123',
        error_message: 'Something went wrong',
      });
    });
  });

  describe('fallback streaming', () => {
    it('should accumulate text and update on finish', async () => {
      const mockClient = createMockSlackClient();

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      await session.appendText('Hello ');
      await session.appendText('World');
      await session.finish();

      expect(mockClient.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: 'msg123',
        text: 'Hello World',
      });
    });

    it('should throttle updates to respect rate limits', async () => {
      const mockClient = createMockSlackClient();

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      // First append should trigger update after interval
      await session.appendText('Hello');

      // Advance time by 2 seconds (UPDATE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockClient.chat.update).toHaveBeenCalled();
    });

    it('should handle error in fallback mode', async () => {
      const mockClient = createMockSlackClient();

      const session = await startStreamingSession(mockClient as any, {
        channel: 'C123',
        userId: 'U123',
      });

      await session.error('Connection lost');

      expect(mockClient.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: 'msg123',
        text: 'Error: Connection lost',
      });
    });
  });

  describe('streamToSlack', () => {
    it('should capture session ID from init message', async () => {
      const mockClient = createMockSlackClient();
      const mockStream = createMockClaudeStream([mockSystemInit])();

      const result = await streamToSlack(
        mockClient as any,
        { channel: 'C123', userId: 'U123' },
        mockStream
      );

      expect(result.sessionId).toBe('session-abc123');
    });

    it('should handle string content from assistant', async () => {
      const mockClient = createMockSlackClient();
      const mockStream = createMockClaudeStream([mockAssistantText])();

      const result = await streamToSlack(
        mockClient as any,
        { channel: 'C123', userId: 'U123' },
        mockStream
      );

      expect(result.fullResponse).toBe('Here is my analysis of the code...');
    });

    it('should handle array content blocks from assistant', async () => {
      const mockClient = createMockSlackClient();
      const mockStream = createMockClaudeStream([mockAssistantContentBlocks])();

      const result = await streamToSlack(
        mockClient as any,
        { channel: 'C123', userId: 'U123' },
        mockStream
      );

      expect(result.fullResponse).toBe('Let me help you with that. Here are my findings.');
    });

    it('should handle result message', async () => {
      const mockClient = createMockSlackClient();
      const mockStream = createMockClaudeStream([mockResult])();

      const result = await streamToSlack(
        mockClient as any,
        { channel: 'C123', userId: 'U123' },
        mockStream
      );

      expect(result.fullResponse).toBe('Final complete response from Claude');
    });

    it('should handle full conversation flow', async () => {
      const mockClient = createMockSlackClient();
      const messages = [
        mockSystemInit,
        mockAssistantText,
        mockResult,
      ];
      const mockStream = createMockClaudeStream(messages)();

      const result = await streamToSlack(
        mockClient as any,
        { channel: 'C123', userId: 'U123' },
        mockStream
      );

      expect(result.sessionId).toBe('session-abc123');
      expect(result.fullResponse).toBe('Final complete response from Claude');
    });

    it('should call error handler when iterator throws', async () => {
      const mockClient = createMockSlackClient();

      async function* errorStream() {
        yield mockSystemInit;
        throw new Error('Claude API error');
      }

      await expect(
        streamToSlack(
          mockClient as any,
          { channel: 'C123', userId: 'U123' },
          errorStream()
        )
      ).rejects.toThrow('Claude API error');

      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Error: Claude API error',
        })
      );
    });
  });

  describe('uploadMarkdownWithResponse', () => {
    it('should upload .md file with response as initial_comment', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'msg123' }] } },
        }],
      });

      const result = await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        '# Hello\n\nThis is **markdown**',
        'Hello\n\nThis is *markdown*',  // Slack-formatted
        'thread123'
      );

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          content: '# Hello\n\nThis is **markdown**',
          initial_comment: 'Hello\n\nThis is *markdown*',
          title: 'Full Response (Markdown)',
        })
      );
      expect(result).toEqual({ ts: 'msg123' });
    });

    it('should generate unique .md filename with timestamp and markdown filetype', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ shares: { public: { 'C123': [{ ts: 'msg123' }] } } }],
      });

      await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw md', 'slack formatted');

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: expect.stringMatching(/^response-\d+\.md$/),
          filetype: 'markdown',
        })
      );
    });

    it('should work without threadTs (main channel)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ shares: { public: { 'C123': [{ ts: 'msg123' }] } } }],
      });

      await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw', 'formatted');

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: undefined,
        })
      );
    });

    it('should return null on upload failure', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      const result = await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted'
      );

      expect(result).toBeNull();
    });

    it('should send ephemeral notification on failure when userId provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted',
        'thread123',
        'U456'
      );

      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith({
        channel: 'C123',
        user: 'U456',
        text: expect.stringContaining('Failed to attach .md file'),
      });
    });

    it('should not send ephemeral notification when userId not provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted',
        'thread123'
        // no userId
      );

      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it('should ignore ephemeral failure silently', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));
      mockClient.chat.postEphemeral = vi.fn().mockRejectedValue(new Error('Ephemeral failed'));

      // Should not throw
      const result = await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted',
        'thread123',
        'U456'
      );

      expect(result).toBeNull();
    });

    it('should return null when files array is empty', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({ ok: true, files: [] });

      const result = await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw', 'formatted');

      expect(result).toBeNull();
    });

    it('should return success with undefined ts when shares not available', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }], // no shares - but upload succeeded
      });

      const result = await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw', 'formatted');

      // Should return success (not null) even without ts
      expect(result).toEqual({ ts: undefined });
    });

    it('should handle private channel shares', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { private: { 'C123': [{ ts: 'private-msg-ts' }] } },
        }],
      });

      const result = await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw', 'formatted');

      expect(result).toEqual({ ts: 'private-msg-ts' });
    });
  });
});
