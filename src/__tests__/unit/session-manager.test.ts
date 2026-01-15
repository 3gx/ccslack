import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSession, saveSession, loadSessions, saveSessions } from '../../session-manager.js';

// Mock the fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

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
        mode: 'auto' as const,
        createdAt: 1000,
        lastActiveAt: 2000,
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
      expect(writtenData.channels['C123'].mode).toBe('plan');
      expect(writtenData.channels['C123'].lastActiveAt).toBeDefined();
    });

    it('should merge with existing session', () => {
      const existingSession = {
        sessionId: 'old-sess',
        workingDir: '/old/path',
        mode: 'plan' as const,
        createdAt: 1000,
        lastActiveAt: 1500,
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
});
