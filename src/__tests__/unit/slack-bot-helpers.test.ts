import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebClient } from '@slack/web-api';

// Mock @slack/bolt before any imports that use it
vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    event() {}
    message() {}
    action() {}
    view() {}
    async start() { return Promise.resolve(); }
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
    },
  },
}));

// Mock session-reader
vi.mock('../../session-reader.js', () => ({
  getSessionFilePath: vi.fn(),
  sessionFileExists: vi.fn().mockReturnValue(false),
  readLastUserMessageUuid: vi.fn().mockReturnValue(null),
  extractPlanFilePathFromInput: vi.fn().mockReturnValue(null),
}));

// Mock session-manager
vi.mock('../../session-manager.js', () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getOrCreateThreadSession: vi.fn().mockReturnValue({
    session: { sessionId: null, workingDir: '/test', mode: 'default', createdAt: Date.now(), lastActiveAt: Date.now() },
    isNewFork: false,
  }),
  getThreadSession: vi.fn(),
  saveThreadSession: vi.fn(),
  saveMessageMapping: vi.fn(),
  findForkPointMessageId: vi.fn().mockReturnValue(null),
  deleteSession: vi.fn(),
  saveActivityLog: vi.fn().mockResolvedValue(undefined),
  getActivityLog: vi.fn().mockResolvedValue(null),
  getSegmentActivityLog: vi.fn().mockReturnValue(null),
  saveSegmentActivityLog: vi.fn(),
  updateSegmentActivityLog: vi.fn(),
  generateSegmentKey: vi.fn(),
  clearSegmentActivityLogs: vi.fn(),
}));

// Mock claude-client
vi.mock('../../claude-client.js', () => ({
  streamClaude: vi.fn(),
  startClaudeQuery: vi.fn(),
}));

// Mock concurrent-check
vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test'),
}));

// Mock model-cache
vi.mock('../../model-cache.js', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([]),
  isModelAvailable: vi.fn().mockResolvedValue(true),
  refreshModelCache: vi.fn().mockResolvedValue(undefined),
  getModelInfo: vi.fn().mockResolvedValue({ value: 'claude-sonnet', displayName: 'Claude Sonnet' }),
}));

// Import mocks after setup
import fs from 'fs';
import { getSessionFilePath } from '../../session-reader.js';

// Import functions under test - need dynamic import due to slack-bot module dependencies
// We'll test via a simplified approach by testing the logic patterns

describe('getThinkingContentFromSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when session file does not exist', async () => {
    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // Import dynamically to get fresh module
    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    const result = await getThinkingContentFromSession(
      'test-session-id',
      Date.now(),
      100,
      '/test/dir'
    );

    expect(result).toBeNull();
    expect(getSessionFilePath).toHaveBeenCalledWith('test-session-id', '/test/dir');
  });

  it('should return matching thinking content by timestamp and charCount', async () => {
    const timestamp = new Date('2025-01-24T10:00:00.000Z').getTime();
    const thinkingContent = 'This is the thinking content for testing';

    const sessionData = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-24T10:00:00.000Z',
      message: {
        content: [
          { type: 'thinking', thinking: thinkingContent }
        ]
      }
    });

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    const result = await getThinkingContentFromSession(
      'test-session-id',
      timestamp,
      thinkingContent.length,
      '/test/dir'
    );

    expect(result).toBe(thinkingContent);
  });

  it('should return null when no matching entry found (wrong charCount)', async () => {
    const timestamp = new Date('2025-01-24T10:00:00.000Z').getTime();
    const thinkingContent = 'This is the thinking content';

    const sessionData = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-24T10:00:00.000Z',
      message: {
        content: [
          { type: 'thinking', thinking: thinkingContent }
        ]
      }
    });

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    // Use wrong charCount
    const result = await getThinkingContentFromSession(
      'test-session-id',
      timestamp,
      999, // wrong charCount
      '/test/dir'
    );

    expect(result).toBeNull();
  });

  it('should return null when no matching entry found (timestamp too far)', async () => {
    const thinkingContent = 'This is the thinking content';

    const sessionData = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-24T10:00:00.000Z',
      message: {
        content: [
          { type: 'thinking', thinking: thinkingContent }
        ]
      }
    });

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    // Use timestamp that's 2 seconds off (beyond ±1s tolerance)
    const wrongTimestamp = new Date('2025-01-24T10:00:02.000Z').getTime();
    const result = await getThinkingContentFromSession(
      'test-session-id',
      wrongTimestamp,
      thinkingContent.length,
      '/test/dir'
    );

    expect(result).toBeNull();
  });

  it('should allow timestamp tolerance of ±1 second', async () => {
    const thinkingContent = 'Thinking with slight timestamp variance';

    const sessionData = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-24T10:00:00.500Z', // 500ms
      message: {
        content: [
          { type: 'thinking', thinking: thinkingContent }
        ]
      }
    });

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    // Use timestamp that's 800ms off (within ±1s tolerance)
    const slightlyOffTimestamp = new Date('2025-01-24T10:00:00.500Z').getTime() + 800;
    const result = await getThinkingContentFromSession(
      'test-session-id',
      slightlyOffTimestamp,
      thinkingContent.length,
      '/test/dir'
    );

    expect(result).toBe(thinkingContent);
  });

  it('should skip non-assistant messages', async () => {
    const timestamp = new Date('2025-01-24T10:00:00.000Z').getTime();
    const thinkingContent = 'Assistant thinking';

    const sessionData = [
      JSON.stringify({
        type: 'user',
        timestamp: '2025-01-24T10:00:00.000Z',
        message: { content: 'User message' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2025-01-24T10:00:00.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: thinkingContent }
          ]
        }
      })
    ].join('\n');

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    const result = await getThinkingContentFromSession(
      'test-session-id',
      timestamp,
      thinkingContent.length,
      '/test/dir'
    );

    expect(result).toBe(thinkingContent);
  });

  it('should skip malformed JSON lines', async () => {
    const timestamp = new Date('2025-01-24T10:00:00.000Z').getTime();
    const thinkingContent = 'Valid thinking content';

    const sessionData = [
      'not valid json',
      '{ incomplete json',
      JSON.stringify({
        type: 'assistant',
        timestamp: '2025-01-24T10:00:00.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: thinkingContent }
          ]
        }
      })
    ].join('\n');

    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(sessionData);

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    const result = await getThinkingContentFromSession(
      'test-session-id',
      timestamp,
      thinkingContent.length,
      '/test/dir'
    );

    expect(result).toBe(thinkingContent);
  });

  it('should return null on file read error', async () => {
    vi.mocked(getSessionFilePath).mockReturnValue('/test/session.jsonl');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('Read error'));

    const { getThinkingContentFromSession } = await import('../../slack-bot.js');

    const result = await getThinkingContentFromSession(
      'test-session-id',
      Date.now(),
      100,
      '/test/dir'
    );

    expect(result).toBeNull();
  });
});

describe('updateThinkingMessageWithRetry', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockClient = {
      chat: {
        update: vi.fn(),
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://slack.com/msg' }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return true on successful update (first try)', async () => {
    mockClient.chat.update.mockResolvedValue({ ok: true });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const result = await updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    expect(result).toBe(true);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1234.5678',
      text: 'Updated text',
    });
  });

  it('should retry on transient errors and succeed', async () => {
    mockClient.chat.update
      .mockRejectedValueOnce({ data: { error: 'rate_limited' } })
      .mockRejectedValueOnce({ data: { error: 'internal_error' } })
      .mockResolvedValue({ ok: true });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const resultPromise = updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    // Advance through backoff delays (1s, 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;

    expect(result).toBe(true);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(3);
  });

  it('should NOT retry on permanent error (message_not_found)', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'message_not_found' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const result = await updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    expect(result).toBe(false);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1); // No retries
    expect(mockClient.chat.postMessage).toHaveBeenCalled(); // Error logged
  });

  it('should NOT retry on permanent error (channel_not_found)', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'channel_not_found' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const result = await updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    expect(result).toBe(false);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on permanent error (no_permission)', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'no_permission' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const result = await updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    expect(result).toBe(false);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on permanent error (msg_too_long)', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'msg_too_long' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const result = await updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C123'
    );

    expect(result).toBe(false);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
  });

  it('should log error to main channel after all retries exhausted', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'internal_error' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const resultPromise = updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      3, // Only 3 attempts
      'C_MAIN'
    );

    // Advance through backoff delays (1s, 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;

    expect(result).toBe(false);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(3);
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C_MAIN',
      text: expect.stringContaining('Failed to update thinking message'),
    });
  });

  it('should include permalink in error message when available', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'internal_error' } });
    mockClient.chat.getPermalink.mockResolvedValue({
      ok: true,
      permalink: 'https://slack.com/archives/C123/p1234'
    });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const resultPromise = updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      1, // Single attempt
      'C_MAIN'
    );

    const result = await resultPromise;

    expect(result).toBe(false);
    expect(mockClient.chat.getPermalink).toHaveBeenCalled();
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C_MAIN',
      text: expect.stringContaining('https://slack.com/archives/C123/p1234'),
    });
  });

  it('should use fallback URL format when getPermalink API fails', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'internal_error' } });
    mockClient.chat.getPermalink.mockReset();
    mockClient.chat.getPermalink.mockRejectedValue(new Error('Permalink API failed'));

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const resultPromise = updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      1,
      'C_MAIN'
    );

    const result = await resultPromise;

    expect(result).toBe(false);
    // getMessagePermalink falls back to manual URL construction when API fails
    // Fallback format: https://slack.com/archives/${channel}/p${ts.replace('.', '')}
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C_MAIN',
      text: ':warning: Failed to update thinking message. File was uploaded but <https://slack.com/archives/C123/p12345678|message> could not be updated.',
    });
  });

  it('should use exponential backoff (1s, 2s, 3s, 4s, 5s)', async () => {
    mockClient.chat.update.mockRejectedValue({ data: { error: 'rate_limited' } });

    const { updateThinkingMessageWithRetry } = await import('../../slack-bot.js');

    const resultPromise = updateThinkingMessageWithRetry(
      mockClient as WebClient,
      'C123',
      '1234.5678',
      'Updated text',
      5,
      'C_MAIN'
    );

    // Check backoff timing
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // 1s backoff
    expect(mockClient.chat.update).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000); // 2s backoff
    expect(mockClient.chat.update).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3000); // 3s backoff
    expect(mockClient.chat.update).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(4000); // 4s backoff
    expect(mockClient.chat.update).toHaveBeenCalledTimes(5);

    // Let the promise complete
    await resultPromise;
  });

  describe('stripAnsiCodes', () => {
    it('should strip color codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Green text: \x1B[32m ... \x1B[39m (reset foreground)
      expect(stripAnsiCodes('\x1B[32m✓\x1B[39m test passed')).toBe('✓ test passed');
    });

    it('should strip bold codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Bold: \x1B[1m ... \x1B[22m (reset bold)
      expect(stripAnsiCodes('\x1B[1mbold text\x1B[22m')).toBe('bold text');
    });

    it('should strip reset codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Reset all: \x1B[0m
      expect(stripAnsiCodes('text\x1B[0m more')).toBe('text more');
    });

    it('should strip multiple SGR parameters', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Bold green: \x1B[1;32m
      expect(stripAnsiCodes('\x1B[1;32mhello\x1B[0m')).toBe('hello');
    });

    it('should strip cursor movement codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Clear line: \x1B[2K, Cursor up: \x1B[1A
      expect(stripAnsiCodes('\x1B[2Kline\x1B[1A')).toBe('line');
    });

    it('should handle text without ANSI codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      expect(stripAnsiCodes('plain text')).toBe('plain text');
    });

    it('should handle empty string', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      expect(stripAnsiCodes('')).toBe('');
    });

    it('should handle complex vitest output', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      // Simulated vitest output with colors
      const input = '\x1B[32m✓\x1B[39m src/__tests__/unit/blocks.test.ts \x1B[2m(335 tests)\x1B[22m';
      const expected = '✓ src/__tests__/unit/blocks.test.ts (335 tests)';
      expect(stripAnsiCodes(input)).toBe(expected);
    });

    it('should strip adjacent codes', async () => {
      const { stripAnsiCodes } = await import('../../slack-bot.js');
      expect(stripAnsiCodes('\x1B[1m\x1B[32mtest\x1B[0m\x1B[0m')).toBe('test');
    });
  });
});
