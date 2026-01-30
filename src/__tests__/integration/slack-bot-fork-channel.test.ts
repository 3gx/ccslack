import { describe, it, expect, vi, beforeEach } from 'vitest';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// vi.mock calls must be at module level - Vitest hoists these
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
      message(handler: any) { registeredHandlers['message'] = handler; }
      action(pattern: RegExp | string, handler: any) {
        const key = typeof pattern === 'string' ? `action_${pattern}` : `action_${pattern.source}`;
        registeredHandlers[key] = handler;
      }
      view(pattern: RegExp | string, handler: any) {
        const key = typeof pattern === 'string' ? `view_${pattern}` : `view_${pattern.source}`;
        registeredHandlers[key] = handler;
      }
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

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, findForkPointMessageId, deleteSession } from '../../session-manager.js';
import { startClaudeQuery } from '../../claude-client.js';

describe('slack-bot fork to channel handlers', () => {
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

  describe('fork_here button handler', () => {
    it('should open modal with trigger_id on button click', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';
      const triggerId = 'trigger_123abc';

      await handler({
        action: {
          action_id: 'fork_here_C123',
          value: JSON.stringify({}),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
          trigger_id: triggerId,
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should open modal
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: triggerId,
          view: expect.objectContaining({
            type: 'modal',
            callback_id: 'fork_to_channel_modal',
          }),
        })
      );
    });

    it('should include source info in modal private_metadata', async () => {
      const handler = registeredHandlers['action_^fork_here_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();
      const messageTs = '1000000100.000000';
      const threadTs = '1000000000.000000';

      await handler({
        action: {
          action_id: `fork_here_C123_${threadTs}`,
          value: JSON.stringify({ threadTs }),
        },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: messageTs },
          user: { id: 'U123' },
          trigger_id: 'trigger_456',
        },
        client: mockClient,
      });

      expect(mockClient.views.open).toHaveBeenCalled();
      const viewCall = mockClient.views.open.mock.calls[0][0];
      const metadata = JSON.parse(viewCall.view.private_metadata);

      expect(metadata.sourceChannelId).toBe('C123');
      expect(metadata.sourceMessageTs).toBe(messageTs);
      expect(metadata.conversationKey).toBe(`C123_${threadTs}`);
      expect(metadata.threadTs).toBe(threadTs);
    });
  });

  describe('fork_to_channel_modal submission', () => {
    it('should reject empty channel name with validation error', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      expect(handler).toBeDefined();

      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: '' },
              },
            },
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalledWith({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name is required' },
      });
    });

    it('should reject whitespace-only channel name', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: '   ' },
              },
            },
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalledWith({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name is required' },
      });
    });

    it('should create channel on valid name', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should ack without errors (close modal)
      expect(ack).toHaveBeenCalledWith();

      // Should create channel
      expect(mockClient.conversations.create).toHaveBeenCalledWith({
        name: 'my-fork-channel',
        is_private: false,
      });
    });

    it('should handle name_taken error from Slack', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation failure - name taken
      mockClient.conversations.create.mockRejectedValue({
        data: { error: 'name_taken' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'existing-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should post error message to source channel
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Failed to create fork channel')
      );
      expect(errorCall).toBeDefined();
      expect(errorCall[0].text).toContain('already exists');
    });

    it('should fork SDK session with simple prompt', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should call SDK with null prompt (uses synthetic message for fork-only)
      expect(startClaudeQuery).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          sessionId: 'main-session',
          forkSession: true,
          resumeSessionAt: 'msg_abc123',
        })
      );
    });

    it('should post first message with fork link and sessionId', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should post first message in new channel with fork info
      const firstMessageCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].channel === 'CNEW123' && call[0].text?.includes('fork of')
      );
      expect(firstMessageCall).toBeDefined();
      expect(firstMessageCall[0].blocks[0].text.text).toContain('Point-in-time fork');
      expect(firstMessageCall[0].blocks[0].text.text).toContain('new-session-123');
    });

    it('should create session with sessionId already populated', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
        maxThinkingTokens: 16000,
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should save session with forked session ID
      expect(saveSession).toHaveBeenCalledWith(
        'CNEW123',
        expect.objectContaining({
          sessionId: 'new-session-123',
          forkedFromChannelId: 'C123',
          forkedFromMessageTs: '1234567890.123456',
          maxThinkingTokens: 16000,
        })
      );
    });

    it('should update source message with Jump to Fork button', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      // Mock source message with Fork here button
      mockClient.conversations.history.mockResolvedValue({
        messages: [{
          ts: '1234567890.123456',
          text: 'Some response',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Hello' } },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'fork_here_C123', text: { type: 'plain_text', text: 'Fork here' } },
              ],
            },
          ],
        }],
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should update source message
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: '1234567890.123456',
        })
      );

      const updateCall = mockClient.chat.update.mock.calls[0][0];

      // Fork here button should be removed from actions block
      const actionsBlock = updateCall.blocks.find((b: any) => b.type === 'actions');
      // Actions block may still exist but Fork here should be removed
      if (actionsBlock) {
        expect(actionsBlock.elements.some((e: any) => e.action_id?.startsWith('fork_here_'))).toBe(false);
      }

      // Context block with channel mention link should be added
      const contextBlock = updateCall.blocks.find((b: any) => b.type === 'context');
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain('Fork:');
      expect(contextBlock.elements[0].text).toContain('<#CNEW123|');
    });

    it('should show error when fork point info missing', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            // Missing sdkMessageId and sessionId
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should post error message
      const errorCall = mockClient.chat.postMessage.mock.calls.find(
        (call: any) => call[0].text?.includes('Failed to create fork channel')
      );
      expect(errorCall).toBeDefined();
      expect(errorCall[0].text).toContain('Missing fork point info');
    });

    it('should invite user to the newly created channel', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      await handler({
        ack,
        body: { user: { id: 'U789' } },  // Specific user ID to verify
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Should invite the user who clicked Fork here
      expect(mockClient.conversations.invite).toHaveBeenCalledWith({
        channel: 'CNEW123',
        users: 'U789',
      });
    });

    it('should use channel mention link for Jump to fork (not URL button)', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'my-fork-channel' },
      });

      // Mock source message with Fork here button
      mockClient.conversations.history.mockResolvedValue({
        messages: [{
          ts: '1234567890.123456',
          text: 'Some response',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Hello' } },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'fork_here_C123', text: { type: 'plain_text', text: 'Fork here' } },
              ],
            },
          ],
        }],
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'my-fork-channel' },
              },
            },
          },
        },
        client: mockClient,
      });

      // Verify context block with channel mention + actions block with Refresh fork
      const updateCall = mockClient.chat.update.mock.calls[0][0];
      const contextBlock = updateCall.blocks.find((b: any) => b.type === 'context');

      // Should have context block with channel mention
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].type).toBe('mrkdwn');
      expect(contextBlock.elements[0].text).toBe('↗️ Fork: <#CNEW123|my-fork-channel>');

      // Should have actions block with Refresh fork button (not URL button)
      const actionsBlock = updateCall.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const refreshButton = actionsBlock.elements.find((e: any) => e.action_id?.startsWith('refresh_fork_'));
      expect(refreshButton).toBeDefined();
      expect(refreshButton.text.text).toBe('🔄 Refresh fork');
    });
  });

  describe('refresh_fork button handler', () => {
    it('should restore Fork here button when forked channel is deleted', async () => {
      const handler = registeredHandlers['action_^refresh_fork_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock conversations.info to fail (channel deleted)
      mockClient.conversations.info.mockRejectedValue(new Error('channel_not_found'));

      // Mock source message with context block (stale fork link) and buttons
      mockClient.conversations.history.mockResolvedValue({
        messages: [{
          ts: '1111111111.111111',
          text: 'Original response',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Response text' } },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: '↗️ Fork: <#C_DELETED|deleted-fork>' }],
            },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'refresh_fork_C_SOURCE', text: { type: 'plain_text', text: '🔄 Refresh fork' } },
              ],
            },
          ],
        }],
      });

      await handler({
        action: {
          action_id: 'refresh_fork_C_SOURCE',
          value: JSON.stringify({
            forkChannelId: 'C_DELETED',
            sdkMessageId: 'msg_original',
            sessionId: 'source-session',
            conversationKey: 'C_SOURCE',
          }),
        },
        ack,
        body: {
          channel: { id: 'C_SOURCE' },
          message: { ts: '1111111111.111111' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Verify chat.update was called to restore Fork here button
      expect(mockClient.chat.update).toHaveBeenCalled();
      const updateCall = mockClient.chat.update.mock.calls[0][0];

      // Fork context block should be removed
      const contextBlock = updateCall.blocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('Fork:')
      );
      expect(contextBlock).toBeUndefined();

      // Fork here button should be added to actions block
      const actionsBlock = updateCall.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const forkButton = actionsBlock.elements.find((e: any) => e.action_id?.startsWith('fork_here_'));
      expect(forkButton).toBeDefined();

      // Refresh fork button should be removed
      const refreshButton = actionsBlock.elements.find((e: any) => e.action_id?.startsWith('refresh_fork_'));
      expect(refreshButton).toBeUndefined();
    });

    it('should do nothing if forked channel still exists', async () => {
      const handler = registeredHandlers['action_^refresh_fork_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock conversations.info to succeed (channel exists)
      mockClient.conversations.info.mockResolvedValue({ ok: true, channel: { id: 'C_FORK' } });

      await handler({
        action: {
          action_id: 'refresh_fork_C_SOURCE',
          value: JSON.stringify({
            forkChannelId: 'C_FORK',
            sdkMessageId: 'msg_original',
            sessionId: 'source-session',
            conversationKey: 'C_SOURCE',
          }),
        },
        ack,
        body: {
          channel: { id: 'C_SOURCE' },
          message: { ts: '1111111111.111111' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();

      // Should NOT update message (channel still exists)
      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });
  });

  describe('thread reply message fetching (conversations.replies fix)', () => {
    it('should use conversations.replies for thread messages when forking', async () => {
      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      } as any);

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'test-fork' },
      });

      // Mock conversations.replies for thread message (the FIX)
      mockClient.conversations.replies.mockResolvedValue({
        messages: [{
          ts: '1234567890.999999',  // Status message ts
          text: 'Complete',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Activity log' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: 'Status line' }] },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'fork_here_C123_1234567890.123456', text: { type: 'plain_text', text: 'Fork here' } },
              ],
            },
          ],
        }],
      });

      // conversations.history should NOT be called for thread messages
      mockClient.conversations.history.mockResolvedValue({ messages: [] });

      const threadTs = '1234567890.123456';  // Thread parent (user's message)
      const statusMsgTs = '1234567890.999999';  // Status message in thread

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: statusMsgTs,
            threadTs: threadTs,  // KEY: threadTs is set
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: `C123_${threadTs}`,
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'test-fork' },
              },
            },
          },
        },
        client: mockClient,
      });

      // CRITICAL: conversations.replies should be called (not conversations.history)
      expect(mockClient.conversations.replies).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: threadTs,           // Thread parent (fetches all replies, we find by ts)
        })
      );

      // Source message should be updated with fork link
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          ts: statusMsgTs,
        })
      );

      const updateCall = mockClient.chat.update.mock.calls.find(
        (call: any) => call[0].channel === 'C123' && call[0].ts === statusMsgTs
      );
      expect(updateCall).toBeDefined();

      // Fork here button should be removed, fork link context should be added
      const contextBlock = updateCall[0].blocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('Fork:')
      );
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain('<#CNEW123|');
    });

    it('should use conversations.replies for refresh fork on thread messages', async () => {
      const handler = registeredHandlers['action_^refresh_fork_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock conversations.info to fail (channel deleted)
      mockClient.conversations.info.mockRejectedValue(new Error('channel_not_found'));

      const threadTs = '1234567890.123456';
      const statusMsgTs = '1111111111.111111';

      // Mock conversations.replies for thread message
      mockClient.conversations.replies.mockResolvedValue({
        messages: [{
          ts: statusMsgTs,
          text: 'Complete',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Activity log' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: '↗️ Fork: <#C_FORK|deleted>' }] },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'refresh_fork_C_SOURCE', text: { type: 'plain_text', text: 'Refresh fork' } },
              ],
            },
          ],
        }],
      });

      await handler({
        action: {
          action_id: 'refresh_fork_C_SOURCE',
          value: JSON.stringify({
            forkChannelId: 'C_FORK',
            threadTs: threadTs,  // KEY: threadTs is set
            sdkMessageId: 'msg_original',
            sessionId: 'source-session',
            conversationKey: `C_SOURCE_${threadTs}`,
          }),
        },
        ack,
        body: {
          channel: { id: 'C_SOURCE' },
          message: { ts: statusMsgTs },
        },
        client: mockClient,
      });

      // CRITICAL: conversations.replies should be called (not conversations.history)
      expect(mockClient.conversations.replies).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_SOURCE',
          ts: threadTs,           // Thread parent (fetches all replies, we find by ts)
        })
      );

      // Message should be updated with Fork here button restored
      expect(mockClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_SOURCE',
          ts: statusMsgTs,
        })
      );

      const updateCall = mockClient.chat.update.mock.calls[0][0];

      // Fork here button should be restored
      const actionsBlock = updateCall.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const forkButton = actionsBlock.elements.find((e: any) => e.action_id?.startsWith('fork_here_'));
      expect(forkButton).toBeDefined();

      // Fork context block should be removed
      const forkContext = updateCall.blocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('Fork:')
      );
      expect(forkContext).toBeUndefined();
    });
  });

  describe('fork query stream consumption', () => {
    it('should consume entire SDK stream to ensure session file is written', async () => {
      // This test verifies the fix for: Fork Here button breaks after bot restart
      // Root cause: Early return after init event abandons stream before SDK writes .jsonl file
      // Fix: Consume entire stream, not just init event

      const handler = registeredHandlers['view_fork_to_channel_modal'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Track how many events were consumed from the stream
      let eventsConsumed = 0;
      const totalEvents = 4;

      vi.mocked(startClaudeQuery).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          // Event 1: init (has session_id)
          eventsConsumed++;
          yield { type: 'system', subtype: 'init', session_id: 'forked-session-abc', model: 'claude-sonnet' };

          // Event 2: assistant message (simulates Claude's response to synthetic message)
          eventsConsumed++;
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '.' }] } };

          // Event 3: result
          eventsConsumed++;
          yield { type: 'result', result: 'done' };

          // Event 4: final event (simulates stream completion after session file is written)
          eventsConsumed++;
          yield { type: 'system', subtype: 'done' };
        },
        interrupt: vi.fn(),
      } as any);

      // Mock session
      vi.mocked(getSession).mockReturnValue({
        sessionId: 'main-session',
        workingDir: '/test/dir',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Mock fork point
      vi.mocked(findForkPointMessageId).mockReturnValue({
        messageId: 'msg_abc123',
        sessionId: 'main-session',
      });

      // Mock channel creation success
      mockClient.conversations.create.mockResolvedValue({
        ok: true,
        channel: { id: 'CNEW123', name: 'fork-stream-test' },
      });

      await handler({
        ack,
        body: { user: { id: 'U123' } },
        view: {
          callback_id: 'fork_to_channel_modal',
          private_metadata: JSON.stringify({
            sourceChannelId: 'C123',
            sourceMessageTs: '1234567890.123456',
            sdkMessageId: 'msg_abc123',
            sessionId: 'main-session',
            conversationKey: 'C123',
          }),
          state: {
            values: {
              channel_name_block: {
                channel_name_input: { value: 'fork-stream-test' },
              },
            },
          },
        },
        client: mockClient,
      });

      // CRITICAL: All events must be consumed, not just the init event
      // This ensures the SDK has time to write the session file before the process exits
      expect(eventsConsumed).toBe(totalEvents);

      // Verify the forked session ID was correctly captured from init event
      expect(saveSession).toHaveBeenCalledWith(
        'CNEW123',
        expect.objectContaining({
          sessionId: 'forked-session-abc',
        })
      );
    });
  });
});
