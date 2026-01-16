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
  saveActivityLog,
  getActivityLog,
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

    it('should preserve activityLogs when updating session', () => {
      const existingEntries = [
        { timestamp: Date.now(), type: 'tool_start' as const, tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete' as const, tool: 'Read', durationMs: 100 },
      ];
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
        activityLogs: {
          'C123': existingEntries,
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: { 'C123': existingSession },
      }));

      // Update session with new sessionId - activityLogs should be preserved
      saveSession('C123', { sessionId: 'new-sess' });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);

      expect(writtenData.channels['C123'].sessionId).toBe('new-sess'); // updated
      expect(writtenData.channels['C123'].activityLogs).toEqual({ 'C123': existingEntries }); // preserved
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

  // ============================================================================
  // Message Mapping Tests (for point-in-time thread forking)
  // ============================================================================

  describe('saveMessageMapping', () => {
    it('should save message mapping to channel session', () => {
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

      saveMessageMapping('C123', '1234.001', {
        sdkMessageId: 'msg_017pagAKz',
        type: 'assistant',
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].messageMap).toBeDefined();
      expect(writtenData.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_017pagAKz');
      expect(writtenData.channels['C123'].messageMap['1234.001'].type).toBe('assistant');
    });

    it('should handle multiple mappings', () => {
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
                type: 'user' as const,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      saveMessageMapping('C123', '1234.002', {
        sdkMessageId: 'msg_002',
        type: 'assistant',
        parentSlackTs: '1234.001',
      });

      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenData.channels['C123'].messageMap['1234.001']).toBeDefined();
      expect(writtenData.channels['C123'].messageMap['1234.002'].sdkMessageId).toBe('msg_002');
      expect(writtenData.channels['C123'].messageMap['1234.002'].parentSlackTs).toBe('1234.001');
    });

    it('should not save if channel does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ channels: {} }));

      // Should not throw
      expect(() => saveMessageMapping('C999', '1234.001', {
        sdkMessageId: 'msg_001',
        type: 'user',
      })).not.toThrow();

      // Should not write anything
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('getMessageMapping', () => {
    it('should return mapping if exists', () => {
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
        type: 'assistant',
      });
    });

    it('should return null if mapping does not exist', () => {
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

    it('should return null if channel has no messageMap', () => {
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
    it('should return assistant message ID directly when clicking on bot message', () => {
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
                type: 'assistant' as const,
              },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const messageId = findForkPointMessageId('C123', '1234.002');
      expect(messageId).toBe('msg_017pagAKz');
    });

    it('should find LAST assistant message BEFORE user message (not response to it)', () => {
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
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'user_002', type: 'user' as const },  // User clicks HERE
              '1234.004': { sdkMessageId: 'msg_002', type: 'assistant' as const },  // Response AFTER
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Should return msg_001 (before .003), NOT msg_002 (after .003)
      const messageId = findForkPointMessageId('C123', '1234.003');
      expect(messageId).toBe('msg_001');
    });

    it('should return null if no assistant message before the timestamp', () => {
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
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const messageId = findForkPointMessageId('C123', '1234.001');
      expect(messageId).toBeNull();
    });

    it('should work with split messages (continuation)', () => {
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
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'msg_001', type: 'assistant' as const, isContinuation: true },
              '1234.004': { sdkMessageId: 'msg_001', type: 'assistant' as const, isContinuation: true },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // All should return the same SDK message ID
      expect(findForkPointMessageId('C123', '1234.002')).toBe('msg_001');
      expect(findForkPointMessageId('C123', '1234.003')).toBe('msg_001');
      expect(findForkPointMessageId('C123', '1234.004')).toBe('msg_001');
    });

    it('should return null if channel has no messageMap', () => {
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
  });

  describe('messageMap preservation', () => {
    it('should preserve messageMap when saveSession is called', () => {
      // Setup: Start with empty store
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Step 1: Create initial session
      saveSession('C123', {
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
      saveMessageMapping('C123', '1234.001', {
        sdkMessageId: 'msg_001',
        type: 'assistant',
      });

      // Update current store from the write
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Verify mapping was saved
      expect(currentStore.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_001');

      // Step 3: Save session again (simulating what happens after SDK returns new session ID)
      saveSession('C123', { sessionId: 'sess-2' });

      // Get final written data
      const finalStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[2][1] as string);

      // CRITICAL: Verify messageMap was preserved after saveSession
      expect(finalStore.channels['C123'].messageMap).toBeDefined();
      expect(finalStore.channels['C123'].messageMap['1234.001'].sdkMessageId).toBe('msg_001');
      expect(finalStore.channels['C123'].sessionId).toBe('sess-2');
    });

    it('should preserve messageMap when saving multiple mappings interleaved with saveSession', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Create session
      saveSession('C123', {
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
      saveMessageMapping('C123', '1234.001', { sdkMessageId: 'user_001', type: 'user' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[1][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save assistant message mapping
      saveMessageMapping('C123', '1234.002', { sdkMessageId: 'msg_001', type: 'assistant' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[2][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save session (this was wiping messageMap before the fix)
      saveSession('C123', { sessionId: 'sess-1' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[3][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Add another user message
      saveMessageMapping('C123', '1234.003', { sdkMessageId: 'user_002', type: 'user' });
      currentStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[4][1] as string);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(currentStore));

      // Save session again
      saveSession('C123', { sessionId: 'sess-1' });
      const finalStore = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[5][1] as string);

      // All mappings should be preserved
      expect(Object.keys(finalStore.channels['C123'].messageMap)).toHaveLength(3);
      expect(finalStore.channels['C123'].messageMap['1234.001'].type).toBe('user');
      expect(finalStore.channels['C123'].messageMap['1234.002'].type).toBe('assistant');
      expect(finalStore.channels['C123'].messageMap['1234.003'].type).toBe('user');
    });
  });

  describe('getOrCreateThreadSession with resumeSessionAtMessageId', () => {
    it('should create thread session with resumeSessionAtMessageId', () => {
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

      const result = getOrCreateThreadSession('C123', '1234.002', 'msg_017pagAKz');

      expect(result.isNewFork).toBe(true);
      expect(result.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
      expect(result.session.forkedFrom).toBe('main-session-123');
    });

    it('should handle thread creation without message mapping', () => {
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
      const result = getOrCreateThreadSession('C123', '1234.999', null);

      expect(result.isNewFork).toBe(true);
      expect(result.session.resumeSessionAtMessageId).toBeUndefined();
      expect(result.session.forkedFrom).toBe('main-session-123');
    });

    it('should return existing thread session with stored resumeSessionAtMessageId', () => {
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

      const result = getOrCreateThreadSession('C123', '1234.002');

      expect(result.isNewFork).toBe(false);
      expect(result.session.sessionId).toBe('thread-session-456');
      expect(result.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
    });
  });

  // ============================================================================
  // Activity Log Storage Tests
  // ============================================================================

  describe('saveActivityLog', () => {
    it('should save activity log for channel conversation', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
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

      const entries = [
        { timestamp: Date.now(), type: 'tool_start' as const, tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete' as const, tool: 'Read', durationMs: 500 },
      ];

      await saveActivityLog('C123', entries);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(writtenData.channels.C123.activityLogs).toBeDefined();
      expect(writtenData.channels.C123.activityLogs['C123']).toEqual(entries);
    });

    it('should save activity log for thread conversation', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
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

      const entries = [
        { timestamp: Date.now(), type: 'thinking' as const, thinkingContent: 'test' },
      ];
      const conversationKey = 'C123_thread456';

      await saveActivityLog(conversationKey, entries);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(writtenData.channels.C123.activityLogs[conversationKey]).toEqual(entries);
    });

    it('should not save if channel does not exist', async () => {
      const mockStore = { channels: {} };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await saveActivityLog('C999', []);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot save activity log')
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should preserve existing activity logs when adding new ones', async () => {
      const existingEntries = [
        { timestamp: Date.now() - 1000, type: 'tool_start' as const, tool: 'Glob' },
      ];
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            activityLogs: {
              'C123': existingEntries,
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const newEntries = [
        { timestamp: Date.now(), type: 'tool_start' as const, tool: 'Read' },
      ];

      await saveActivityLog('C123_newthread', newEntries);

      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      // Old entry should still exist
      expect(writtenData.channels.C123.activityLogs['C123']).toEqual(existingEntries);
      // New entry should be added
      expect(writtenData.channels.C123.activityLogs['C123_newthread']).toEqual(newEntries);
    });
  });

  describe('getActivityLog', () => {
    it('should return activity log for channel conversation', async () => {
      const entries = [
        { timestamp: Date.now(), type: 'tool_start' as const, tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete' as const, tool: 'Read', durationMs: 500 },
      ];
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            activityLogs: {
              'C123': entries,
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getActivityLog('C123');

      expect(result).toEqual(entries);
    });

    it('should return activity log for thread conversation', async () => {
      const entries = [
        { timestamp: Date.now(), type: 'thinking' as const, thinkingContent: 'analysis' },
      ];
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            activityLogs: {
              'C123_thread789': entries,
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getActivityLog('C123_thread789');

      expect(result).toEqual(entries);
    });

    it('should return null if channel does not exist', async () => {
      const mockStore = { channels: {} };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getActivityLog('C999');

      expect(result).toBeNull();
    });

    it('should return null if activityLogs not initialized', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            // No activityLogs property
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getActivityLog('C123');

      expect(result).toBeNull();
    });

    it('should return null if specific conversation key not found', async () => {
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'session-123',
            workingDir: '/test',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/test',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            activityLogs: {
              'C123_other': [],
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      const result = await getActivityLog('C123_missing');

      expect(result).toBeNull();
    });
  });
});
