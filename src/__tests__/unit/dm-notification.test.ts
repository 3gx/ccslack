import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  clearSyncedMessageUuids: vi.fn(),
  addSlackOriginatedUserUuid: vi.fn(),
}));

// Mock claude-client
vi.mock('../../claude-client.js', () => ({
  startClaudeQuery: vi.fn(),
}));

// Mock streaming
vi.mock('../../streaming.js', () => ({
  sendStreamingMessage: vi.fn(),
  updateStreamingMessage: vi.fn(),
  finalizeStreamingMessage: vi.fn(),
}));

// Mock model-cache
vi.mock('../../model-cache.js', () => ({
  getCachedModels: vi.fn().mockResolvedValue([]),
  invalidateModelCache: vi.fn(),
}));

// Mock markdown-png
vi.mock('../../markdown-png.js', () => ({
  markdownToPng: vi.fn().mockResolvedValue(Buffer.from('')),
}));

// Mock abort-tracker
vi.mock('../../abort-tracker.js', () => ({
  isAborted: vi.fn().mockReturnValue(false),
  markAborted: vi.fn(),
  clearAbort: vi.fn(),
}));

// Mock terminal-watcher
vi.mock('../../terminal-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  getWatchingSessionId: vi.fn().mockReturnValue(null),
}));

// Mock activity-thread
vi.mock('../../activity-thread.js', () => ({
  postActivityEntry: vi.fn().mockResolvedValue(undefined),
}));

// Mock ff-abort-tracker
vi.mock('../../ff-abort-tracker.js', () => ({
  isFfAborted: vi.fn().mockReturnValue(false),
  markFfAborted: vi.fn(),
  clearFfAbort: vi.fn(),
}));

// Mock message-sync
vi.mock('../../message-sync.js', () => ({
  syncMessagesToSlack: vi.fn().mockResolvedValue({ totalSynced: 0 }),
}));

// Mock file-handler
vi.mock('../../file-handler.js', () => ({
  processSlackFiles: vi.fn().mockResolvedValue({ files: [], warnings: [] }),
}));

// Mock content-builder
vi.mock('../../content-builder.js', () => ({
  buildMessageContent: vi.fn().mockReturnValue('test'),
}));

// Mock concurrent-check
vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue(false),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue(''),
}));

import { sendDmNotification, clearDmNotificationDebounce, DM_DEBOUNCE_MS, truncateQueryForPreview } from '../../slack-bot.js';

describe('sendDmNotification', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDmNotificationDebounce();

    mockClient = {
      users: {
        info: vi.fn().mockResolvedValue({ ok: true, user: { is_bot: false } }),
      },
      conversations: {
        info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'test-channel' } }),
        open: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'D123' } }),
      },
      chat: {
        getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://slack.com/msg' }),
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  });

  it('should open DM and post message with permalink', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
      queryPreview: 'fix the bug',
    });

    expect(mockClient.conversations.open).toHaveBeenCalledWith({ users: 'U123' });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D123',
        text: expect.stringContaining('fix the bug'),
      })
    );
  });

  it('should include subtitle in message when provided', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '🔧',
      title: 'Tool approval needed',
      subtitle: 'Claude wants to use: Edit',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining('Claude wants to use: Edit'),
            }),
          }),
        ]),
      })
    );
  });

  it('should skip for DM channels', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'D456', // DM channel
      messageTs: '123.456',
      emoji: '✅',
      title: 'Test',
    });

    expect(mockClient.conversations.open).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('should skip for missing userId', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: '', // Empty userId
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Test',
    });

    expect(mockClient.conversations.open).not.toHaveBeenCalled();
  });

  it('should debounce notifications of same type within 15 seconds', async () => {
    // First call - should send
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

    // Second call within debounce window with SAME title - should skip
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.457',
      emoji: '✅',
      title: 'Query completed',
    });

    // Should still be 1 call (second was skipped due to same title)
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('should allow different notification types within debounce window', async () => {
    // Query completed notification
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

    // Question notification with DIFFERENT title - should NOT be debounced
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.457',
      emoji: '❓',
      title: 'Question needs your input',
    });

    // Both should have sent (different notification types)
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it('should allow notifications after debounce window expires', async () => {
    const originalDateNow = Date.now;
    let mockTime = 1000000;
    Date.now = vi.fn(() => mockTime);

    try {
      // First call
      await sendDmNotification({
        client: mockClient,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '123.456',
        emoji: '✅',
        title: 'First',
      });

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // Advance time past debounce window
      mockTime += DM_DEBOUNCE_MS + 1000;

      // Second call - should send (debounce expired)
      await sendDmNotification({
        client: mockClient,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '123.457',
        emoji: '🔧',
        title: 'Second',
      });

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('should skip silently for bot users', async () => {
    mockClient.users.info.mockResolvedValue({ ok: true, user: { is_bot: true } });

    await sendDmNotification({
      client: mockClient,
      userId: 'UBOT123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Test',
    });

    expect(mockClient.conversations.open).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('should silently fail on error', async () => {
    mockClient.users.info.mockRejectedValue(new Error('API error'));
    mockClient.conversations.open.mockRejectedValue(new Error('Open failed'));

    // Should not throw
    await expect(
      sendDmNotification({
        client: mockClient,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '123.456',
        emoji: '✅',
        title: 'Test',
      })
    ).resolves.not.toThrow();
  });

  it('should use fallback channel name when conversations.info fails', async () => {
    mockClient.conversations.info.mockRejectedValue(new Error('Channel info failed'));

    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('the channel'),
      })
    );
  });

  it('should not send DM if conversations.open fails', async () => {
    mockClient.conversations.open.mockResolvedValue({ ok: false });

    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Test',
    });

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('should include correct block structure with View button', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '📋',
      title: 'Plan ready for review',
      queryPreview: 'refactor the code',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              type: 'mrkdwn',
              text: expect.stringContaining('refactor the code'),
            }),
            accessory: expect.objectContaining({
              type: 'button',
              text: expect.objectContaining({ text: 'View →' }),
              url: 'https://slack.com/msg',
              action_id: 'dm_notification_view',
            }),
          }),
        ],
      })
    );
  });

  it('should track debounce per user independently', async () => {
    // User 1 sends notification
    await sendDmNotification({
      client: mockClient,
      userId: 'U111',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'User 1 notification',
    });

    // User 2 sends notification - should not be debounced
    await sendDmNotification({
      client: mockClient,
      userId: 'U222',
      channelId: 'C456',
      messageTs: '123.457',
      emoji: '✅',
      title: 'User 2 notification',
    });

    // Both should have sent
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it('should include queryPreview in message when provided', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
      queryPreview: 'fix the login bug',
    });

    // New simplified format: ✅ `query` in #channel (no "from", no title)
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('`fix the login bug`'),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining('`fix the login bug`'),
            }),
          }),
        ]),
      })
    );
  });

  it('should not include from clause when queryPreview is empty', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '✅',
      title: 'Query completed',
      queryPreview: '',
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining('from'),
      })
    );
  });

  it('should include both queryPreview and subtitle when both provided', async () => {
    await sendDmNotification({
      client: mockClient,
      userId: 'U123',
      channelId: 'C456',
      messageTs: '123.456',
      emoji: '🔧',
      title: 'Tool approval needed',
      subtitle: 'Claude wants to use: Edit',
      queryPreview: 'update the config',
    });

    // New simplified format: 🔧 `query` in #channel\nsubtitle
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              // Use [\s\S] to match any character including newlines
              text: expect.stringMatching(/`update the config`[\s\S]*Claude wants to use: Edit/),
            }),
          }),
        ]),
      })
    );
  });
});

describe('truncateQueryForPreview', () => {
  it('should return empty string for undefined input', () => {
    expect(truncateQueryForPreview(undefined)).toBe('');
  });

  it('should return empty string for empty input', () => {
    expect(truncateQueryForPreview('')).toBe('');
  });

  it('should return short text unchanged', () => {
    expect(truncateQueryForPreview('fix the bug')).toBe('fix the bug');
  });

  it('should truncate long text at 50 characters with ellipsis', () => {
    const longQuery = 'this is a very long query that should be truncated because it exceeds fifty characters';
    const result = truncateQueryForPreview(longQuery);
    expect(result.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(result).toMatch(/\.\.\.$/);
  });

  it('should remove backticks from text', () => {
    expect(truncateQueryForPreview('fix the `config.ts` file')).toBe('fix the config.ts file');
  });

  it('should collapse whitespace', () => {
    expect(truncateQueryForPreview('fix   the\n\nbug')).toBe('fix the bug');
  });

  it('should handle text with only backticks', () => {
    expect(truncateQueryForPreview('```code```')).toBe('code');
  });

  it('should trim whitespace', () => {
    expect(truncateQueryForPreview('  fix the bug  ')).toBe('fix the bug');
  });

  it('should handle custom maxLength', () => {
    const result = truncateQueryForPreview('this is a test query', 10);
    expect(result).toBe('this is a...');
  });
});
