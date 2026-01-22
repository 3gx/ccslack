import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveSession,
  saveMessageMapping,
  getOrCreateThreadSession,
  findForkPointMessageId,
} from '../../session-manager.js';
import type { Session } from '../../session-manager.js';

// Mock the fs module
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

import fs from 'fs';

describe('point-in-time thread forking integration', () => {
  const mockSession = {
    sessionId: 'main-session-123',
    workingDir: '/Users/testuser/projects/myapp',
    mode: 'plan' as const,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/Users/testuser/projects/myapp',
    configuredBy: 'U123',
    configuredAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('full workflow: message mapping to thread fork', () => {
    it('should create thread session that forks from specific message', async () => {
      // Setup: Channel with conversation history
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_017pagAKz', sessionId: 'main-session-123', type: 'assistant' as const, parentSlackTs: '1234.001' },
              '1234.003': { sdkMessageId: 'user_002', sessionId: 'main-session-123', type: 'user' as const },
              '1234.004': { sdkMessageId: 'msg_bdrk_01Tp3g', sessionId: 'main-session-123', type: 'assistant' as const, parentSlackTs: '1234.003' },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Step 1: Find fork point for message B (ts: 1234.002)
      const forkPoint = findForkPointMessageId('C123', '1234.002');
      expect(forkPoint).toEqual({ messageId: 'msg_017pagAKz', sessionId: 'main-session-123' });

      // Step 2: Create thread session at message B
      const threadResult = await getOrCreateThreadSession('C123', '1234.002', forkPoint);

      expect(threadResult.isNewFork).toBe(true);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
      expect(threadResult.session.forkedFrom).toBe('main-session-123');
    });

    it('should handle user replying to their own user message', async () => {
      // Scenario: User replies to their user message, not a bot message
      // Should fork from the LAST assistant message BEFORE that user message
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'user_002', sessionId: 'main-session-123', type: 'user' as const },  // User replies HERE
              '1234.004': { sdkMessageId: 'msg_002', sessionId: 'main-session-123', type: 'assistant' as const },  // Future context
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Find fork point for user message at 1234.003
      const forkPoint = findForkPointMessageId('C123', '1234.003');

      // Should get msg_001 (last assistant BEFORE 1234.003), NOT msg_002 (after)
      expect(forkPoint).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });

      // Create thread
      const threadResult = await getOrCreateThreadSession('C123', '1234.003', forkPoint);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_001');
    });

    it('should handle split messages (long responses)', async () => {
      // Scenario: Bot response split into 3 Slack messages
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const, isContinuation: true },
              '1234.004': { sdkMessageId: 'msg_001', sessionId: 'main-session-123', type: 'assistant' as const, isContinuation: true },
              '1234.005': { sdkMessageId: 'user_002', sessionId: 'main-session-123', type: 'user' as const },
              '1234.006': { sdkMessageId: 'msg_002', sessionId: 'main-session-123', type: 'assistant' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // User clicks on any part of the split message - should all return same ID and sessionId
      expect(findForkPointMessageId('C123', '1234.002')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
      expect(findForkPointMessageId('C123', '1234.003')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
      expect(findForkPointMessageId('C123', '1234.004')).toEqual({ messageId: 'msg_001', sessionId: 'main-session-123' });
    });

    it('should gracefully handle old channels without message mappings', async () => {
      // Scenario: Old channel that existed before point-in-time forking was implemented
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            // No messageMap - old channel
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Should return null (graceful degradation)
      const forkPoint = findForkPointMessageId('C123', '1234.002');
      expect(forkPoint).toBeNull();

      // Thread should still be created, but without resumeSessionAtMessageId
      const threadResult = await getOrCreateThreadSession('C123', '1234.002', null);
      expect(threadResult.isNewFork).toBe(true);
      expect(threadResult.session.resumeSessionAtMessageId).toBeUndefined();
    });

    it('should handle forking from first message (no prior assistant messages)', async () => {
      // Scenario: User's very first message in channel
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'main-session-123', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // No assistant message exists before user message
      const forkPoint = findForkPointMessageId('C123', '1234.001');
      expect(forkPoint).toBeNull();
    });
  });

  describe('session storage and persistence', () => {
    it('should persist resumeSessionAtMessageId in thread session', async () => {
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Create thread with fork point (now uses ForkPointResult format)
      const forkPoint = { messageId: 'msg_017pagAKz', sessionId: 'main-session-123' };
      await getOrCreateThreadSession('C123', '1234.002', forkPoint);

      // Verify it was written to disk
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.channels['C123'].threads['1234.002'].resumeSessionAtMessageId).toBe('msg_017pagAKz');
      expect(writtenData.channels['C123'].threads['1234.002'].forkedFrom).toBe('main-session-123');
    });

    it('should preserve resumeSessionAtMessageId when returning existing thread', async () => {
      // Thread already exists with resumeSessionAtMessageId
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            threads: {
              '1234.002': {
                sessionId: 'thread-session-456',
                forkedFrom: 'main-session-123',
                workingDir: '/Users/testuser/projects/myapp',
                mode: 'plan' as const,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                pathConfigured: true,
                configuredPath: '/Users/testuser/projects/myapp',
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

      // Get existing thread
      const threadResult = await getOrCreateThreadSession('C123', '1234.002');

      expect(threadResult.isNewFork).toBe(false);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
    });
  });

  describe('fork after /clear - time travel scenario', () => {
    it('should fork from OLD session when replying to message from before /clear', async () => {
      // This is the critical bug fix test:
      // 1. User has session S1 with messages
      // 2. User runs /clear - main session becomes null, S1 tracked in previousSessionIds
      // 3. User replies to a message from BEFORE /clear
      // 4. Thread should fork from S1 (not null!)

      const mockStore = {
        channels: {
          'C123': {
            sessionId: null,  // CLEARED - main session is null
            previousSessionIds: ['old-session-S1'],  // Old session tracked
            workingDir: '/Users/testuser/projects/myapp',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/Users/testuser/projects/myapp',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            // messageMap preserved from BEFORE /clear
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'old-session-S1', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_from_S1', sessionId: 'old-session-S1', type: 'assistant' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Find fork point for message from BEFORE /clear
      const forkPoint = findForkPointMessageId('C123', '1234.002');

      // CRITICAL: Should return OLD session ID from the message, not null
      expect(forkPoint).toEqual({
        messageId: 'msg_from_S1',
        sessionId: 'old-session-S1',  // From messageMap, NOT from current main session
      });

      // Create thread using the fork point
      const threadResult = await getOrCreateThreadSession('C123', '1234.002', forkPoint);

      expect(threadResult.isNewFork).toBe(true);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_from_S1');
      // CRITICAL: forkedFrom should be OLD session, not null
      expect(threadResult.session.forkedFrom).toBe('old-session-S1');
    });

    it('should still work for messages after /clear (uses current session)', async () => {
      // After /clear, new messages get new session S2
      const mockStore = {
        channels: {
          'C123': {
            sessionId: 'new-session-S2',  // New session after /clear
            previousSessionIds: ['old-session-S1'],
            workingDir: '/Users/testuser/projects/myapp',
            mode: 'plan' as const,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            pathConfigured: true,
            configuredPath: '/Users/testuser/projects/myapp',
            configuredBy: 'U123',
            configuredAt: Date.now(),
            messageMap: {
              // Old messages from S1
              '1234.001': { sdkMessageId: 'user_001', sessionId: 'old-session-S1', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_from_S1', sessionId: 'old-session-S1', type: 'assistant' as const },
              // New messages from S2 (after /clear)
              '1234.003': { sdkMessageId: 'user_002', sessionId: 'new-session-S2', type: 'user' as const },
              '1234.004': { sdkMessageId: 'msg_from_S2', sessionId: 'new-session-S2', type: 'assistant' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Fork from OLD message (should use S1)
      const forkPointOld = findForkPointMessageId('C123', '1234.002');
      expect(forkPointOld?.sessionId).toBe('old-session-S1');

      // Fork from NEW message (should use S2)
      const forkPointNew = findForkPointMessageId('C123', '1234.004');
      expect(forkPointNew?.sessionId).toBe('new-session-S2');
    });
  });
});
