import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

// Store registered handlers
let registeredHandlers: Record<string, any> = {};

// Mock App class before any imports
vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      event(name: string, handler: any) {
        registeredHandlers[`event_${name}`] = handler;
      }
      message(handler: any) {
        registeredHandlers['message'] = handler;
      }
      action(pattern: RegExp, handler: any) {
        registeredHandlers[`action_${pattern.source}`] = handler;
      }
      view(pattern: RegExp, handler: any) {
        registeredHandlers[`view_${pattern.source}`] = handler;
      }
      async start() {
        return Promise.resolve();
      }
    },
  };
});

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    realpathSync: vi.fn((path: string) => path),
  },
}));

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
  },
}));

// Mock path module
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    default: actual,
  };
});

// Mock claude-client
vi.mock('../../claude-client.js', () => ({
  startClaudeQuery: vi.fn(),
}));

// Mock concurrent-check
vi.mock('../../concurrent-check.js', () => ({
  isSessionActiveInTerminal: vi.fn().mockResolvedValue({ active: false }),
  buildConcurrentWarningBlocks: vi.fn().mockReturnValue([]),
  getContinueCommand: vi.fn().mockReturnValue('claude --resume test-session'),
}));

import {
  getSession,
  saveSession,
  saveThreadSession,
  deleteSession,
} from '../../session-manager.js';
import type { Session, ThreadSession } from '../../session-manager.js';

describe('channel lifecycle - deletion', () => {
  const mockSession: Session = {
    sessionId: 'main-session-123',
    workingDir: '/Users/testuser/projects/myapp',
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/Users/testuser/projects/myapp',
    configuredBy: 'U123',
    configuredAt: Date.now(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers = {};

    // Reset module cache to ensure fresh import
    vi.resetModules();

    // Import slack-bot to register handlers
    await import('../../slack-bot.js');
  });

  it('should clean up session when channel is deleted', async () => {
    // Setup: Create channel session
    const mockStore = {
      channels: {
        'C123': mockSession,
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === './sessions.json') return true;
      if (typeof path === 'string' && path.includes('main-session-123.jsonl')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

    // Trigger channel_deleted event
    const handler = registeredHandlers['event_channel_deleted'];
    expect(handler).toBeDefined();

    await handler({
      event: {
        channel: 'C123',
        type: 'channel_deleted',
      },
    });

    // Verify SDK file was deleted
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      '/mock/home/.claude/projects/-Users-testuser-projects-myapp/main-session-123.jsonl'
    );

    // Verify sessions.json was updated
    const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const writtenData = JSON.parse(finalWrite[1] as string);
    expect(writtenData.channels['C123']).toBeUndefined();
  });

  it('should clean up channel with multiple threads', async () => {
    // Setup: Channel with main + 2 threads
    const mockStore = {
      channels: {
        'C123': {
          ...mockSession,
          threads: {
            '1234.5678': {
              sessionId: 'thread-456',
              forkedFrom: 'main-session-123',
              workingDir: '/Users/testuser/projects/myapp',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/Users/testuser/projects/myapp',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
            '1234.9999': {
              sessionId: 'thread-789',
              forkedFrom: 'thread-456',
              workingDir: '/Users/testuser/projects/myapp',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/Users/testuser/projects/myapp',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
          },
        },
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === './sessions.json') return true;
      if (typeof path === 'string' && path.includes('.jsonl')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

    // Trigger channel_deleted event
    const handler = registeredHandlers['event_channel_deleted'];

    await handler({
      event: {
        channel: 'C123',
        type: 'channel_deleted',
      },
    });

    // Verify all 3 SDK files were deleted
    expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      '/mock/home/.claude/projects/-Users-testuser-projects-myapp/main-session-123.jsonl'
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      '/mock/home/.claude/projects/-Users-testuser-projects-myapp/thread-456.jsonl'
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      '/mock/home/.claude/projects/-Users-testuser-projects-myapp/thread-789.jsonl'
    );

    // Verify sessions.json was updated
    const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const writtenData = JSON.parse(finalWrite[1] as string);
    expect(writtenData.channels['C123']).toBeUndefined();
  });

  it('should handle deleting channel with no session', async () => {
    // Empty store
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

    // Trigger channel_deleted event
    const handler = registeredHandlers['event_channel_deleted'];

    // Should not throw
    await expect(
      handler({
        event: {
          channel: 'C999',
          type: 'channel_deleted',
        },
      })
    ).resolves.not.toThrow();

    // Should not attempt to delete any files
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('should not affect other channels when one is deleted', async () => {
    // Setup: Two channels
    const mockStore = {
      channels: {
        'C123': mockSession,
        'C456': {
          ...mockSession,
          sessionId: 'other-session',
        },
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === './sessions.json') return true;
      if (typeof path === 'string' && path.includes('.jsonl')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

    // Trigger channel_deleted event for C123
    const handler = registeredHandlers['event_channel_deleted'];

    await handler({
      event: {
        channel: 'C123',
        type: 'channel_deleted',
      },
    });

    // Verify C123 deleted but C456 remains
    const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const writtenData = JSON.parse(finalWrite[1] as string);
    expect(writtenData.channels['C123']).toBeUndefined();
    expect(writtenData.channels['C456']).toBeDefined();
    expect(writtenData.channels['C456'].sessionId).toBe('other-session');
  });

  it('should not crash bot when SDK file deletion fails', async () => {
    // Setup: Channel exists
    const mockStore = {
      channels: {
        'C123': mockSession,
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === './sessions.json') return true;
      if (typeof path === 'string' && path.includes('.jsonl')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

    // Make unlinkSync throw (simulating permission error)
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    // Capture console.error to verify error is logged
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Trigger channel_deleted event
    const handler = registeredHandlers['event_channel_deleted'];

    // Should NOT throw - event handler should catch and continue
    await expect(
      handler({
        event: {
          channel: 'C123',
          type: 'channel_deleted',
        },
      })
    ).resolves.not.toThrow();

    // Verify error was logged
    expect(consoleSpy).toHaveBeenCalled();

    // Verify sessions.json was still updated (cleanup continues despite SDK file error)
    const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const writtenData = JSON.parse(finalWrite[1] as string);
    expect(writtenData.channels['C123']).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it('should continue processing when SDK files are already deleted', async () => {
    // Setup: Channel with main + threads, but SDK files were deleted externally
    const mockStore = {
      channels: {
        'C123': {
          ...mockSession,
          threads: {
            '1234.5678': {
              sessionId: 'thread-456',
              forkedFrom: 'main-session-123',
              workingDir: '/Users/testuser/projects/myapp',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/Users/testuser/projects/myapp',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
          },
        },
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === './sessions.json') return true;
      // SDK files do NOT exist (already deleted externally)
      if (typeof path === 'string' && path.includes('.jsonl')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

    // Capture console.log to verify info messages
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Trigger channel_deleted event
    const handler = registeredHandlers['event_channel_deleted'];

    await handler({
      event: {
        channel: 'C123',
        type: 'channel_deleted',
      },
    });

    // Verify unlinkSync was NOT called (files don't exist)
    expect(fs.unlinkSync).not.toHaveBeenCalled();

    // Verify info messages were logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SDK session file not found')
    );

    // Verify sessions.json was still updated
    const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const writtenData = JSON.parse(finalWrite[1] as string);
    expect(writtenData.channels['C123']).toBeUndefined();

    consoleSpy.mockRestore();
  });
});
