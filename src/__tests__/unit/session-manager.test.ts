import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSession, saveSession, loadSessions, saveSessions, deleteSession, saveThreadSession, getThreadSession } from '../../session-manager.js';
import type { Session, ThreadSession } from '../../session-manager.js';

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
    it('should return empty store if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadSessions();

      expect(result).toEqual({ channels: {} });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should load sessions from file if it exists', () => {
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

      expect(result).toEqual(mockStore);
      expect(fs.readFileSync).toHaveBeenCalledWith('./sessions.json', 'utf-8');
    });
  });

  describe('getSession', () => {
    it('should return null if channel has no session', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getSession('C123');

      expect(result).toBeNull();
    });

    it('should return session if channel has one', () => {
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

      expect(result).toEqual(mockSession);
    });
  });

  describe('saveSession', () => {
    it('should create new session with defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      saveSession('C123', { sessionId: 'new-sess' });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);

      expect(writtenData.channels['C123'].sessionId).toBe('new-sess');
      expect(writtenData.channels['C123'].mode).toBe('default');
      expect(writtenData.channels['C123'].lastActiveAt).toBeDefined();
    });

    it('should merge with existing session', () => {
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

      saveSession('C123', { workingDir: '/new/path' });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);

      expect(writtenData.channels['C123'].sessionId).toBe('old-sess'); // preserved
      expect(writtenData.channels['C123'].workingDir).toBe('/new/path'); // updated
      expect(writtenData.channels['C123'].createdAt).toBe(1000); // preserved
    });

    it('should update lastActiveAt on every save', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const before = Date.now();
      saveSession('C123', {});
      const after = Date.now();

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      const lastActiveAt = writtenData.channels['C123'].lastActiveAt;

      expect(lastActiveAt).toBeGreaterThanOrEqual(before);
      expect(lastActiveAt).toBeLessThanOrEqual(after);
    });
  });

  describe('saveSessions', () => {
    it('should write formatted JSON to file', () => {
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

    it('should delete channel with main session only', () => {
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
      deleteSession('C123');

      // Verify SDK file was deleted
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        '/mock/home/.claude/projects/-Users-testuser-projects-myapp/main-session-123.jsonl'
      );

      // Verify sessions.json was updated
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should delete channel with main session and multiple threads', () => {
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
      deleteSession('C123');

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

    it('should handle deleting non-existent channel safely', () => {
      // Empty store
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

      // Should not throw
      expect(() => deleteSession('C999')).not.toThrow();

      // Should not attempt to delete any files
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should persist deletion to sessions.json', () => {
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
      deleteSession('C123');

      // Verify final state written to disk
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      expect(finalWrite[0]).toBe('./sessions.json');
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });

    it('should handle channel with no sessionId (edge case)', () => {
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
      expect(() => deleteSession('C123')).not.toThrow();

      // Should not attempt to delete SDK file (sessionId is null)
      expect(fs.unlinkSync).not.toHaveBeenCalled();

      // Should still delete from sessions.json
      const finalWrite = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      const writtenData = JSON.parse(finalWrite[1] as string);
      expect(writtenData.channels['C123']).toBeUndefined();
    });
  });
});
