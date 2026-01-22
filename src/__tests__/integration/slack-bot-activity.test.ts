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

// Import utilities from setup
import { createMockSlackClient } from './slack-bot-setup.js';

// Import mocked modules
import { getSession, saveSession, getThreadSession, saveThreadSession, getOrCreateThreadSession, saveMessageMapping, findForkPointMessageId, getActivityLog, getSegmentActivityLog } from '../../session-manager.js';
import { isSessionActiveInTerminal } from '../../concurrent-check.js';
import { startClaudeQuery } from '../../claude-client.js';
import fs from 'fs';

describe('slack-bot activity handlers', () => {
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

  describe('view_segment_log handler', () => {
    it('should register view_segment_log handler', async () => {
      const handler = registeredHandlers['action_^view_segment_log_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should open modal with segment activity log entries', async () => {
      const handler = registeredHandlers['action_^view_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock segment activity log data
      vi.mocked(getSegmentActivityLog).mockReturnValue([
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'Test thinking content' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ]);

      await handler({
        action: { action_id: 'view_segment_log_C123_thread456_seg_abc-123-def' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger123',
          view: expect.objectContaining({
            type: 'modal',
            title: expect.objectContaining({ text: 'Activity Log' }),
          }),
        })
      );
    });

    it('should show error modal when segment activity log not found', async () => {
      const handler = registeredHandlers['action_^view_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock no segment activity log
      vi.mocked(getSegmentActivityLog).mockReturnValue(null);

      await handler({
        action: { action_id: 'view_segment_log_C123_thread456_seg_abc-123-def' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            type: 'modal',
            blocks: expect.arrayContaining([
              expect.objectContaining({
                text: expect.objectContaining({
                  text: expect.stringContaining('no longer available'),
                }),
              }),
            ]),
          }),
        })
      );
    });

    it('should show error modal when segment activity log is empty', async () => {
      const handler = registeredHandlers['action_^view_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock empty segment activity log
      vi.mocked(getSegmentActivityLog).mockReturnValue([]);

      await handler({
        action: { action_id: 'view_segment_log_C123_thread456_seg_abc-123-def' },
        ack,
        body: {
          trigger_id: 'trigger123',
          channel: { id: 'C123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Empty array shows "no longer available" message for segments
      expect(mockClient.views.open).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            type: 'modal',
            blocks: expect.arrayContaining([
              expect.objectContaining({
                text: expect.objectContaining({
                  text: expect.stringContaining('no longer available'),
                }),
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('activity_log_page pagination handler', () => {
    it('should register activity_log_page handler', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      expect(handler).toBeDefined();
    });

    it('should update modal with requested page', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock segment activity log with enough entries for pagination
      const entries = Array.from({ length: 30 }, (_, i) => ({
        timestamp: Date.now() + i,
        type: 'tool_start' as const,
        tool: `Tool${i}`,
      }));
      vi.mocked(getSegmentActivityLog).mockReturnValue(entries);

      await handler({
        action: { action_id: 'activity_log_page_2' },
        ack,
        body: {
          trigger_id: 'trigger123',
          view: {
            id: 'view123',
            private_metadata: JSON.stringify({ segmentKey: 'C123_thread456_seg_abc-123-def', currentPage: 1 }),
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.views.update).toHaveBeenCalledWith(
        expect.objectContaining({
          view_id: 'view123',
          view: expect.objectContaining({
            type: 'modal',
            private_metadata: expect.stringContaining('"currentPage":2'),
          }),
        })
      );
    });

    it('should handle missing segment activity log during pagination', async () => {
      const handler = registeredHandlers['action_^activity_log_page_(\\d+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock missing segment activity log
      vi.mocked(getSegmentActivityLog).mockReturnValue(null);

      await handler({
        action: { action_id: 'activity_log_page_2' },
        ack,
        body: {
          trigger_id: 'trigger123',
          view: {
            id: 'view123',
            private_metadata: JSON.stringify({ segmentKey: 'C123_thread456_seg_abc-123-def', currentPage: 1 }),
          },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not crash, just return early
    });
  });

  describe('download_segment_log handler', () => {
    it('should register download_segment_log handler', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      expect(handler).toBeDefined();
    });

    it('should upload file with segment activity log content', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock segment activity log data
      vi.mocked(getSegmentActivityLog).mockReturnValue([
        { timestamp: 1700000000000, type: 'thinking', thinkingContent: 'Analyzing the request' },
        { timestamp: 1700000001000, type: 'tool_start', tool: 'Read' },
        { timestamp: 1700000002000, type: 'tool_complete', tool: 'Read', durationMs: 1000 },
      ]);

      await handler({
        action: { action_id: 'download_segment_log_C123_thread456_seg_abc-123-def' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123', thread_ts: 'thread456' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          filename: expect.stringMatching(/activity-log-.*\.txt/),
          content: expect.stringContaining('THINKING'),
        })
      );
    });

    it('should include full thinking content in download', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      const longThinking = 'A'.repeat(1000);
      vi.mocked(getSegmentActivityLog).mockReturnValue([
        { timestamp: 1700000000000, type: 'thinking', thinkingContent: longThinking },
      ]);

      await handler({
        action: { action_id: 'download_segment_log_C123_seg_abc-123-def' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(longThinking),
        })
      );
    });

    it('should handle missing segment activity log gracefully', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSegmentActivityLog).mockReturnValue(null);

      await handler({
        action: { action_id: 'download_segment_log_C123_seg_abc-123-def' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not attempt upload
      expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
      // Should post ephemeral with "no longer available" message
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('no longer available'),
        })
      );
    });

    it('should handle empty segment activity log with "no longer available" message', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      // Mock empty segment activity log
      vi.mocked(getSegmentActivityLog).mockReturnValue([]);

      await handler({
        action: { action_id: 'download_segment_log_C123_seg_abc-123-def' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
          user: { id: 'U123' },
        },
        client: mockClient,
      });

      expect(ack).toHaveBeenCalled();
      // Should not attempt upload
      expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
      // Should post ephemeral with "no longer available" message
      expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('no longer available'),
        })
      );
    });

    it('should format tool entries with duration', async () => {
      const handler = registeredHandlers['action_^download_segment_log_(.+)$'];
      const mockClient = createMockSlackClient();
      const ack = vi.fn();

      vi.mocked(getSegmentActivityLog).mockReturnValue([
        { timestamp: 1700000000000, type: 'tool_start', tool: 'Edit' },
        { timestamp: 1700000001500, type: 'tool_complete', tool: 'Edit', durationMs: 1500 },
      ]);

      await handler({
        action: { action_id: 'download_segment_log_C123_seg_abc-123-def' },
        ack,
        body: {
          channel: { id: 'C123' },
          message: { ts: 'msg123' },
        },
        client: mockClient,
      });

      // Format is: "TOOL COMPLETE: Edit (1500ms)"
      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringMatching(/TOOL COMPLETE: Edit \(1500ms\)/),
        })
      );
    });
  });
});
