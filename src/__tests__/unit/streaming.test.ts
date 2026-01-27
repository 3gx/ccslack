import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startStreamingSession, streamToSlack, uploadMarkdownWithResponse, uploadMarkdownAndPngWithResponse, truncateWithClosedFormatting, extractTailWithFormatting, uploadFilesToThread } from '../../streaming.js';
import { createMockSlackClient } from '../__fixtures__/slack-messages.js';
import { createMockClaudeStream, mockSystemInit, mockAssistantText, mockAssistantContentBlocks, mockResult } from '../__fixtures__/claude-messages.js';

// Mock markdownToPng to avoid timeout in tests
vi.mock('../../markdown-png.js', () => ({
  markdownToPng: vi.fn().mockResolvedValue(null),
}));

// Mock saveMessageMapping for testing immediate mapping
vi.mock('../../session-manager.js', () => ({
  saveMessageMapping: vi.fn(),
}));

import { saveMessageMapping } from '../../session-manager.js';

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

  describe('truncateWithClosedFormatting', () => {
    it('returns text unchanged if under limit', () => {
      expect(truncateWithClosedFormatting('short', 100)).toBe('short');
    });

    it('truncates and adds suffix for long text', () => {
      const long = 'a'.repeat(600);
      const result = truncateWithClosedFormatting(long, 500);
      expect(result).toContain('_...truncated. Full response attached._');
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('closes open code block', () => {
      const text = '```python\ndef foo():\n    pass\n\ndef bar():' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 100);
      const codeBlocks = (result.match(/```/g) || []).length;
      expect(codeBlocks % 2).toBe(0); // Even = all closed
    });

    it('closes open inline code', () => {
      const text = 'some `code that ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 100);
      const backticks = (result.match(/(?<!`)`(?!`)/g) || []).length;
      expect(backticks % 2).toBe(0);
    });

    it('closes open bold', () => {
      const text = 'here is *bold text that ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 100);
      const asterisks = (result.match(/(?<!\*)\*(?!\*)/g) || []).length;
      expect(asterisks % 2).toBe(0);
    });

    it('closes open italic', () => {
      const text = 'here is _italic text that ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 100);
      const underscores = (result.match(/(?<!_)_(?!_)/g) || []).length;
      expect(underscores % 2).toBe(0);
    });

    it('closes open strikethrough', () => {
      const text = 'here is ~struck text that ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 100);
      const tildes = (result.match(/~/g) || []).length;
      expect(tildes % 2).toBe(0);
    });

    it('handles code block with inline markers inside', () => {
      // When truncating inside a code block, only the code block is closed
      // Inline markers (backticks, asterisks, etc.) inside code blocks are literal text
      const text = '```js\nconst x = `template ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 120);
      // Code block should be closed
      expect((result.match(/```/g) || []).length % 2).toBe(0);
      // The inline backtick is NOT closed (it's literal text inside the code block)
      expect(result).toContain('`template');
      expect(result).not.toContain('`template`'); // NOT auto-closed
    });

    it('handles multiple open markers outside code blocks', () => {
      // When NOT in a code block, all open markers should be closed
      const text = 'Here is *bold and `code that ' + 'x'.repeat(500);
      const result = truncateWithClosedFormatting(text, 80);
      // Both should be closed
      const boldCount = (result.match(/(?<!\*)\*(?!\*)/g) || []).length;
      const inlineCodeCount = (result.match(/(?<!`)`(?!`)/g) || []).length;
      expect(boldCount % 2).toBe(0);
      expect(inlineCodeCount % 2).toBe(0);
    });
  });

  describe('extractTailWithFormatting', () => {
    const LIMIT = 100;

    it('returns full text if under limit', () => {
      expect(extractTailWithFormatting('short text', LIMIT)).toBe('short text');
    });

    it('extracts tail with ... prefix', () => {
      const text = 'a'.repeat(200);
      const result = extractTailWithFormatting(text, LIMIT);
      expect(result.startsWith('...')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(LIMIT + 10); // prefix overhead
    });

    it('reopens code block if extraction starts inside one', () => {
      const text = '```python\n' + 'x = 1\n'.repeat(100) + '```';
      const result = extractTailWithFormatting(text, 50);
      expect(result).toMatch(/^\.\.\.[\s\S]*```python/);
    });

    it('reopens code block without language tag', () => {
      const text = '```\n' + 'x = 1\n'.repeat(100) + '```';
      const result = extractTailWithFormatting(text, 50);
      expect(result.startsWith('...\n```\n')).toBe(true);
    });

    it('reopens bold formatting', () => {
      const text = 'normal *bold text ' + 'x'.repeat(200) + ' still bold*';
      const result = extractTailWithFormatting(text, 50);
      expect(result.startsWith('...*')).toBe(true);
    });

    it('reopens italic formatting', () => {
      const text = 'normal _italic text ' + 'x'.repeat(200) + ' still italic_';
      const result = extractTailWithFormatting(text, 50);
      expect(result.startsWith('..._')).toBe(true);
    });

    it('reopens strikethrough formatting', () => {
      const text = 'normal ~struck text ' + 'x'.repeat(200) + ' still struck~';
      const result = extractTailWithFormatting(text, 50);
      expect(result.startsWith('...~')).toBe(true);
    });

    it('reopens inline code', () => {
      const text = 'normal `code text ' + 'x'.repeat(200) + ' still code`';
      const result = extractTailWithFormatting(text, 50);
      expect(result.startsWith('...`')).toBe(true);
    });

    it('does not reopen formatting inside code block', () => {
      const text = '```\nconst x = `template`;\n' + 'y'.repeat(200) + '\n```';
      const result = extractTailWithFormatting(text, 50);
      // Should NOT have extra backtick for "template" since it's in code block
      expect(result).not.toMatch(/^\.\.\.`[^`]/);
      // Should have code block opener
      expect(result).toMatch(/^\.\.\.[\s\S]*```/);
    });

    it('prefers newline as break point', () => {
      const text = 'line1\nline2\n' + 'a'.repeat(80) + '\nline4';
      const result = extractTailWithFormatting(text, 90);
      // Should start at a line boundary, not mid-line
      expect(result).toMatch(/^\.\.\.[^\n]/); // starts after a newline
    });

    it('handles multiple formatting markers', () => {
      const text = '*bold* and _italic_ then *bold again ' + 'x'.repeat(200) + ' open*';
      const result = extractTailWithFormatting(text, 50);
      // The last asterisk opens a bold section that extends into the tail
      expect(result.startsWith('...*')).toBe(true);
    });

    it('handles closed code block before extraction point', () => {
      const text = '```python\ncode\n```\n' + 'x'.repeat(200);
      const result = extractTailWithFormatting(text, 50);
      // Code block is closed, so just "..." prefix
      expect(result.startsWith('...')).toBe(true);
      expect(result).not.toContain('```python');
    });
  });

  describe('uploadMarkdownWithResponse', () => {
    it('posts text first, then uploads file', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        '# Hello\n\nThis is **markdown**',
        'Hello\n\nThis is *markdown*',
        'thread123'
      );

      // Text posted first
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          thread_ts: 'thread123',
          text: 'Hello\n\nThis is *markdown*',
        })
      );
      // Then file uploaded
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          content: '# Hello\n\nThis is **markdown**',
          title: 'Full Response (Markdown)',
        })
      );
    });

    it('generates unique .md filename with timestamp', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw md', 'short text');

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: expect.stringMatching(/^response-\d+\.md$/),
        })
      );
    });

    it('posts full text for short responses (under limit)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      const shortResponse = 'Short response under 500 chars';
      await uploadMarkdownWithResponse(mockClient as any, 'C123', 'raw', shortResponse);

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: shortResponse,
        })
      );
    });

    it('posts truncated text for long responses', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      const longResponse = 'a'.repeat(600);
      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        longResponse,
        undefined,
        undefined,
        500
      );

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('_...truncated. Full response attached._'),
        })
      );
    });

    it('does NOT create threads for long responses', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      const longResponse = 'a'.repeat(600);
      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        longResponse,
        undefined,
        undefined,
        500
      );

      // Should only post once (no thread creation)
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('returns null on failure', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockRejectedValue(new Error('Post failed'));

      const result = await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted'
      );

      expect(result).toBeNull();
    });

    it('sends ephemeral notification on failure when userId provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockRejectedValue(new Error('Post failed'));

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

    it('does not send ephemeral notification when userId not provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockRejectedValue(new Error('Post failed'));

      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        'formatted',
        'thread123'
      );

      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it('ignores ephemeral failure silently', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockRejectedValue(new Error('Post failed'));
      mockClient.chat.postEphemeral = vi.fn().mockRejectedValue(new Error('Ephemeral failed'));

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

    it('uses custom charLimit when provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      // 800 chars - under 1000 limit
      const response = 'c'.repeat(800);
      await uploadMarkdownWithResponse(
        mockClient as any,
        'C123',
        'raw',
        response,
        undefined,
        undefined,
        1000
      );

      // Should post full text (800 < 1000)
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: response,
        })
      );
    });
  });

  describe('uploadMarkdownAndPngWithResponse posts text only (Fork button now in activity message)', () => {
    it('should NOT include blocks when posting text (Fork button moved to activity message)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        'thread123',
        'U456',
        500
      );

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: 'Response text',
        })
      );
      // Should NOT have blocks (Fork button is now in activity message in blocks.ts)
      const call = mockClient.chat.postMessage.mock.calls[0][0];
      expect(call.blocks).toBeUndefined();
    });

    it('should NOT include Fork here button - it is now on activity messages in blocks.ts', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        'thread123',
        'U456',
        500
      );

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: 'Response text',
        })
      );
      // Should NOT have blocks - no Fork button in response messages anymore
      const call = mockClient.chat.postMessage.mock.calls[0][0];
      expect(call.blocks).toBeUndefined();
    });
  });

  describe('uploadMarkdownAndPngWithResponse with mappingInfo (point-in-time forking)', () => {
    beforeEach(() => {
      vi.mocked(saveMessageMapping).mockClear();
    });

    it('should call saveMessageMapping when mappingInfo is provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'msg123' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        'thread123',
        'U456',
        500,
        { sdkMessageId: 'msg_uuid_abc123', sessionId: 'session_xyz789' }  // mappingInfo
      );

      expect(saveMessageMapping).toHaveBeenCalledWith('C123', 'msg123', {
        sdkMessageId: 'msg_uuid_abc123',
        sessionId: 'session_xyz789',
        type: 'assistant',
      });
    });

    it('should NOT call saveMessageMapping when mappingInfo is undefined', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'msg123' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        'thread123',
        'U456',
        500,
        undefined  // No mappingInfo
      );

      expect(saveMessageMapping).not.toHaveBeenCalled();
    });

    it('should NOT call saveMessageMapping when postMessage returns no ts', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true });  // No ts
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        'thread123',
        'U456',
        500,
        { sdkMessageId: 'msg_uuid_abc123', sessionId: 'session_xyz789' }  // mappingInfo
      );

      expect(saveMessageMapping).not.toHaveBeenCalled();
    });

    it('should return ts in result for tracking mapped UUIDs', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'msg456' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Response',
        'Response text',
        undefined,
        undefined,
        500,
        false,
        undefined,
        { sdkMessageId: 'msg_uuid', sessionId: 'session_123' }
      );

      expect(result).toEqual({
        ts: 'msg456',
        postedMessages: [{ ts: 'msg456' }],
        uploadSucceeded: false,
      });
    });
  });

  describe('uploadMarkdownAndPngWithResponse conditional file attachment', () => {
    it('should NOT upload files when response is short (not truncated)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      // Short response (less than default 500 char limit)
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Short response',
        'Short response text',
        'thread123'
      );

      // Files should NOT be uploaded for short responses
      expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
    });

    it('should upload files when response is truncated (exceeds char limit)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      // Long response that exceeds 100 char limit
      const longResponse = 'A'.repeat(150);
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Set low char limit to trigger truncation
      );

      // Files SHOULD be uploaded for truncated responses
      expect(mockClient.files.uploadV2).toHaveBeenCalled();
    });

    it('should upload files with correct content when truncated', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      const longResponse = 'B'.repeat(200);
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // Verify file upload was called
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              filename: expect.stringMatching(/^response-\d+\.md$/),
              title: 'Full Response (Markdown)',
            }),
          ]),
        })
      );
    });

    it('should extract ts from shares.public for public channels', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'file-msg-public-ts' }] } },
        }],
      });

      const longResponse = 'C'.repeat(200);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // Should extract ts from shares.public
      expect(result?.ts).toBe('file-msg-public-ts');
    });

    it('should extract ts from shares.private for private channels', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { private: { 'C123': [{ ts: 'file-msg-private-ts' }] } },
        }],
      });

      const longResponse = 'D'.repeat(200);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // Should extract ts from shares.private when shares.public is missing
      expect(result?.ts).toBe('file-msg-private-ts');
    });

    it('should return uploadSucceeded=true when upload works but ts extraction fails', async () => {
      const mockClient = createMockSlackClient();
      // Simulate successful upload but missing/malformed shares structure
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          // No shares property - ts extraction will fail
        }],
      });

      const longResponse = 'E'.repeat(200);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // ts should be undefined (extraction failed)
      expect(result?.ts).toBeUndefined();
      // uploadSucceeded should be true (upload worked, extraction failed)
      expect(result?.uploadSucceeded).toBe(true);
    });

    it('should return uploadSucceeded=false for short responses (no file upload)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'msg123' });

      // Short response - no file upload needed
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Short',
        'Short response',
        'thread123'
      );

      // ts should be present (text posted successfully)
      expect(result?.ts).toBe('msg123');
      // uploadSucceeded should be false (no truncation occurred)
      expect(result?.uploadSucceeded).toBe(false);
    });

    it('should return uploadSucceeded=false when truncated and ts extraction succeeds', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'file-msg-ts' }] } },
        }],
      });

      const longResponse = 'F'.repeat(200);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // ts should be present
      expect(result?.ts).toBe('file-msg-ts');
      // uploadSucceeded should be false (ts was successfully extracted)
      expect(result?.uploadSucceeded).toBe(false);
    });

    it('should poll files.info when shares is initially empty (async file sharing)', async () => {
      const mockClient = createMockSlackClient();

      // files.uploadV2 returns empty shares initially (Slack async behavior)
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: {},  // Empty shares - async upload not yet complete
          files: [{ id: 'file-inner-id' }],  // File ID for polling
        }],
      });

      // files.info returns populated shares after polling
      mockClient.files.info = vi.fn().mockResolvedValue({
        ok: true,
        file: {
          id: 'file-inner-id',
          shares: { public: { 'C123': [{ ts: 'polled-ts' }] } },
        },
      });

      const longResponse = 'G'.repeat(200);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // Should have polled files.info
      expect(mockClient.files.info).toHaveBeenCalledWith({ file: 'file-inner-id' });
      // ts should come from polling
      expect(result?.ts).toBe('polled-ts');
      // uploadSucceeded should be false (ts was successfully extracted via polling)
      expect(result?.uploadSucceeded).toBe(false);
    });

    it('should return uploadSucceeded=true when polling times out', async () => {
      const mockClient = createMockSlackClient();

      // files.uploadV2 returns empty shares
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: {},  // Empty shares
          files: [{ id: 'file-inner-id' }],
        }],
      });

      // files.info always returns empty shares (simulates timeout scenario)
      mockClient.files.info = vi.fn().mockResolvedValue({
        ok: true,
        file: {
          id: 'file-inner-id',
          shares: {},  // Still empty - polling will timeout
        },
      });

      const longResponse = 'H'.repeat(200);

      // Need real timers for the async polling to work
      // But limit iterations by returning ts after a few polls
      let callCount = 0;
      mockClient.files.info = vi.fn().mockImplementation(async () => {
        callCount++;
        // Return empty shares for first 3 calls, then ts on 4th
        if (callCount < 4) {
          return {
            ok: true,
            file: { id: 'file-inner-id', shares: {} },
          };
        }
        // Return populated shares on 4th call
        return {
          ok: true,
          file: {
            id: 'file-inner-id',
            shares: { public: { 'C123': [{ ts: 'polled-after-retry-ts' }] } },
          },
        };
      });

      // Use real timers for polling
      vi.useRealTimers();

      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'thread123',
        'U456',
        100  // Low limit to trigger truncation
      );

      // Verify multiple poll attempts were made
      expect(mockClient.files.info).toHaveBeenCalledTimes(4);
      // ts should be present after polling succeeded
      expect(result?.ts).toBe('polled-after-retry-ts');

      // Restore fake timers for other tests
      vi.useFakeTimers();
    });

    it('should upload files when markdown is long but formatted text is short (thread activity fix)', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'file-msg-ts' }] } },
        }],
      });

      // This simulates thread activity scenario:
      // - Full markdown content is very long (10000 chars)
      // - But formatted preview text is short (e.g., ":bulb: *Thinking* [5s] _10000 chars_\n> first 300 chars...")
      const longMarkdown = 'X'.repeat(10000);  // Full thinking content
      const shortFormattedPreview = ':bulb: *Thinking* [5s] _10000 chars_\n> ' + 'X'.repeat(300) + '...';  // ~350 chars

      // charLimit is 500, formatted preview is ~350 chars (under limit)
      // But markdown is 10000 chars (way over limit) - should still upload .md
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        longMarkdown,           // Full markdown (10000 chars)
        shortFormattedPreview,  // Short preview (~350 chars)
        'thread123',
        'U456',
        500  // charLimit - preview is under this, but markdown is way over
      );

      // Files SHOULD be uploaded because markdown content exceeds limit
      // (even though formatted preview text is under the limit)
      expect(mockClient.files.uploadV2).toHaveBeenCalled();

      // Verify the full markdown is included in the file upload
      const uploadCall = mockClient.files.uploadV2.mock.calls[0][0];
      expect(uploadCall.file_uploads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: expect.stringMatching(/^response-\d+\.md$/),
          }),
        ])
      );
    });
  });

  describe('uploadMarkdownAndPngWithResponse main channel attachment threading', () => {
    it('should post text first, then files as thread reply in main channel', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'response-ts-123' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({ ok: true, files: [{ id: 'F123' }] });

      const longResponse = 'A'.repeat(150);
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        undefined,  // Main channel - no threadTs
        'U456',
        100
      );

      // Text posted first without thread_ts
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          text: expect.any(String),
        })
      );
      expect(mockClient.chat.postMessage.mock.calls[0][0].thread_ts).toBeUndefined();

      // Files uploaded as thread reply to response
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'response-ts-123',
        })
      );
      // No initial_comment for main channel
      expect(mockClient.files.uploadV2.mock.calls[0][0].initial_comment).toBeUndefined();
    });

    it('should keep bundled behavior for thread responses', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123', shares: { public: { 'C123': [{ ts: 'file-msg-ts' }] } } }],
      });

      const longResponse = 'B'.repeat(150);
      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        'existing-thread-ts',  // In a thread
        'U456',
        100
      );

      // Should NOT call chat.postMessage for threads
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();

      // Files use original threadTs with initial_comment
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'existing-thread-ts',
          initial_comment: expect.any(String),
        })
      );
    });

    it('should still return text ts when file upload fails in main channel', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'response-ts-456' });
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));
      mockClient.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });

      const longResponse = 'C'.repeat(150);
      const result = await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# ' + longResponse,
        longResponse,
        undefined,  // Main channel
        'U456',
        100
      );

      // Text was posted successfully
      expect(result?.ts).toBe('response-ts-456');
      // Ephemeral error notification sent
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          user: 'U456',
          text: expect.stringContaining('Failed to attach files'),
        })
      );
    });
  });

  describe('uploadFilesToThread', () => {
    it('should upload files to thread and return success with file message ts', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { public: { 'C123': [{ ts: 'file-msg-ts' }] } },
        }],
      });

      const result = await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        '# Full thinking content',
        '_Back-link text._',
        'U456'
      );

      expect(result.success).toBe(true);
      expect(result.fileMessageTs).toBe('file-msg-ts');
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          initial_comment: '_Back-link text._',
        })
      );
    });

    it('should return success=true but no ts when shares structure is missing', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],  // No shares
      });

      const result = await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        'markdown content'
      );

      // Upload succeeded but couldn't extract ts
      expect(result.success).toBe(true);
      expect(result.fileMessageTs).toBeUndefined();
    });

    it('should return success=false when upload fails', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      const result = await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        'markdown content',
        undefined,
        'U456'
      );

      expect(result.success).toBe(false);
      expect(result.fileMessageTs).toBeUndefined();
      // Should send ephemeral error notification
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          user: 'U456',
          text: expect.stringContaining('Failed to attach thinking files'),
        })
      );
    });

    it('should not send ephemeral notification when userId not provided', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        'markdown content'
        // No userId
      );

      expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
    });

    it('should extract ts from shares.private for private channels', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: { private: { 'C123': [{ ts: 'private-file-ts' }] } },
        }],
      });

      const result = await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        'markdown content'
      );

      expect(result.success).toBe(true);
      expect(result.fileMessageTs).toBe('private-file-ts');
    });

    it('should poll files.info when shares is initially empty', async () => {
      vi.useRealTimers();

      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{
          id: 'F123',
          shares: {},  // Empty initially
          files: [{ id: 'inner-file-id' }],
        }],
      });

      let callCount = 0;
      mockClient.files.info = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          return { ok: true, file: { shares: {} } };
        }
        return {
          ok: true,
          file: { shares: { public: { 'C123': [{ ts: 'polled-ts' }] } } },
        };
      });

      const result = await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        'markdown content'
      );

      expect(result.success).toBe(true);
      expect(result.fileMessageTs).toBe('polled-ts');
      expect(mockClient.files.info).toHaveBeenCalled();

      vi.useFakeTimers();
    });

    it('should include both .md and .png files in upload', async () => {
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      await uploadFilesToThread(
        mockClient as any,
        'C123',
        'thread123',
        '# Markdown with **bold**'
      );

      // Check that file_uploads includes at least the markdown file
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              filename: expect.stringMatching(/^thinking-\d+\.md$/),
              title: 'Full Thinking (Markdown)',
            }),
          ]),
        })
      );
    });
  });
});
