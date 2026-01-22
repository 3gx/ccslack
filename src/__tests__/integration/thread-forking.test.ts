import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  loadSessions,
  saveSessions,
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  getOrCreateThreadSession,
  type Session,
  type ThreadSession,
} from '../../session-manager.js';

// Mock fs
vi.mock('fs');

describe('thread forking', () => {
  const mockCwd = '/Users/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getThreadSession', () => {
    it('should return null if channel does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getThreadSession('C123', '1234567890.123456');

      expect(result).toBeNull();
    });

    it('should return null if channel has no threads', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = getThreadSession('C123', '1234567890.123456');

      expect(result).toBeNull();
    });

    it('should return null if thread does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            threads: {
              '9999999999.999999': {
                sessionId: 'other-thread',
                forkedFrom: 'main-session',
                workingDir: mockCwd,
                mode: 'plan',
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      const result = getThreadSession('C123', '1234567890.123456');

      expect(result).toBeNull();
    });

    it('should return thread session if it exists', async () => {
      const threadTs = '1234567890.123456';
      const threadSession: ThreadSession = {
        sessionId: 'thread-session-123',
        forkedFrom: 'main-session',
        workingDir: '/Users/test/project',
        mode: 'bypassPermissions',
        createdAt: 1000000,
        lastActiveAt: 2000000,
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            threads: {
              [threadTs]: threadSession
            }
          }
        }
      }));

      const result = getThreadSession('C123', threadTs);

      expect(result).toEqual(threadSession);
    });
  });

  describe('saveThreadSession', () => {
    it('should create channel if it does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {}
      }));

      const threadTs = '1234567890.123456';
      await saveThreadSession('C123', threadTs, {
        sessionId: 'new-thread',
        forkedFrom: null,
        workingDir: mockCwd,
        mode: 'plan',
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        './sessions.json',
        expect.stringContaining('C123')
      );

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123).toBeDefined();
      expect(savedData.channels.C123.threads).toBeDefined();
      expect(savedData.channels.C123.threads[threadTs]).toBeDefined();
    });

    it('should create threads object if channel exists but has no threads', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const threadTs = '1234567890.123456';
      await saveThreadSession('C123', threadTs, {
        sessionId: 'new-thread',
        forkedFrom: 'main-session',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.threads).toBeDefined();
      expect(savedData.channels.C123.threads[threadTs].sessionId).toBe('new-thread');
    });

    it('should preserve existing thread when adding new thread', async () => {
      const existingThreadTs = '1111111111.111111';
      const newThreadTs = '2222222222.222222';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            threads: {
              [existingThreadTs]: {
                sessionId: 'existing-thread',
                forkedFrom: 'main-session',
                workingDir: mockCwd,
                mode: 'plan',
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      await saveThreadSession('C123', newThreadTs, {
        sessionId: 'new-thread',
        forkedFrom: 'main-session',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.threads[existingThreadTs].sessionId).toBe('existing-thread');
      expect(savedData.channels.C123.threads[newThreadTs].sessionId).toBe('new-thread');
    });

    it('should update existing thread session', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 1000,
            lastActiveAt: 2000,
            threads: {
              [threadTs]: {
                sessionId: null,
                forkedFrom: 'main-session',
                workingDir: mockCwd,
                mode: 'plan',
                createdAt: 3000,
                lastActiveAt: 4000,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      await saveThreadSession('C123', threadTs, {
        sessionId: 'forked-session-123',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.threads[threadTs].sessionId).toBe('forked-session-123');
      expect(savedData.channels.C123.threads[threadTs].forkedFrom).toBe('main-session');
      expect(savedData.channels.C123.threads[threadTs].createdAt).toBe(3000);
    });

    it('should inherit workingDir from main session when creating new channel', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {}
      }));

      const threadTs = '1234567890.123456';
      await saveThreadSession('C123', threadTs, {
        sessionId: 'new-thread',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.workingDir).toBe(mockCwd);
      expect(savedData.channels.C123.threads[threadTs].workingDir).toBe(mockCwd);
    });

    it('should update lastActiveAt on save', async () => {
      const threadTs = '1234567890.123456';
      const now = Date.now();

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 1000,
            lastActiveAt: 1000,
            threads: {
              [threadTs]: {
                sessionId: 'thread-session',
                forkedFrom: 'main-session',
                workingDir: mockCwd,
                mode: 'plan',
                createdAt: 2000,
                lastActiveAt: 2000,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      await saveThreadSession('C123', threadTs, {
        mode: 'bypassPermissions',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.threads[threadTs].lastActiveAt).toBeGreaterThanOrEqual(now);
    });
  });

  describe('getOrCreateThreadSession', () => {
    it('should return existing thread session with isNewFork=false', async () => {
      const threadTs = '1234567890.123456';
      const existingSession: ThreadSession = {
        sessionId: 'existing-thread-session',
        forkedFrom: 'main-session',
        workingDir: '/Users/test/project',
        mode: 'bypassPermissions',
        createdAt: 1000,
        lastActiveAt: 2000,
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [threadTs]: existingSession
            }
          }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.session).toEqual(existingSession);
      expect(result.isNewFork).toBe(false);
    });

    it('should create new thread session with isNewFork=true when thread does not exist', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session-id',
            workingDir: '/Users/test/custom',
            mode: 'bypassPermissions',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.isNewFork).toBe(true);
      expect(result.session.sessionId).toBeNull();
      expect(result.session.forkedFrom).toBe('main-session-id');
      expect(result.session.workingDir).toBe('/Users/test/custom');
      expect(result.session.mode).toBe('bypassPermissions');
    });

    it('should inherit workingDir from main session', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: '/custom/path',
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.session.workingDir).toBe('/custom/path');
    });

    it('should inherit mode from main session', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'default',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.session.mode).toBe('default');
    });

    it('should use defaults when no main session exists', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {}
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.isNewFork).toBe(true);
      expect(result.session.sessionId).toBeNull();
      expect(result.session.forkedFrom).toBeNull();
      expect(result.session.workingDir).toBe(mockCwd);
      expect(result.session.mode).toBe('default');
    });

    it('should save new thread session to disk', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      await getOrCreateThreadSession('C123', threadTs);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );
      expect(savedData.channels.C123.threads[threadTs]).toBeDefined();
    });

    it('should set createdAt and lastActiveAt on new thread', async () => {
      const threadTs = '1234567890.123456';
      const beforeTime = Date.now();

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);
      const afterTime = Date.now();

      expect(result.session.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.session.createdAt).toBeLessThanOrEqual(afterTime);
      expect(result.session.lastActiveAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.session.lastActiveAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('thread session independence', () => {
    it('should maintain separate sessions for different threads', async () => {
      const thread1Ts = '1111111111.111111';
      const thread2Ts = '2222222222.222222';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [thread1Ts]: {
                sessionId: 'thread1-session',
                forkedFrom: 'main-session',
                workingDir: mockCwd,
                mode: 'plan',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  },
              [thread2Ts]: {
                sessionId: 'thread2-session',
                forkedFrom: 'main-session',
                workingDir: '/different/path',
                mode: 'bypassPermissions',
                createdAt: 2000,
                lastActiveAt: 2100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      const thread1 = getThreadSession('C123', thread1Ts);
      const thread2 = getThreadSession('C123', thread2Ts);

      expect(thread1?.sessionId).toBe('thread1-session');
      expect(thread2?.sessionId).toBe('thread2-session');
      expect(thread1?.mode).toBe('plan');
      expect(thread2?.mode).toBe('bypassPermissions');
      expect(thread1?.workingDir).toBe(mockCwd);
      expect(thread2?.workingDir).toBe('/different/path');
    });

    it('should not affect main session when modifying thread session', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: '/main/path',
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [threadTs]: {
                sessionId: 'thread-session',
                forkedFrom: 'main-session',
                workingDir: '/main/path',
                mode: 'plan',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      // Update thread session
      await saveThreadSession('C123', threadTs, {
        workingDir: '/new/thread/path',
        mode: 'bypassPermissions',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );

      // Main session should be unchanged
      expect(savedData.channels.C123.workingDir).toBe('/main/path');
      expect(savedData.channels.C123.mode).toBe('plan');

      // Thread session should be updated
      expect(savedData.channels.C123.threads[threadTs].workingDir).toBe('/new/thread/path');
      expect(savedData.channels.C123.threads[threadTs].mode).toBe('bypassPermissions');
    });

    it('should not affect thread sessions when modifying main session', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: '/main/path',
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [threadTs]: {
                sessionId: 'thread-session',
                forkedFrom: 'main-session',
                workingDir: '/thread/path',
                mode: 'bypassPermissions',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      // Update main session
      await saveSession('C123', {
        workingDir: '/updated/main/path',
        mode: 'default',
      });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );

      // Main session should be updated
      expect(savedData.channels.C123.workingDir).toBe('/updated/main/path');
      expect(savedData.channels.C123.mode).toBe('default');

      // Thread session should be unchanged
      expect(savedData.channels.C123.threads[threadTs].workingDir).toBe('/thread/path');
      expect(savedData.channels.C123.threads[threadTs].mode).toBe('bypassPermissions');
    });
  });

  describe('forkedFrom tracking', () => {
    it('should track parent session ID when forking', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'parent-session-abc123',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.session.forkedFrom).toBe('parent-session-abc123');
    });

    it('should set forkedFrom to null when no parent session exists', async () => {
      const threadTs = '1234567890.123456';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: null, // Main session has no SDK session yet
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
                pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
              }
        }
      }));

      const result = await getOrCreateThreadSession('C123', threadTs);

      expect(result.session.forkedFrom).toBeNull();
    });
  });

  describe('thread-to-thread forking', () => {
    it('should save thread session with forkedFromThreadTs', async () => {
      const sourceThreadTs = '1111111111.111111';
      const newThreadTs = '2222222222.222222';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [sourceThreadTs]: {
                sessionId: 'source-thread-session',
                forkedFrom: 'main-session',
                workingDir: '/source/path',
                mode: 'bypassPermissions',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      // Create new thread session forked from source thread
      await saveThreadSession('C123', newThreadTs, {
        sessionId: null,
        forkedFrom: 'source-thread-session',
        forkedFromThreadTs: sourceThreadTs,
        workingDir: '/source/path',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );

      // Verify new thread has forkedFromThreadTs set
      const newThread = savedData.channels.C123.threads[newThreadTs];
      expect(newThread.forkedFrom).toBe('source-thread-session');
      expect(newThread.forkedFromThreadTs).toBe(sourceThreadTs);
      expect(newThread.workingDir).toBe('/source/path');
      expect(newThread.mode).toBe('bypassPermissions');
    });

    it('should preserve source thread session when forking to new thread', async () => {
      const sourceThreadTs = '1111111111.111111';
      const newThreadTs = '2222222222.222222';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [sourceThreadTs]: {
                sessionId: 'source-thread-session',
                forkedFrom: 'main-session',
                workingDir: '/source/path',
                mode: 'bypassPermissions',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      // Create new thread session forked from source thread
      await saveThreadSession('C123', newThreadTs, {
        sessionId: null,
        forkedFrom: 'source-thread-session',
        forkedFromThreadTs: sourceThreadTs,
        workingDir: '/source/path',
        mode: 'bypassPermissions',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );

      // Source thread should be unchanged
      const sourceThread = savedData.channels.C123.threads[sourceThreadTs];
      expect(sourceThread.sessionId).toBe('source-thread-session');
      expect(sourceThread.forkedFrom).toBe('main-session');
      expect(sourceThread.forkedFromThreadTs).toBeUndefined();
    });

    it('should allow chain forking (main -> T1 -> T2)', async () => {
      const thread1Ts = '1111111111.111111';
      const thread2Ts = '2222222222.222222';

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        channels: {
          C123: {
            sessionId: 'main-session',
            workingDir: mockCwd,
            mode: 'plan',
            createdAt: 500,
            lastActiveAt: 600,
            threads: {
              [thread1Ts]: {
                sessionId: 'thread1-session',
                forkedFrom: 'main-session',
                workingDir: '/path',
                mode: 'plan',
                createdAt: 1000,
                lastActiveAt: 1100,
                    pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
                  }
            }
          }
        }
      }));

      // Fork T1 to T2
      await saveThreadSession('C123', thread2Ts, {
        sessionId: null,
        forkedFrom: 'thread1-session',  // Forked from T1's session
        forkedFromThreadTs: thread1Ts,  // Visual reference to T1
        workingDir: '/path',
        mode: 'plan',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
            pathConfigured: true,
      configuredPath: '/test/dir',
      configuredBy: 'U123',
      configuredAt: Date.now(),
          });

      const savedData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
      );

      // Chain: main-session -> thread1-session -> T2 (will get its own session later)
      expect(savedData.channels.C123.sessionId).toBe('main-session');
      expect(savedData.channels.C123.threads[thread1Ts].forkedFrom).toBe('main-session');
      expect(savedData.channels.C123.threads[thread2Ts].forkedFrom).toBe('thread1-session');
      expect(savedData.channels.C123.threads[thread2Ts].forkedFromThreadTs).toBe(thread1Ts);
    });
  });
});
