import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startStreamingSession, streamToSlack } from '../../streaming.js';
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
        text: '...',
      });
      expect(session.appendText).toBeDefined();
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
});
