import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSession,
  saveSession,
  loadSessions,
  saveSessions,
  deleteSession,
  saveThreadSession,
  getThreadSession,
  saveMessageMapping,
  getMessageMapping,
  findForkPointMessageId,
  getOrCreateThreadSession,
  getLastSyncedMessageId,
  getMessageMapUuids,
  getSyncedMessageUuids,
  addSyncedMessageUuid,
  clearSyncedMessageUuids,
  addSlackOriginatedUserUuid,
  isSlackOriginatedUserUuid,
  clearSlackOriginatedUserUuids,
} from '../../session-manager.js';
import type { Session, ThreadSession, SlackMessageMapping, ActivityEntry } from '../../session-manager.js';

// Mock the fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    realpathSync: vi.fn((path: string) => path), // Identity function for tests
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

import fs from 'fs';

describe('session-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSessions', () => {
    it('should return empty store if file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadSessions();

      expect(result).toEqual({ channels: {} });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should load sessions from file if it exists', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'sess-123',
            workingDir: '/tmp',
            mode: 'plan',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: true,
            configuredPath: '/test/dir',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = loadSessions();

      // Migration adds previousSessionIds to existing sessions
      expect(result.channels['C123'].previousSessionIds).toEqual([]);
      expect(result.channels['C123'].sessionId).toBe('sess-123');
      expect(fs.readFileSync).toHaveBeenCalledWith('./sessions.json', 'utf-8');
    });
  });

  describe('getSession', () => {
    it('should return null if channel has no session', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getSession('C123');

      expect(result).toBeNull();
    });

    it('should return session if channel has one', async () => {
      const mockSession = {
        sessionId: 'sess-456',
        workingDir: '/home/user',
        mode: 'bypassPermissions' as const,
        createdAt: 1000,
        lastActiveAt: 2000,
        pathConfigured: true,
        configuredPath: '/test/dir',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: { 'C123': mockSession },
      }));

      const result = getSession('C123');

      // Migration adds previousSessionIds
      expect(result?.sessionId).toBe('sess-456');
      expect(result?.previousSessionIds).toEqual([]);
    });
  });

  describe('saveSession', () => {
    it('should create new session with defaults', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await saveSession('C123', { sessionId: 'new-sess' });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);

      expect(writtenData.channels['C123'].sessionId).toBe('new-sess');
      expect(writtenData.channels['C123'].mode).toBe('default');
      expect(writtenData.channels['C123'].lastActiveAt).toBeDefined();
    });

    it('should merge with existing session', async () => {
      const existingSession = {
        sessionId: 'old-sess',
        workingDir: '/old/path',
        mode: 'plan' as const,
        createdAt: 1000,
        lastActiveAt: 1500,
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: { 'C123': existingSession },
      }));

      await saveSession('C123', { workingDir: '/new/path' });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);

      expect(writtenData.channels['C123'].sessionId).toBe('old-sess'); // preserved
      expect(writtenData.channels['C123'].workingDir).toBe('/new/path'); // updated
      expect(writtenData.channels['C123'].createdAt).toBe(1000); // preserved
    });

    it('should update lastActiveAt on every save', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const before = Date.now();
      await saveSession('C123', {});
      const after = Date.now();

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      const lastActiveAt = writtenData.channels['C123'].lastActiveAt;

      expect(lastActiveAt).toBeGreaterThanOrEqual(before);
      expect(lastActiveAt).toBeLessThanOrEqual(after);
    });

  });

  describe('saveSessions', () => {
    it('should write formatted JSON to file', async () => {
      const store = {
        channels: {
          'C123': {
            sessionId: 'sess-123',
            workingDir: '/tmp',
            mode: 'plan' as const,
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      saveSessions(store);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        './sessions.json',
        JSON.stringify(store, null, 2)
      );
    });
  });

  describe('deleteSession', () => {
    const mockWorkingDir = '/Users/testuser/projects/myapp';

    beforeEach(() => {
      vi.clearAllMocks();
      // Setup: Start with empty sessions
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('should delete channel with main session only', async () => {
      // Setup: Create channel with main session
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      // Mock session exists
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        // sessions.json exists
        if (path === './sessions.json') return true;
        // SDK file exists
        if (typeof path === 'string' && path.endsWith('main-session-123.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Delete channel
      await deleteSession('C123');

      // Verify SDK file was deleted
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/main-session-123.jsonl'
      );

      // Verify sessions.json was updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should delete channel with main session and multiple threads', async () => {
      // Setup: Create channel with main + 2 threads
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.5678': {
                sessionId: 'thread-session-456',
                forkedFrom: 'main-session-123',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
                configuredBy: 'U123',
                configuredAt: Date.now(),
              },
              '1234.9999': {
                sessionId: 'thread-session-789',
                forkedFrom: 'main-session-123',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
                configuredBy: 'U123',
                configuredAt: Date.now(),
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        // All SDK files exist
        if (typeof path === 'string' && path.includes('.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Delete channel
      await deleteSession('C123');

      // Verify all 3 SDK files were deleted
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/main-session-123.jsonl'
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/thread-session-456.jsonl'
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/thread-session-789.jsonl'
      );

      // Verify sessions.json was updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should handle deleting non-existent channel safely', async () => {
      // Empty store
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

      // Should not throw
      await expect(deleteSession('C999')).resolves.not.toThrow();

      // Should not attempt to delete any files
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should persist deletion to sessions.json', async () => {
      // Setup: Channel exists
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'test-session',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        if (typeof path === 'string' && path.includes('test-session.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Delete
      await deleteSession('C123');

      // Verify final state written to disk
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      expect(finalWrite[0]).toBe('./sessions.json');
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should handle channel with no sessionId (edge case)', async () => {
      // Setup: Channel with null sessionId
      const mockStore = {
        channels: {
          'C123': {
            sessionId: null,
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Should not throw when deleting
      await expect(deleteSession('C123')).resolves.not.toThrow();

      // Should not attempt to delete SDK file (sessionId is null)
      expect(fs.unlinkSync).not.toHaveBeenCalled();

      // Should still delete from sessions.json
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should continue deleting other sessions when one SDK file deletion fails', async () => {
      // Setup: Channel with main + 2 threads, middle one will fail
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.5678': {
                sessionId: 'thread-session-456',
                forkedFrom: 'main-session-123',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
                configuredBy: 'U123',
                configuredAt: Date.now(),
              },
              '1234.9999': {
                sessionId: 'thread-session-789',
                forkedFrom: 'main-session-123',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
                configuredBy: 'U123',
                configuredAt: Date.now(),
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        // All SDK files exist
        if (typeof path === 'string' && path.includes('.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Make unlinkSync throw for one specific file (simulating permission error)
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.includes('thread-session-456.jsonl')) {
          throw new Error('EACCES: permission denied');
        }
        // Other files delete successfully
      });

      // Capture console.error to verify error is logged
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw - error handling should catch and continue
      await expect(deleteSession('C123')).resolves.not.toThrow();

      // Verify error was logged for the failed file
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error deleting SDK session file thread-session-456'),
        expect.any(Error)
      );

      // Verify all 3 files were attempted to be deleted
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);

      // Verify sessions.json was still updated (cleanup continues despite SDK file error)
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();

      consoleSpy.mockRestore();
    });

    it('should handle SDK file not found gracefully', async () => {
      // Setup: Channel exists but SDK file was already deleted externally
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        // SDK file does NOT exist (already deleted)
        if (typeof path === 'string' && path.includes('.jsonl')) return false;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Capture console.log to verify info message
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Should not throw
      await expect(deleteSession('C123')).resolves.not.toThrow();

      // Verify info message was logged (not error)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SDK session file not found')
      );

      // Verify unlinkSync was NOT called (file doesn't exist)
      expect(fs.unlinkSync).not.toHaveBeenCalled();

      // Verify sessions.json was still updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();

      consoleSpy.mockRestore();
    });

    it('should handle large session history (10+ previous sessions from /clear)', async () => {
      // Setup: Channel with many previous sessions (simulating heavy /clear usage)
      const previousIds = Array.from({ length: 12 }, (_, i) => `prev-session-${i + 1}`);
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'current-session',
            previousSessionIds: previousIds,
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        if (typeof path === 'string' && path.includes('.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Delete channel
      await deleteSession('C123');

      // Should delete all 13 SDK files (1 current + 12 previous)
      expect(fs.unlinkSync).toHaveBeenCalledTimes(13);

      // Verify current session was deleted
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('current-session.jsonl')
      );

      // Verify all previous sessions were deleted
      for (let i = 1; i <= 12; i++) {
        expect(fs.unlinkSync).toHaveBeenCalledWith(
          expect.stringContaining(`prev-session-${i}.jsonl`)
        );
      }

      // Verify sessions.json was updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should delete nested thread hierarchy (thread forked from thread)', async () => {
      // Setup: Main → Thread1 → Thread2 (nested fork)
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.001': {
                sessionId: 'thread-1',
                forkedFrom: 'main-session',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
                configuredBy: 'U123',
                configuredAt: Date.now(),
              },
              '1234.002': {
                sessionId: 'thread-2',
                forkedFrom: 'thread-1',
                forkedFromThreadTs: '1234.001', // Forked from another thread
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
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

      // Delete channel
      await deleteSession('C123');

      // Should delete all 3 sessions (main + 2 nested threads)
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('main-session.jsonl')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('thread-1.jsonl')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('thread-2.jsonl')
      );

      // Verify sessions.json was updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });
  });

  // ============================================================================
  // previousSessionIds Tracking Tests (for /clear command)
  // ============================================================================

  describe('previousSessionIds tracking', () => {
    it('should initialize previousSessionIds as empty array for new sessions', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await saveSession('new-channel', { sessionId: 'S1' });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['new-channel'].previousSessionIds).toEqual([]);
    });

    it('should preserve previousSessionIds when saving other fields', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'S2',
            previousSessionIds: ['S1'],
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Update session with new sessionId but without previousSessionIds
      await saveSession('C123', { sessionId: 'S3' });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].sessionId).toBe('S3');
      expect(writtenData.channels['C123'].previousSessionIds).toEqual(['S1']); // preserved
    });

    it('should allow updating previousSessionIds via saveSession', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'S2',
            previousSessionIds: ['S1'],
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Update both sessionId and previousSessionIds (as /clear does)
      await saveSession('C123', {
        sessionId: 'S3',
        previousSessionIds: ['S1', 'S2'],
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].sessionId).toBe('S3');
      expect(writtenData.channels['C123'].previousSessionIds).toEqual(['S1', 'S2']);
    });

    it('should migrate existing sessions without previousSessionIds field', async () => {
      // Simulate old session format without previousSessionIds
      const oldFormatStore = {
        channels: {
          'C123': {
            sessionId: 'S1',
            workingDir: '/test',
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            // No previousSessionIds field
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(oldFormatStore));

      // loadSessions should migrate and add empty previousSessionIds
      const result = loadSessions();

      expect(result.channels['C123'].previousSessionIds).toEqual([]);
    });

    it('should clear lastUsage when /clear sets sessionId to null', async () => {
      // Setup: Session with lastUsage data from previous query
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'old-session',
            previousSessionIds: [],
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            lastUsage: {
              inputTokens: 34,
              outputTokens: 2499,
              cacheReadInputTokens: 94023,
              contextWindow: 200000,
              model: 'claude-opus-4-5-20251101',
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Simulate /clear: set sessionId to null and clear lastUsage
      await saveSession('C123', {
        sessionId: null,
        previousSessionIds: ['old-session'],
        lastUsage: undefined,
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].sessionId).toBeNull();
      expect(writtenData.channels['C123'].previousSessionIds).toEqual(['old-session']);
      // lastUsage should be cleared (undefined means it won't appear in JSON)
      expect(writtenData.channels['C123'].lastUsage).toBeUndefined();
    });
  });

  describe('deleteSession with previousSessionIds', () => {
    const mockWorkingDir = '/Users/testuser/projects/myapp';

    it('should delete all previous session SDK files', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'S3',
            previousSessionIds: ['S1', 'S2'],
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        // All SDK files exist
        if (typeof path === 'string' && path.includes('.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      await deleteSession('C123');

      // Should delete all 3 SDK files (current + 2 previous)
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/S3.jsonl'
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/S1.jsonl'
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/S2.jsonl'
      );
    });

    it('should handle empty previousSessionIds', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'S1',
            previousSessionIds: [],
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === './sessions.json') return true;
        if (typeof path === 'string' && path.includes('S1.jsonl')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      await deleteSession('C123');

      // Should only delete current session, no previous
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/S1.jsonl'
      );
    });

    it('should delete previous sessions AND thread sessions', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'S3',
            previousSessionIds: ['S1', 'S2'],
            workingDir: mockWorkingDir,
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: mockWorkingDir,
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.5678': {
                sessionId: 'T1',
                forkedFrom: 'S1',
                workingDir: mockWorkingDir,
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: mockWorkingDir,
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

      await deleteSession('C123');

      // Should delete: S3 (current) + S1, S2 (previous) + T1 (thread) = 4 files
      expect(fs.unlinkSync).toHaveBeenCalledTimes(4);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('S3.jsonl')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('S1.jsonl')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('S2.jsonl')
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('T1.jsonl')
      );
    });
  });

  // ============================================================================
  // Message Mapping Tests (for point-in-time thread forking)
  // ============================================================================

  describe('saveMessageMapping', () => {
    it('should save message mapping to channel session', async () => {
      // Setup: Create channel session
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      await saveMessageMapping('C123', '1234.001', {
        sdkMessageId: 'msg_017pagAKz',
        sessionId: 'main-session-123',
        type: 'assistant',
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].messageMap).toBeDefined();
      expect(writtenData.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_017pagAKz');
      expect(writtenData.channels['C123'].messageMap['1234.001'].sessionId).toBe('main-session-123');
      expect(writtenData.channels['C123'].messageMap['1234.001'].type).toBe('assistant');
    });

    it('should handle multiple mappings', async () => {
      // Setup: Channel with existing mapping
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': {
                sdkMessageId: 'msg_001',
                sessionId: 'main-session-123',
                type: 'user' as const,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      await saveMessageMapping('C123', '1234.002', {
        sdkMessageId: 'msg_002',
        sessionId: 'main-session-123',
        type: 'assistant',
        parentSlackTs: '1234.001',
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].messageMap['1234.001']).toBeDefined();
      expect(writtenData.channels['C123'].messageMap['1234.002'].sdkMessageId).toBe('msg_002');
      expect(writtenData.channels['C123'].messageMap['1234.002'].parentSlackTs).toBe('1234.001');
    });

    it('should not save if channel does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

      // Should not throw
      await expect(saveMessageMapping('C999', '1234.001', {
        sdkMessageId: 'msg_001',
        sessionId: 'some-session',
        type: 'user',
      })).resolves.not.toThrow();

      // Should not write anything
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('getMessageMapping', () => {
    it('should return mapping if exists', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': {
                sdkMessageId: 'msg_017pagAKz',
                sessionId: 'main-session-123',
                type: 'assistant' as const,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const mapping = getMessageMapping('C123', '1234.001');
      expect(mapping).toEqual({
        sdkMessageId: 'msg_017pagAKz',
        sessionId: 'main-session-123',
        type: 'assistant',
      });
    });

    it('should return null if mapping does not exist', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {},
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const mapping = getMessageMapping('C123', '1234.999');
      expect(mapping).toBeNull();
    });

    it('should return null if channel has no messageMap', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const mapping = getMessageMapping('C123', '1234.001');
      expect(mapping).toBeNull();
    });
  });

  describe('findForkPointMessageId', () => {
    it('should return assistant message ID and sessionId when clicking on bot message', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.002': {
                sdkMessageId: 'msg_017pagAKz',
                sessionId: 'main-session-123',
                type: 'assistant' as const,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = findForkPointMessageId('C123', '1234.002');
      expect(result).toEqual({
        messageId: 'msg_017pagAKz',
        sessionId: 'main-session-123',
      });
    });

    it('should find LAST assistant message BEFORE user message (not response to it)', async () => {
      // Timeline: user → bot → user (clicking here) → bot
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'user_002', sessionId: 'main-session-123', type: 'user' as const },  // User clicks HERE
              '1234.004': { sdkMessageId: 'msg_002', sessionId: 'main-session-123', type: 'assistant' as const },  // Response AFTER
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Should return msg_001 (before .003), NOT msg_002 (after .003)
      const result = findForkPointMessageId('C123', '1234.003');
      expect(result).toEqual({
        messageId: 'msg_001',
        sessionId: 'main-session-123',
      });
    });

    it('should return null if no assistant message before the timestamp', async () => {
      // User's first message - no bot response yet
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = findForkPointMessageId('C123', '1234.001');
      expect(result).toBeNull();
    });

    it('should work with split messages (continuation)', async () => {
      // Long response split into multiple Slack messages
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const, isContinuation: true },
              '1234.004': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const, isContinuation: true },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // All should return the same SDK message ID and sessionId
      expect(findForkPointMessageId('C123', '1234.002')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
      expect(findForkPointMessageId('C123', '1234.003')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
      expect(findForkPointMessageId('C123', '1234.004')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
    });

    it('should return null if channel has no messageMap', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const messageId = findForkPointMessageId('C123', '1234.001');
      expect(messageId).toBeNull();
    });

    it('should ignore placeholder ts values (starting with _slack_) when finding fallback', async () => {
      // This tests the fix for point-in-time forking: placeholder ts values
      // should not be considered when finding the last assistant message
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_text_001', sessionId: 'main-session-123', type: 'assistant' as const },  // Real assistant
              '_slack_msg_thinking_001': { sdkMessageId: 'msg_thinking_001', sessionId: 'main-session-123', type: 'assistant' as const },  // Placeholder (thinking)
              '1234.003': { sdkMessageId: 'user_002', sessionId: 'main-session-123', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Should return real assistant message (1234.002), not placeholder
      const result = findForkPointMessageId('C123', '1234.003');
      expect(result).toEqual({
        messageId: 'msg_text_001',  // Real assistant message, not thinking placeholder
        sessionId: 'main-session-123',
      });
    });

    it('should find previous assistant when exact ts not found and ignore placeholders', async () => {
      // User replies to a status message (not in messageMap) - should find last real assistant
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },
              '_slack_thinking_uuid': { sdkMessageId: 'thinking_uuid', sessionId: 'main-session-123', type: 'assistant' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Looking for 1234.005 (not in map) - should find 1234.002 as last real assistant
      const result = findForkPointMessageId('C123', '1234.005');
      expect(result).toEqual({
        messageId: 'msg_001',
        sessionId: 'main-session-123',
      });
    });

    it('should not return future messages even with placeholder filtering', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.003': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },  // Future message
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Looking for 1234.001 - should not return 1234.003 (it's in the future)
      const result = findForkPointMessageId('C123', '1234.001');
      expect(result).toBeNull();
    });
  });

  describe('getLastSyncedMessageId', () => {
    it('should return null when no messageMap entries', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getLastSyncedMessageId('C123');
      expect(result).toBeNull();
    });

    it('should return newest entry by Slack timestamp', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234567890.000100': { sdkMessageId: 'uuid-1', sessionId: 'main-session-123', type: 'user' as const },
              '1234567890.000200': { sdkMessageId: 'uuid-2', sessionId: 'main-session-123', type: 'assistant' as const },
              '1234567890.000300': { sdkMessageId: 'uuid-3', sessionId: 'main-session-123', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getLastSyncedMessageId('C123');
      expect(result?.sdkMessageId).toBe('uuid-3');
      expect(result?.sessionId).toBe('main-session-123');
    });

    it('should filter by sessionId when provided', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'new-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234567890.000100': { sdkMessageId: 'uuid-old-1', sessionId: 'old-session', type: 'user' as const },
              '1234567890.000200': { sdkMessageId: 'uuid-old-2', sessionId: 'old-session', type: 'assistant' as const },
              '1234567890.000300': { sdkMessageId: 'uuid-new-1', sessionId: 'new-session', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Without filter: should return newest (uuid-new-1)
      const allResult = getLastSyncedMessageId('C123');
      expect(allResult?.sdkMessageId).toBe('uuid-new-1');

      // With filter for new-session: should return uuid-new-1
      const newResult = getLastSyncedMessageId('C123', undefined, 'new-session');
      expect(newResult?.sdkMessageId).toBe('uuid-new-1');

      // With filter for old-session: should return uuid-old-2 (newest from old)
      const oldResult = getLastSyncedMessageId('C123', undefined, 'old-session');
      expect(oldResult?.sdkMessageId).toBe('uuid-old-2');
    });

    it('should return null if no messages match sessionId filter', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234567890.000100': { sdkMessageId: 'uuid-1', sessionId: 'other-session', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getLastSyncedMessageId('C123', undefined, 'main-session');
      expect(result).toBeNull();
    });

    it('should return null for channel without session', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

      const result = getLastSyncedMessageId('C999');
      expect(result).toBeNull();
    });

    it('should handle empty messageMap', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {},
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getLastSyncedMessageId('C123');
      expect(result).toBeNull();
    });
  });

  describe('messageMap preservation', () => {
    it('should preserve messageMap when saveSession is called', async () => {
      // Setup: Start with empty store
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Step 1: Create initial session
      await saveSession('C123', {
        sessionId: 'sess-1',
        workingDir: '/test',
        mode: 'plan',
        pathConfigured: true,
        configuredPath: '/test',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      // Capture the written data and use it for next read
      let currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Step 2: Save a message mapping
      await saveMessageMapping('C123', '1234.001', {
        sdkMessageId: 'msg_001',
        sessionId: 'sess-1',
        type: 'assistant',
      });

      // Update current store from the write
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Verify mapping was saved
      expect(currentStore.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_001');

      // Step 3: Save session again (simulating what happens after SDK returns new session ID)
      await saveSession('C123', { sessionId: 'sess-2' });

      // Get final written data
      const finalStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[2][1] as string);

      // CRITICAL: Verify messageMap was preserved after saveSession
      expect(finalStore.channels['C123'].messageMap).toBeDefined();
      expect(finalStore.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_001');
      expect(finalStore.channels['C123'].sessionId).toBe('sess-2');
    });

    it('should preserve messageMap when saving multiple mappings interleaved with saveSession', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Create session
      await saveSession('C123', {
        sessionId: 'sess-1',
        workingDir: '/test',
        mode: 'plan',
        pathConfigured: true,
        configuredPath: '/test',
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      let currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save user message mapping
      await saveMessageMapping('C123', '1234.001', { sdkMessageId: 'user_001', sessionId: 'sess-1', type: 'user' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save assistant message mapping
      await saveMessageMapping('C123', '1234.002', { sdkMessageId: 'msg_001', sessionId: 'sess-1', type: 'assistant' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[2][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save session (this was wiping messageMap before the fix)
      await saveSession('C123', { sessionId: 'sess-1' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[3][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Add another user message
      await saveMessageMapping('C123', '1234.003', { sdkMessageId: 'user_002', sessionId: 'sess-1', type: 'user' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[4][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save session again
      await saveSession('C123', { sessionId: 'sess-1' });
      const finalStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[5][1] as string);

      // All mappings should be preserved
      expect(Object.keys(finalStore.channels['C123'].messageMap)).toHaveLength(3);
      expect(finalStore.channels['C123'].messageMap['1234.001'].type).toBe('user');
      expect(finalStore.channels['C123'].messageMap['1234.002'].type).toBe('assistant');
      expect(finalStore.channels['C123'].messageMap['1234.003'].type).toBe('user');
    });
  });

  describe('getMessageMapUuids', () => {
    it('should return empty set when channel does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getMessageMapUuids('C999');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should return empty set when messageMap is empty', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'sess-1',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {},
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getMessageMapUuids('C123');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should return all sdkMessageId values from messageMap', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'sess-1',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              '1234.001': { sdkMessageId: 'uuid-aaa', sessionId: 'sess-1', type: 'user' },
              '1234.002': { sdkMessageId: 'uuid-bbb', sessionId: 'sess-1', type: 'assistant' },
              '1234.003': { sdkMessageId: 'uuid-ccc', sessionId: 'sess-1', type: 'user' },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getMessageMapUuids('C123');

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('uuid-aaa')).toBe(true);
      expect(result.has('uuid-bbb')).toBe(true);
      expect(result.has('uuid-ccc')).toBe(true);
    });

    it('should include UUIDs from multiple sessions (after /clear)', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'sess-2',  // Current session
            previousSessionIds: ['sess-1'],
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              // Messages from old session
              '1234.001': { sdkMessageId: 'uuid-old-1', sessionId: 'sess-1', type: 'user' },
              '1234.002': { sdkMessageId: 'uuid-old-2', sessionId: 'sess-1', type: 'assistant' },
              // Messages from new session
              '1234.003': { sdkMessageId: 'uuid-new-1', sessionId: 'sess-2', type: 'user' },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = getMessageMapUuids('C123');

      // Should include UUIDs from both sessions
      expect(result.size).toBe(3);
      expect(result.has('uuid-old-1')).toBe(true);
      expect(result.has('uuid-old-2')).toBe(true);
      expect(result.has('uuid-new-1')).toBe(true);
    });
  });

  describe('getOrCreateThreadSession with ForkPointResult', () => {
    it('should create thread session with forkPoint (messageId + sessionId)', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Pass ForkPointResult with both messageId and sessionId
      const forkPoint = { messageId: 'msg_017pagAKz', sessionId: 'main-session-123' };
      const result = await getOrCreateThreadSession('C123', '1234.002', forkPoint);

      expect(result.isNewFork).toBe(true);
      expect(result.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
      // forkedFrom should use sessionId from forkPoint
      expect(result.session.forkedFrom).toBe('main-session-123');
    });

    it('should use forkPoint.sessionId even if main session is null (after /clear)', async () => {
      // This tests the "time travel" scenario - forking from message before /clear
      const mockStore = {
        channels: {
          'C123': {
            sessionId: null,  // Main session is null after /clear
            previousSessionIds: ['old-session-before-clear'],
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // forkPoint has session ID from BEFORE /clear
      const forkPoint = { messageId: 'msg_from_old_session', sessionId: 'old-session-before-clear' };
      const result = await getOrCreateThreadSession('C123', '1234.002', forkPoint);

      expect(result.isNewFork).toBe(true);
      expect(result.session.resumeSessionAtMessageId).toBe('msg_from_old_session');
      // CRITICAL: forkedFrom should be OLD session, not null
      expect(result.session.forkedFrom).toBe('old-session-before-clear');
    });

    it('should handle thread creation without fork point', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Create thread without fork point
      const result = await getOrCreateThreadSession('C123', '1234.999', null);

      expect(result.isNewFork).toBe(true);
      expect(result.session.resumeSessionAtMessageId).toBeUndefined();
      // Falls back to main session when no forkPoint
      expect(result.session.forkedFrom).toBe('main-session-123');
    });

    it('should inherit updateRateSeconds from main session', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            updateRateSeconds: 5,  // Custom rate set on main session
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getOrCreateThreadSession('C123', '1234.002', null);

      expect(result.isNewFork).toBe(true);
      expect(result.session.updateRateSeconds).toBe(5);  // Should inherit from parent
    });

    it('should inherit undefined updateRateSeconds from main session (uses default)', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            // updateRateSeconds not set - should be undefined
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getOrCreateThreadSession('C123', '1234.002', null);

      expect(result.isNewFork).toBe(true);
      expect(result.session.updateRateSeconds).toBeUndefined();  // Should inherit undefined
    });

    it('should return existing thread session with stored resumeSessionAtMessageId', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.002': {
                sessionId: 'thread-session-456',
                forkedFrom: 'main-session-123',
                workingDir: '/test',
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: '/test',
                configuredBy: 'U123',
                configuredAt: Date.now(),
                resumeSessionAtMessageId: 'msg_017pagAKz',
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getOrCreateThreadSession('C123', '1234.002');

      expect(result.isNewFork).toBe(false);
      expect(result.session.sessionId).toBe('thread-session-456');
      expect(result.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
    });
  });

  describe('saveThreadSession with lastUsage', () => {
    it('should save lastUsage to thread session', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {},
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const lastUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 45000,
        contextWindow: 200000,
        model: 'claude-sonnet-4-5',
      };

      await saveThreadSession('C123', 'thread123', { lastUsage });

      // Verify writeFileSync was called with the lastUsage
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].threads['thread123'].lastUsage).toEqual(lastUsage);
    });

    it('should preserve existing lastUsage when saving other fields', async () => {
      const existingLastUsage = {
        inputTokens: 500,
        outputTokens: 200,
        cacheReadInputTokens: 10000,
        contextWindow: 200000,
        model: 'claude-haiku',
      };

      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              'thread123': {
                sessionId: 'thread-session',
                forkedFrom: 'main-session',
                workingDir: '/test',
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: '/test',
                configuredBy: 'U123',
                configuredAt: Date.now(),
                lastUsage: existingLastUsage,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Update mode but not lastUsage
      await saveThreadSession('C123', 'thread123', { mode: 'bypassPermissions' });

      // Verify lastUsage was preserved
      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].threads['thread123'].lastUsage).toEqual(existingLastUsage);
      expect(writtenData.channels['C123'].threads['thread123'].mode).toBe('bypassPermissions');
    });

    it('should allow overwriting lastUsage', async () => {
      const oldUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 1000,
        contextWindow: 200000,
        model: 'old-model',
      };

      const newUsage = {
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadInputTokens: 50000,
        contextWindow: 200000,
        model: 'claude-opus-4-5',
      };

      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              'thread123': {
                sessionId: 'thread-session',
                forkedFrom: 'main-session',
                workingDir: '/test',
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: '/test',
                configuredBy: 'U123',
                configuredAt: Date.now(),
                lastUsage: oldUsage,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      await saveThreadSession('C123', 'thread123', { lastUsage: newUsage });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].threads['thread123'].lastUsage).toEqual(newUsage);
    });
  });

  // ============================================================================
  // Synced Message UUIDs Tests (for /ff command)
  // ============================================================================

  describe('syncedMessageUuids', () => {
    describe('getSyncedMessageUuids', () => {
      it('should return empty set when no channel session exists', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        const result = getSyncedMessageUuids('C999');
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
      });

      it('should return empty set when no syncedMessageUuids field', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        const result = getSyncedMessageUuids('C123');
        expect(result.size).toBe(0);
      });

      it('should return set of synced UUIDs for channel', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        const result = getSyncedMessageUuids('C123');
        expect(result.size).toBe(3);
        expect(result.has('uuid-1')).toBe(true);
        expect(result.has('uuid-2')).toBe(true);
        expect(result.has('uuid-3')).toBe(true);
      });

      it('should return set of synced UUIDs for thread', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['main-uuid-1'],
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                  syncedMessageUuids: ['thread-uuid-1', 'thread-uuid-2'],
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        // Channel UUIDs
        const channelResult = getSyncedMessageUuids('C123');
        expect(channelResult.size).toBe(1);
        expect(channelResult.has('main-uuid-1')).toBe(true);

        // Thread UUIDs
        const threadResult = getSyncedMessageUuids('C123', 'thread123');
        expect(threadResult.size).toBe(2);
        expect(threadResult.has('thread-uuid-1')).toBe(true);
        expect(threadResult.has('thread-uuid-2')).toBe(true);
      });
    });

    describe('addSyncedMessageUuid', () => {
      it('should add UUID to channel session', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSyncedMessageUuid('C123', 'new-uuid-1');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].syncedMessageUuids).toEqual(['new-uuid-1']);
      });

      it('should append UUID to existing list', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['uuid-1', 'uuid-2'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSyncedMessageUuid('C123', 'uuid-3');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].syncedMessageUuids).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
      });

      it('should not add duplicate UUID', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['uuid-1', 'uuid-2'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSyncedMessageUuid('C123', 'uuid-1');  // Already exists

        // Should not call writeFileSync since no change
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('should add UUID to thread session', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSyncedMessageUuid('C123', 'thread-uuid-1', 'thread123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].threads['thread123'].syncedMessageUuids).toEqual(['thread-uuid-1']);
      });

      it('should warn if channel not found', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        await addSyncedMessageUuid('C999', 'uuid-1');

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot add synced UUID'));
        consoleSpy.mockRestore();
      });
    });

    describe('clearSyncedMessageUuids', () => {
      it('should clear UUIDs for channel', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await clearSyncedMessageUuids('C123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].syncedMessageUuids).toEqual([]);
      });

      it('should clear UUIDs for thread', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              syncedMessageUuids: ['main-uuid'],
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                  syncedMessageUuids: ['thread-uuid-1', 'thread-uuid-2'],
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await clearSyncedMessageUuids('C123', 'thread123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        // Thread UUIDs should be cleared
        expect(writtenData.channels['C123'].threads['thread123'].syncedMessageUuids).toEqual([]);
        // Main channel UUIDs should be preserved
        expect(writtenData.channels['C123'].syncedMessageUuids).toEqual(['main-uuid']);
      });

      it('should do nothing if channel not found', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        await clearSyncedMessageUuids('C999');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });
    });
  });

  // ============================================================================
  // Slack-Originated User Message Tracking
  // ============================================================================

  describe('Slack-Originated User UUIDs', () => {
    describe('addSlackOriginatedUserUuid', () => {
      it('should add UUID to main channel session', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSlackOriginatedUserUuid('C123', 'uuid-from-slack');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].slackOriginatedUserUuids).toEqual(['uuid-from-slack']);
      });

      it('should append to existing UUIDs without duplicates', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['uuid-1'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSlackOriginatedUserUuid('C123', 'uuid-2');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].slackOriginatedUserUuids).toEqual(['uuid-1', 'uuid-2']);
      });

      it('should not add duplicate UUID', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['uuid-1'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSlackOriginatedUserUuid('C123', 'uuid-1');

        // Should not write since UUID already exists
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('should add UUID to thread session', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await addSlackOriginatedUserUuid('C123', 'thread-uuid', 'thread123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].threads['thread123'].slackOriginatedUserUuids).toEqual(['thread-uuid']);
      });

      it('should not save if channel not found', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        await addSlackOriginatedUserUuid('C999', 'uuid-1');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });
    });

    describe('isSlackOriginatedUserUuid', () => {
      it('should return true for Slack-originated UUID in main channel', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['uuid-from-slack', 'another-uuid'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        expect(isSlackOriginatedUserUuid('C123', 'uuid-from-slack')).toBe(true);
        expect(isSlackOriginatedUserUuid('C123', 'another-uuid')).toBe(true);
      });

      it('should return false for terminal-originated UUID', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['uuid-from-slack'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        expect(isSlackOriginatedUserUuid('C123', 'uuid-from-terminal')).toBe(false);
      });

      it('should return true for Slack-originated UUID in thread', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                  slackOriginatedUserUuids: ['thread-slack-uuid'],
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        expect(isSlackOriginatedUserUuid('C123', 'thread-slack-uuid', 'thread123')).toBe(true);
        expect(isSlackOriginatedUserUuid('C123', 'other-uuid', 'thread123')).toBe(false);
      });

      it('should return false if channel not found', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        expect(isSlackOriginatedUserUuid('C999', 'any-uuid')).toBe(false);
      });

      it('should return false if slackOriginatedUserUuids is undefined', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              // No slackOriginatedUserUuids field
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        expect(isSlackOriginatedUserUuid('C123', 'any-uuid')).toBe(false);
      });
    });

    describe('clearSlackOriginatedUserUuids', () => {
      it('should clear UUIDs from main channel', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'sess-1',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['uuid-1', 'uuid-2'],
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await clearSlackOriginatedUserUuids('C123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        expect(writtenData.channels['C123'].slackOriginatedUserUuids).toEqual([]);
      });

      it('should clear UUIDs from thread without affecting main channel', async () => {
        const mockStore = {
          channels: {
            'C123': {
              sessionId: 'main-session',
              workingDir: '/test',
              mode: 'plan' as const,
              createdAt: Date.now(),
              lastActiveAt: Date.now(),
              pathConfigured: true,
              configuredPath: '/test',
              configuredBy: 'U123',
              configuredAt: Date.now(),
              slackOriginatedUserUuids: ['main-uuid'],
              threads: {
                'thread123': {
                  sessionId: 'thread-session',
                  forkedFrom: 'main-session',
                  workingDir: '/test',
                  mode: 'plan' as const,
                  createdAt: Date.now(),
                  lastActiveAt: Date.now(),
                  pathConfigured: true,
                  configuredPath: '/test',
                  configuredBy: 'U123',
                  configuredAt: Date.now(),
                  slackOriginatedUserUuids: ['thread-uuid-1', 'thread-uuid-2'],
                },
              },
            },
          },
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

        await clearSlackOriginatedUserUuids('C123', 'thread123');

        const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
        // Thread UUIDs should be cleared
        expect(writtenData.channels['C123'].threads['thread123'].slackOriginatedUserUuids).toEqual([]);
        // Main channel UUIDs should be preserved
        expect(writtenData.channels['C123'].slackOriginatedUserUuids).toEqual(['main-uuid']);
      });

      it('should do nothing if channel not found', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

        await clearSlackOriginatedUserUuids('C999');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });
    });
  });

  describe('concurrent access', () => {
    it('should not lose UUIDs when adding concurrently', async () => {
      // Setup: channel exists with existing UUIDs
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'test-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            slackOriginatedUserUuids: [],
          },
        },
      };

      // Track all writes to verify all UUIDs are saved
      const writtenStores: string[] = [];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));
      vi.mocked(fs.writeFileSync).mockImplementation((_path, content) => {
        writtenStores.push(content as string);
        // Update mock to return the latest written store
        vi.mocked(fs.readFileSync).mockReturnValue(content as string);
      });

      // Action: Call addSlackOriginatedUserUuid 5 times in parallel with different UUIDs
      const uuids = ['uuid1', 'uuid2', 'uuid3', 'uuid4', 'uuid5'];
      await Promise.all(uuids.map(uuid => addSlackOriginatedUserUuid('C123', uuid)));

      // Assert: All UUIDs should be present in the final state
      const finalStore = JSON.parse(writtenStores[writtenStores.length - 1]);
      const savedUuids = finalStore.channels['C123'].slackOriginatedUserUuids;
      expect(savedUuids).toHaveLength(5);
      for (const uuid of uuids) {
        expect(savedUuids).toContain(uuid);
      }
    });
  });

  describe('addSlackOriginatedUserUuid thread creation', () => {
    it('should create thread entry if thread does not exist', async () => {
      // Setup: Channel exists but thread does not
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {},  // No threads yet
          },
        },
      };

      let writtenStore: any = null;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));
      vi.mocked(fs.writeFileSync).mockImplementation((_path, content) => {
        writtenStore = JSON.parse(content as string);
        vi.mocked(fs.readFileSync).mockReturnValue(content as string);
      });

      // Action: Add UUID for a thread that doesn't exist
      await addSlackOriginatedUserUuid('C123', 'user_uuid_123', '1234.5678');

      // Assert: Thread entry was created
      expect(writtenStore).not.toBeNull();
      expect(writtenStore.channels['C123'].threads['1234.5678']).toBeDefined();

      // Assert: Thread has correct structure (minimal entry)
      const thread = writtenStore.channels['C123'].threads['1234.5678'];
      expect(thread.sessionId).toBeNull();
      expect(thread.workingDir).toBe('/test');
      expect(thread.mode).toBe('plan');

      // Assert: UUID is in thread's slackOriginatedUserUuids
      expect(thread.slackOriginatedUserUuids).toContain('user_uuid_123');
    });

    it('should add UUID to existing thread', async () => {
      // Setup: Channel with existing thread
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'main-session',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            threads: {
              '1234.5678': {
                sessionId: 'thread-session',
                workingDir: '/test',
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: '/test',
                configuredBy: 'U123',
                configuredAt: Date.now(),
                slackOriginatedUserUuids: ['existing_uuid'],
              },
            },
          },
        },
      };

      let writtenStore: any = null;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));
      vi.mocked(fs.writeFileSync).mockImplementation((_path, content) => {
        writtenStore = JSON.parse(content as string);
        vi.mocked(fs.readFileSync).mockReturnValue(content as string);
      });

      // Action: Add new UUID to existing thread
      await addSlackOriginatedUserUuid('C123', 'new_uuid', '1234.5678');

      // Assert: Both UUIDs present
      const uuids = writtenStore.channels['C123'].threads['1234.5678'].slackOriginatedUserUuids;
      expect(uuids).toContain('existing_uuid');
      expect(uuids).toContain('new_uuid');
    });
  });
});
