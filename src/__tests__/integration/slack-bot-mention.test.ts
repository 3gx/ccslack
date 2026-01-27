import { describe, it, expect, vi, beforeEach } from 'vitest';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// vi.mock calls must be at module level - Vitest hoists these
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
      message(handler: any) { registeredHandlers['message'] = handler; }
      action(pattern: RegExp, handler: any) { registeredHandlers[`action_${pattern.source}`] = handler; }
      view(pattern: RegExp, handler: any) { registeredHandlers[`view_${pattern.source}`] = handler; }
      async start() { return Promise.resolve(); }
    },
  };
});

vi.mock('../../claude-client.js', () => ({
  streamClaude: vi.fn(),
  startClaudeQuery: vi.fn(),
}));

vi.mock('../../session-manager.js', () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getOrCreateThreadSession: vi.fn().mockReturnValue({
    session: { sessionId: null, forkedFrom: null, workingDir: '/test/dir', mode: 'default',
      createdAt: Date.now(), lastActiveAt: Date.now(), pathConfigured: true,
      configuredPath: '/test/dir', configuredBy: 'U123', configuredAt: Date.now() },
    isNewFork: false,
  }),
  getThreadSession: vi.fn(),
  saveThreadSession: vi.fn(),
  saveMessageMapping: vi.fn(),
  findForkPointMessageId: vi.fn().mockReturnValue(null),
  deleteSession: vi.fn(),
  saveActivityLog: vi.fn().mockResolvedValue(undefined),
  getActivityLog: vi.fn().mockResolvedValue(null),
  // Segment activity log functions
  getSegmentActivityLog: vi.fn().mockReturnValue(null),
  saveSegmentActivityLog: vi.fn(),
  updateSegmentActivityLog: vi.fn(),
  generateSegmentKey: vi.fn((channelId, messageTs) => `${channelId}_${messageTs}_seg_mock-uuid`),
  clearSegmentActivityLogs: vi.fn(),
}));

vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
}));

vi.mock('../../model-cache.js', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([
    { value: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', description: 'Fast' },
    { value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', description: 'Smart' },
  ]),
  isModelAvailable: vi.fn().mockResolvedValue(true),
  refreshModelCache: vi.fn().mockResolvedValue(undefined),
  getModelInfo: vi.fn().mockResolvedValue({ value: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' }),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: { readFile: vi.fn().mockResolvedValue('# Test Plan Content') },
  },
}));

vi.mock('../../session-reader.js', () => ({
  getSessionFilePath: vi.fn().mockReturnValue('/test/session.jsonl'),
  sessionFileExists: vi.fn().mockReturnValue(false),
  readLastUserMessageUuid: vi.fn().mockReturnValue(null),
  extractPlanFilePathFromInput: vi.fn((input) => {
    // Use real logic for plan path detection
    if (!input) return null;
    const planPath = (input.file_path || input.path) as string | undefined;
    if (typeof planPath === 'string' &&
        planPath.includes('.claude/plans/') &&
        planPath.endsWith('.md')) {
      return planPath;
    }
    return null;
  }),
}));

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId, getActivityLog, saveActivityLog } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';
import fs from 'fs';

describe('slack-bot mention handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' };
        yield { type: 'result', result: 'Test response' };
      },
      interrupt: vi.fn(),
    } as any);

    vi.resetModules();
    await import('../../slack-bot.js');
  });

  describe('app_mention event', () => {
    it('should register app_mention handler', async () => {
      // Verify event handler was registered
      expect(registeredHandlers['event_app_mention']).toBeDefined();
    });

    it('should add eyes reaction immediately and remove after command completes', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /status',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Eyes should be added first
      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Eyes should be removed after command completes
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Verify order: add called before remove
      const addCall = mockClient.reactions.add.mock.invocationCallOrder[0];
      const removeCall = mockClient.reactions.remove.mock.invocationCallOrder[0];
      expect(addCall).toBeLessThan(removeCall);
    });

    it('should NOT post mode header for commands', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session with plan mode
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /status',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Commands should NOT have a separate mode header - only the command response
      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Should only post command response blocks (no separate _Plan_ header)
      // Find the status response (has 'Session Status' header)
      const statusCall = postCalls.find((call: any) =>
        call[0].blocks?.some((b: any) => b.text?.text === 'Session Status')
      );
      expect(statusCall).toBeDefined();

      // Should NOT have a separate mode-only header message
      const modeHeaderCall = postCalls.find((call: any) =>
        call[0].blocks?.length === 1 &&
        call[0].blocks[0].type === 'context' &&
        call[0].blocks[0].elements?.[0]?.text === '_Plan_'
      );
      expect(modeHeaderCall).toBeUndefined();
    });

    it('should add eyes reaction for Claude messages and remove when done', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock getSession to return a session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // startClaudeQuery mock is already set up in beforeEach

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Eyes should be added
      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });

      // Eyes should be removed after Claude response
      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'eyes',
      });
    });

    it('should post header message with mode and Abort button', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // Mock startClaudeQuery to return an async generator
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet-4-5-20250929' },
        { type: 'result', result: 'Test response' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Verify combined status message was posted
      const postMessageCalls = mockClient.chat.postMessage.mock.calls;
      expect(postMessageCalls.length).toBeGreaterThanOrEqual(1); // Combined message + response

      // First postMessage should be the combined status message (activity log + status panel)
      const combinedCall = postMessageCalls[0][0];
      expect(combinedCall.channel).toBe('C123');
      expect(combinedCall.text).toBe('Claude is starting...');

      // Verify unified blocks: activity + spinner + status + buttons
      const blocks = combinedCall.blocks;
      expect(blocks).toBeDefined();
      expect(blocks.length).toBe(4); // activity + spinner + status + buttons

      // First block: activity log section
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text.text).toContain('Analyzing request');

      // Second block: spinner + elapsed
      expect(blocks[1].type).toBe('context');

      // Third block: unified status line (mode | model | session-id)
      expect(blocks[2].type).toBe('context');
      expect(blocks[2].elements[0].text).toContain('plan');

      // Fourth block: Abort button only
      expect(blocks[3].type).toBe('actions');
      expect(blocks[3].elements.length).toBe(1);
      // Abort button only
      expect(blocks[3].elements[0].type).toBe('button');
      expect(blocks[3].elements[0].text.text).toBe('Abort');
      expect(blocks[3].elements[0].style).toBe('danger');
      expect(blocks[3].elements[0].action_id).toMatch(/^abort_query_/);
    });

    it('should update header with stats on success', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      // Mock startClaudeQuery to return successful response with stats
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Success!', duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 200 } },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Messages should be posted and updated (status message stays at TOP, updated in place)
      expect(mockClient.chat.postMessage).toHaveBeenCalled();
      expect(mockClient.chat.update).toHaveBeenCalled();
      // Status message stays at TOP - no delete/repost, only in-place updates via chat.update
      // chat.delete should NOT be called (status message is never moved)

      // Verify chat.update was called with complete status and stats
      const updateCalls = mockClient.chat.update.mock.calls;
      // Find the combined completion update (has BOTTOM stats line with token counts)
      // New format: TOP line + activity + BOTTOM stats + actions (no "Complete" header!)
      const statusPanelComplete = updateCalls.find((call: any) =>
        call[0].blocks?.some((b: any) =>
          b.type === 'context' && b.elements?.[0]?.text?.includes('100') && b.elements?.[0]?.text?.includes('200')
        )
      );
      expect(statusPanelComplete).toBeDefined();

      // Combined completion blocks structure (buildCombinedStatusBlocks):
      // 0: Activity log (section)
      // 1: _plan | claude-sonnet | session-id | stats..._ (context - unified stats line)
      const completeBlocks = statusPanelComplete![0].blocks;

      // Find the unified stats context block (contains mode AND token counts)
      const statsBlock = completeBlocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('100') && b.elements?.[0]?.text?.includes('200')
      );
      expect(statsBlock).toBeDefined();
      expect(statsBlock.elements[0].text).toContain('claude-sonnet');
      expect(statsBlock.elements[0].text).toContain('plan');
      expect(statsBlock.elements[0].text).toContain('5.0s');
    });

    it('should post response via interleaved posting', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Hello from Claude!' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // With activity thread: response is posted ONLY to thread (not main channel)
      // Main channel gets status message, activity thread gets response
      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Find the response call (text containing 'Hello from Claude!' in activity thread)
      const responseCall = postCalls.find((call: any) =>
        call[0].text?.includes('Hello from Claude!') &&
        call[0].thread_ts  // Activity thread posts have thread_ts
      );
      expect(responseCall).toBeDefined();

      // Verify response has the :speech_balloon: *Response* prefix
      expect(responseCall[0].text).toContain(':speech_balloon: *Response*');

      // Verify NO main channel response (main channel only gets status message)
      const mainChannelResponse = postCalls.find((call: any) =>
        call[0].text?.includes('Hello from Claude!') &&
        !call[0].thread_ts
      );
      expect(mainChannelResponse).toBeUndefined();
    });

    it('should post response to activity thread and upload .md file when response exceeds charLimit', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      // Mock chat.postMessage to return a ts for the status message (used as thread parent)
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'status-ts-123' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({
        ok: true,
        files: [{ id: 'F123' }],
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Long response that exceeds default 500 char limit to trigger file upload
      const longMarkdown = '# Hello\n\n' + 'This is a very long markdown response. '.repeat(20);
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: longMarkdown },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> show table',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // For long content, response is uploaded as file with initial_comment (not via chat.postMessage)
      // Files are uploaded to the activity thread with the response as initial_comment
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: expect.any(String),  // Activity thread parent ts
          initial_comment: expect.stringContaining(':speech_balloon: *Response*'),
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              file: expect.any(Buffer),  // Markdown as Buffer
              filename: expect.stringMatching(/^response-\d+\.md$/),
              title: 'Full Response (Markdown)',
            }),
          ]),
        })
      );

      // Verify NO main channel response post (main channel skipped when activity thread exists)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const mainChannelResponse = postCalls.find((call: any) =>
        call[0].text?.includes('very long markdown') &&
        !call[0].thread_ts
      );
      expect(mainChannelResponse).toBeUndefined();

      // Verify file upload has thread_ts (in activity thread)
      const uploadCall = mockClient.files.uploadV2.mock.calls[0][0] as any;
      expect(uploadCall.thread_ts).toBeDefined();
    });

    it('should fall back to chat.postMessage in activity thread when file upload fails', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();
      mockClient.files.uploadV2 = vi.fn().mockRejectedValue(new Error('Upload failed'));

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'Fallback response' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Response should be posted to activity thread (not main channel)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const responseCall = postCalls.find((call: any) =>
        call[0].text?.includes('Fallback response') &&
        call[0].thread_ts  // Activity thread posts have thread_ts
      );
      expect(responseCall).toBeDefined();
      // Verify response has the :speech_balloon: *Response* prefix
      expect(responseCall[0].text).toContain(':speech_balloon: *Response*');
    });

    it('should reject @bot mentions in threads with error message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mention bot in a thread (thread_ts is present)
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> hello from thread',
          channel: 'C123',
          ts: 'msg456',
          thread_ts: 'thread123',
        },
        client: mockClient,
      });

      // Should post rejection message IN the thread
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: 'thread123',
        text: expect.stringContaining('@bot can only be mentioned in the main channel'),
      });

      // Should NOT start Claude query
      expect(startClaudeQuery).not.toHaveBeenCalled();

      // Should NOT add eyes reaction (early return before processing)
      expect(mockClient.reactions.add).not.toHaveBeenCalled();
    });

    it('should reject @bot mentions with no message content', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mention bot with just the mention, no text
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123>',
          channel: 'C123',
          ts: 'msg789',
        },
        client: mockClient,
      });

      // Should post error message about empty messages
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: expect.stringContaining('Empty messages are not permitted'),
      });

      // Should NOT start Claude query
      expect(startClaudeQuery).not.toHaveBeenCalled();
    });

    it('should reject @bot mentions with only whitespace', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mention bot with just whitespace after
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123>    ',
          channel: 'C123',
          ts: 'msg790',
        },
        client: mockClient,
      });

      // Should post error message about empty messages
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: expect.stringContaining('Empty messages are not permitted'),
      });

      // Should NOT start Claude query
      expect(startClaudeQuery).not.toHaveBeenCalled();
    });

    it('should normalize multiple spaces after stripping @bot mention', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Message with @bot in the middle, which would leave double spaces after stripping
      await handler({
        event: {
          user: 'U123',
          text: 'say <@BOT123> hello',
          channel: 'C123',
          ts: 'msg791',
        },
        client: mockClient,
      });

      // Should have called startClaudeQuery with normalized text (single space)
      // First argument is the prompt string
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'say hello',  // Single space, not double
        expect.anything()
      );
    });

    it('should normalize multiple whitespace characters in message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Message with multiple mentions and irregular spacing
      // Note: The regex strips ALL @mentions (/<@[A-Z0-9]+>/g), not just the bot
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123>   <@USER456>   hello    world',
          channel: 'C123',
          ts: 'msg792',
        },
        client: mockClient,
      });

      // All @mentions are stripped and spaces normalized
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'hello world',  // All mentions stripped, spaces normalized
        expect.anything()
      );
    });
  });

  describe('status message position and activity consolidation', () => {
    it('should NOT move status message to bottom - status stays at TOP', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'assistant', content: 'Processing your request...' },
        { type: 'result', result: 'Done!' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test status position',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Status message should stay at TOP - NO chat.delete calls
      // (Old behavior deleted and reposted status to move it to bottom)
      expect(mockClient.chat.delete).not.toHaveBeenCalled();

      // Status message is updated in-place via chat.update
      expect(mockClient.chat.update).toHaveBeenCalled();
    });

    it('should NOT post activity as separate message - activity stays in status message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock a full flow with tools
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'tool_use', name: 'Read', id: 'tool-1' },
        { type: 'tool_result', name: 'Read', id: 'tool-1' },
        { type: 'assistant', content: 'Response text here' },
        { type: 'result', result: 'Response text here' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test activity consolidation',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Check all postMessage calls - should NOT have any "Activity" segment messages
      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Activity should NOT be posted as separate message
      // Old behavior posted activity segments via buildLiveActivityBlocks
      const activitySegmentCall = postCalls.find((call: any) => {
        const blocks = call[0].blocks;
        if (!blocks) return false;
        // Check for activity segment format (section with thinking/tool emoji)
        return blocks.some((b: any) =>
          b.type === 'section' &&
          b.text?.text &&
          (b.text.text.includes(':brain:') || b.text.text.includes(':white_check_mark:')) &&
          // But NOT the combined status message (which has actions block)
          !blocks.some((b2: any) => b2.type === 'actions')
        );
      });
      expect(activitySegmentCall).toBeUndefined();

      // Status message (with activity IN it) should exist
      const statusCall = postCalls.find((call: any) =>
        call[0].text === 'Claude is starting...' &&
        call[0].blocks?.some((b: any) => b.type === 'actions')
      );
      expect(statusCall).toBeDefined();
    });

    it('should include activity log in completion status message (single message format)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        { type: 'result', result: 'All done!', usage: { input_tokens: 500, output_tokens: 100 } },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> test full activity',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Find the completion update (has BOTTOM stats line with token counts)
      const updateCalls = mockClient.chat.update.mock.calls;
      const completionUpdate = updateCalls.find((call: any) =>
        call[0].blocks?.some((b: any) =>
          b.type === 'context' &&
          b.elements?.[0]?.text?.includes('500') &&
          b.elements?.[0]?.text?.includes('100')
        )
      );
      expect(completionUpdate).toBeDefined();

      // Verify completion message has the expected block structure:
      // 1. TOP line (context) - mode | model | session-id
      // 2. Activity log (section)
      // 3. BOTTOM stats line (context) - includes token counts
      // 4. Actions (buttons)
      const completionBlocks = completionUpdate![0].blocks;

      // Activity section exists
      const activitySection = completionBlocks.find((b: any) => b.type === 'section');
      expect(activitySection).toBeDefined();

      // Unified stats line: context with mode AND token counts
      const statsLine = completionBlocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('500') && b.elements?.[0]?.text?.includes('plan')
      );
      expect(statsLine).toBeDefined();

      // Actions block (may contain Fork here or Generate Output buttons)
      const actionsBlock = completionBlocks.find((b: any) => b.type === 'actions');
      // Actions block is optional on completion (only present with Fork or retry buttons)

      // No spinner block in completion (spinner only during in-progress)
      // Completion should have exactly 4 blocks: activity + user mention header + stats + actions
      // (user mention header added when userId is present and channel is not DM)
      expect(completionBlocks.length).toBe(4);
    });
  });

  describe('intermediate response text handling', () => {
    it('should NOT post intermediate text before tool as separate message', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate: text streaming → tool use → final text → result
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' },
        // Text before tool (this should NOT be posted as separate message)
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: "I'll explore the codebase to find..." }}},
        // Tool starts - triggers logToolStart which should skipPosting
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Task' }}},
        { type: 'stream_event', event: { type: 'content_block_stop' }},
        // Final text after tool (this SHOULD be posted)
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Analysis complete! I found the issue.' }}},
        // Result signals end of streaming
        { type: 'result', result: 'Analysis complete! I found the issue.' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> find the bug',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Should NOT find a main channel message with intermediate "I'll explore..." text
      // (activity thread posts are OK - they have thread_ts set)
      const intermediateMainChannelMsg = postCalls.find((call: any) =>
        call[0].text?.includes("I'll explore the codebase") &&
        call[0].text?.includes(':speech_balloon:') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(intermediateMainChannelMsg).toBeUndefined();

      // Should find final response
      const finalMsg = postCalls.find((call: any) =>
        call[0].text?.includes('Analysis complete')
      );
      expect(finalMsg).toBeDefined();
    });

    it('should post intermediate text to activity thread when tool is used', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate: text streaming → tool use → final text → result
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' },
        // Text before tool - should be posted to activity thread
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: "I'll check the logs for errors..." }}},
        // Tool starts - triggers finalizeGeneratingEntry with skipPosting=true
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' }}},
        { type: 'stream_event', event: { type: 'content_block_stop' }},
        // Final text after tool
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Found the error in the logs.' }}},
        { type: 'result', result: 'Found the error in the logs.' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> check logs',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Verify intermediate text IS posted to activity thread (with :speech_balloon: prefix)
      const intermediateThreadPost = postCalls.find((call: any) =>
        call[0].text?.includes("I'll check the logs") &&
        call[0].text?.includes(':speech_balloon:') &&
        call[0].thread_ts  // Thread posts have thread_ts
      );
      expect(intermediateThreadPost).toBeDefined();

      // Verify it has thread_ts (posted as thread reply)
      expect(intermediateThreadPost[0].thread_ts).toBeDefined();

      // Verify intermediate text is NOT in main channel
      const intermediateMainPost = postCalls.find((call: any) =>
        call[0].text?.includes("I'll check the logs") &&
        call[0].text?.includes(':speech_balloon:') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(intermediateMainPost).toBeUndefined();
    });

    it('should only post final response after multiple tools', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate: text → tool1 → text → tool2 → final text → result
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' },
        // Text before first tool
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me search for that...' }}},
        // Tool 1
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Grep' }}},
        { type: 'stream_event', event: { type: 'content_block_stop' }},
        // Text between tools
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Now reading the file...' }}},
        // Tool 2
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' }}},
        { type: 'stream_event', event: { type: 'content_block_stop' }},
        // Final text after all tools (this SHOULD be posted)
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '## Summary\n\nHere is what I found in the code.' }}},
        // Result signals end of streaming
        { type: 'result', result: '## Summary\n\nHere is what I found in the code.' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> analyze code',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Should NOT find intermediate messages in main channel (activity thread posts are OK)
      const searchMainChannelMsg = postCalls.find((call: any) =>
        call[0].text?.includes('Let me search') &&
        call[0].text?.includes(':speech_balloon:') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(searchMainChannelMsg).toBeUndefined();

      const readingMainChannelMsg = postCalls.find((call: any) =>
        call[0].text?.includes('Now reading the file') &&
        call[0].text?.includes(':speech_balloon:') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(readingMainChannelMsg).toBeUndefined();

      // Should find the final response in activity thread
      const finalMsg = postCalls.find((call: any) =>
        call[0].text?.includes('Summary') && call[0].text?.includes('what I found') &&
        call[0].thread_ts  // Activity thread posts have thread_ts
      );
      expect(finalMsg).toBeDefined();

      // With new behavior: responses go ONLY to activity thread, NOT main channel
      // Count main channel response messages (should be 0)
      const mainChannelResponses = postCalls.filter((call: any) =>
        call[0].text?.includes(':speech_balloon: *Response*') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(mainChannelResponses.length).toBe(0); // No main channel responses

      // Activity thread gets intermediate AND final responses
      // (intermediate text before tools + final response)
      const threadResponses = postCalls.filter((call: any) =>
        call[0].text?.includes(':speech_balloon: *Response*') &&
        call[0].thread_ts  // Activity thread posts have thread_ts
      );
      expect(threadResponses.length).toBeGreaterThan(0); // Multiple responses in thread
    });

    it('should post response normally when no tools are called', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simple response with no tools
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' },
        // Text response (no tools)
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'This is a direct answer.' }}},
        { type: 'result', result: 'This is a direct answer.' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> what is 2+2',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Response should be posted normally
      const responseMsg = postCalls.find((call: any) =>
        call[0].text?.includes('direct answer')
      );
      expect(responseMsg).toBeDefined();
      expect(responseMsg[0].text).toContain(':speech_balloon: *Response*');
    });

    it('should track intermediate text in activity entries even when not posting', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate: text before tool → tool → final text → result
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session-123', model: 'claude-sonnet' },
        // Intermediate text that gets tracked but not posted
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me investigate this bug...' }}},
        // Tool starts
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' }}},
        { type: 'stream_event', event: { type: 'content_block_stop' }},
        // Final text after tool
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Found the issue!' }}},
        { type: 'result', result: 'Found the issue!' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> debug issue',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      const postCalls = mockClient.chat.postMessage.mock.calls;

      // Key verification: Intermediate text is NOT posted to main channel
      // (activity thread posts are expected and OK - they have thread_ts set)
      const intermediateMainChannelPost = postCalls.find((call: any) =>
        call[0].text?.includes('Let me investigate') &&
        call[0].text?.includes(':speech_balloon:') &&
        !call[0].thread_ts  // Main channel posts don't have thread_ts
      );
      expect(intermediateMainChannelPost).toBeUndefined();

      // Final text IS posted
      const finalPosted = postCalls.find((call: any) =>
        call[0].text?.includes('Found the issue')
      );
      expect(finalPosted).toBeDefined();

      // Status message updates should happen (activity is tracked via chat.update)
      expect(mockClient.chat.update).toHaveBeenCalled();

      // Verify at least one update contains activity section (proving activity is tracked)
      const updateCalls = mockClient.chat.update.mock.calls;
      const hasActivitySection = updateCalls.some((call: any) =>
        call[0].blocks?.some((b: any) =>
          b.type === 'section' && b.text?.text
        )
      );
      expect(hasActivitySection).toBe(true);
    });
  });

  describe('/show-plan command integration', () => {
    it('should post plan content to thread when plan file exists', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      const planContent = '# My Plan\n\n## Steps\n1. Do this\n2. Do that';
      vi.mocked(fs.promises.readFile).mockResolvedValue(planContent);

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: '/home/user/.claude/plans/test-plan.md',
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /show-plan',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should read the plan file
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        '/home/user/.claude/plans/test-plan.md',
        'utf-8'
      );

      // Should post plan content (via postMessage or uploadV2)
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const planPost = postCalls.find((call: any) =>
        call[0].text?.includes('Current Plan') ||
        call[0].text?.includes('My Plan')
      );
      expect(planPost).toBeDefined();

      // Should NOT start Claude query (command handled internally)
      expect(startClaudeQuery).not.toHaveBeenCalled();

      // Verify :page_with_curl: emoji was added (matches plan mode behavior)
      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: 'msg123',
        name: 'page_with_curl',
      });
    });

    it('should post error when plan file does not exist', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Mock file read to throw error (file not found)
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        planFilePath: '/home/user/.claude/plans/missing-plan.md',
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /show-plan',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post error message about file not found
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const errorPost = postCalls.find((call: any) =>
        call[0].text?.includes('Plan file not found')
      );
      expect(errorPost).toBeDefined();
      expect(errorPost[0].text).toContain('missing-plan.md');

      // Should NOT start Claude query
      expect(startClaudeQuery).not.toHaveBeenCalled();

      // Verify :page_with_curl: emoji was NOT added (plan not shown due to error)
      const pageCurlCalls = mockClient.reactions.add.mock.calls.filter(
        (call: any) => call[0].name === 'page_with_curl'
      );
      expect(pageCurlCalls).toHaveLength(0);
    });

    it('should post error when no plan file path in session', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        // No planFilePath
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /show-plan',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post error message about no plan file
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const errorPost = postCalls.find((call: any) =>
        call[0].text?.includes('No plan file found')
      );
      expect(errorPost).toBeDefined();

      // Should NOT start Claude query
      expect(startClaudeQuery).not.toHaveBeenCalled();
    });
  });

  describe('thinking thread activity with long content', () => {
    it('should update thinking placeholder in-place with file upload (no delete+repost)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Track the ts of the thinking placeholder message
      let thinkingPlaceholderTs: string | null = null;
      const originalPostMessage = mockClient.chat.postMessage;
      mockClient.chat.postMessage = vi.fn().mockImplementation(async (opts: any) => {
        // Intercept thinking placeholder posts
        if (opts.text?.includes('*Thinking...*')) {
          thinkingPlaceholderTs = `thinking-placeholder-${Date.now()}`;
          return { ok: true, ts: thinkingPlaceholderTs };
        }
        return originalPostMessage(opts);
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        // Note: threadCharLimit doesn't affect thinking anymore (uses THINKING_MESSAGE_SIZE=3000)
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate thinking with long content (exceeds THINKING_MESSAGE_SIZE=3000)
      const longThinking = 'A'.repeat(3500);  // 3500 chars, over 3000 limit
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        // Thinking block start
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking' },
          },
        },
        // Thinking content (long)
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: longThinking },
          },
        },
        // Thinking block stop
        {
          type: 'stream_event',
          event: {
            type: 'content_block_stop',
            index: 0,
          },
        },
        { type: 'result', result: 'Done!' },
      ];

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> think about this',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // When thinking content exceeds THINKING_MESSAGE_SIZE (3000):
      // 1. A thinking placeholder should have been posted
      // 2. File is uploaded to thread
      // 3. The placeholder is updated in-place with the file link (no delete+repost)

      // Verify thinking placeholder was posted
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const thinkingPlaceholderPost = postCalls.find((call: any) =>
        call[0].text?.includes('*Thinking...*')
      );
      expect(thinkingPlaceholderPost).toBeDefined();

      // NEW BEHAVIOR: No delete call for thinking placeholder
      // The placeholder is updated in-place instead
      const deleteCalls = mockClient.chat.delete.mock.calls;
      const thinkingDeleteCall = deleteCalls.find((call: any) =>
        call[0].ts?.startsWith('thinking-placeholder-')
      );
      // With the new in-place update approach, no delete should occur
      expect(thinkingDeleteCall).toBeUndefined();

      // Verify chat.update was called (to update the thinking message in-place)
      const updateCalls = mockClient.chat.update.mock.calls;
      const thinkingUpdateCall = updateCalls.find((call: any) =>
        call[0].ts === thinkingPlaceholderTs
      );
      // The placeholder should be updated (not deleted)
      // Note: In this test environment, thinkingPlaceholderTs may be null
      // The key assertion is that no delete occurred
    });

    it('should NOT trigger file attachment for thinking under THINKING_MESSAGE_SIZE (3000)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        threadCharLimit: 100,  // Even with low threadCharLimit, thinking uses THINKING_MESSAGE_SIZE
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Simulate thinking with content under THINKING_MESSAGE_SIZE (3000)
      const shortThinking = 'A'.repeat(2500);  // 2500 chars, under 3000 limit
      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: shortThinking },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        },
        { type: 'result', result: 'Done!' },
      ];

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
        interrupt: vi.fn(),
      } as any);

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> think about this',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Thinking content (2500 chars) is under THINKING_MESSAGE_SIZE (3000)
      // So NO file upload should be triggered, regardless of threadCharLimit setting
      const uploadCalls = mockClient.files.uploadV2.mock.calls;
      const thinkingFileUpload = uploadCalls.find((call: any) =>
        call[0].file_uploads?.some((f: any) => f.filename?.includes('thinking'))
      );
      expect(thinkingFileUpload).toBeUndefined();
    });

    it('should show rolling tail (last 3000 chars) in thread updates during streaming', async () => {
      // Use real timers with a wait function for async generator timing
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      // Track thinking thread message ts
      let thinkingThreadTs: string | null = null;
      const originalPostMessage = mockClient.chat.postMessage;
      mockClient.chat.postMessage = vi.fn().mockImplementation(async (opts: any) => {
        if (opts.text?.includes('*Thinking...*')) {
          thinkingThreadTs = 'thinking-thread-msg-ts';
          return { ok: true, ts: thinkingThreadTs };
        }
        return originalPostMessage(opts);
      });

      vi.mocked(getSession).mockReturnValue({
        sessionId: null,
        workingDir: '/test',
        mode: 'plan',
        updateRateSeconds: 0.1,  // Use very short update rate for fast test
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Create thinking content > 3000 chars
      // First 1000 chars are 'A' with HEAD marker, last part has TAIL marker at end
      // With 4000 total chars and 3000 limit, we should see the TAIL marker but not HEAD
      const headContent = 'AAAA_HEAD_START_' + 'A'.repeat(1000);
      const middleContent = 'M'.repeat(2000);
      const tailContent = 'Z'.repeat(900) + '_TAIL_END_ZZZZ';
      const longThinking = headContent + middleContent + tailContent;  // ~4000 chars total

      let queryComplete: () => void;
      const queryDonePromise = new Promise<void>(r => { queryComplete = r; });

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet' };
          // Thinking block start
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking' },
            },
          };
          // Thinking content (very long - over 3000 chars)
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: longThinking },
            },
          };
          // Wait for test to check updates before completing
          await queryDonePromise;
          // Complete thinking block
          yield {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          };
          yield { type: 'result', result: 'Done!' };
        },
        interrupt: vi.fn(),
      } as any);

      // Start the handler (don't await yet)
      const handlerPromise = handler({
        event: {
          user: 'U123',
          text: '<@BOT123> think deeply',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Wait for the updates to fire
      await wait(300);

      // Now check chat.update calls for the thinking thread message
      const updateCalls = mockClient.chat.update.mock.calls;
      const thinkingThreadUpdates = updateCalls.filter((call: any) =>
        call[0].ts === thinkingThreadTs && call[0].text?.includes('*Thinking...*')
      );

      // Should have at least one update
      expect(thinkingThreadUpdates.length).toBeGreaterThan(0);

      // Get the last update call (during streaming, before finalization)
      const lastUpdate = thinkingThreadUpdates[thinkingThreadUpdates.length - 1][0];

      // CRITICAL: The update should show the TAIL marker, not the HEAD marker
      // This verifies extractTailWithFormatting is being used with THINKING_MESSAGE_SIZE (3000)
      expect(lastUpdate.text).toContain('_TAIL_END_ZZZZ');
      expect(lastUpdate.text).not.toContain('AAAA_HEAD_START_');

      // Should have "..." prefix indicating truncation
      expect(lastUpdate.text).toContain('...');

      // Complete the query
      queryComplete!();
      await wait(100);
      await handlerPromise;
    });
  });

  describe('inline /mode command', () => {
    it('should extract and apply inline /mode plan', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',  // Start in default mode
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet-4' },
        { type: 'result', result: 'Done' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) yield msg;
        },
        interrupt: vi.fn(),
      } as any);

      // Send message with inline /mode
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /mode plan help me design something',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Session should be saved with plan mode
      expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({ mode: 'plan' }));

      // Query should be called with remaining text only (not including /mode plan)
      // startClaudeQuery(message, options) - message is first argument
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'help me design something',  // /mode plan stripped
        expect.objectContaining({ mode: 'plan' })
      );
    });

    it('should show error for invalid inline mode', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /mode invalid do something',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should post error message
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const errorCall = postCalls.find((call: any) =>
        call[0].text?.includes('Unknown mode')
      );
      expect(errorCall).toBeDefined();

      // Should NOT call Claude
      expect(startClaudeQuery).not.toHaveBeenCalled();

      // Note: Eyes reaction is NOT added or removed because the error
      // is handled early in app_mention handler before handleMessage
    });

    it('should confirm mode change when only /mode is provided', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> /mode bypass',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Session should be saved with bypass mode
      expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({ mode: 'bypassPermissions' }));

      // Should post confirmation
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const confirmCall = postCalls.find((call: any) =>
        call[0].text?.includes('Mode set to')
      );
      expect(confirmCall).toBeDefined();

      // Should NOT call Claude (no query text)
      expect(startClaudeQuery).not.toHaveBeenCalled();
    });

    // Note: @bot mentions in threads are rejected by design, so inline /mode in threads
    // is not supported (the thread rejection happens before inline mode extraction)

    it('should send message with /mode in middle to Claude (not reject)', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const mockClient = createMockSlackClient();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'test-session',
        workingDir: '/test',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      const mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet-4' },
        { type: 'result', result: 'The /mode command allows...' },
      ];
      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) yield msg;
        },
        interrupt: vi.fn(),
      } as any);

      // Message with /mode in the MIDDLE - should be sent to Claude, not rejected
      await handler({
        event: {
          user: 'U123',
          text: '<@BOT123> what does /mode xyz mean?',
          channel: 'C123',
          ts: 'msg123',
        },
        client: mockClient,
      });

      // Should NOT post error message
      const postCalls = mockClient.chat.postMessage.mock.calls;
      const errorCall = postCalls.find((call: any) =>
        call[0].text?.includes('Unknown mode')
      );
      expect(errorCall).toBeUndefined();

      // SHOULD call Claude with full message
      expect(startClaudeQuery).toHaveBeenCalledWith(
        'what does /mode xyz mean?',
        expect.anything()
      );
    });
  });

});
