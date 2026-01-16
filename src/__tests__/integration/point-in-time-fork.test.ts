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
    it('should create thread session that forks from specific message', () => {
      // Setup: Channel with conversation history
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_017pagAKz', type: 'assistant' as const, parentSlackTs: '1234.001' },
              '1234.003': { sdkMessageId: 'user_002', type: 'user' as const },
              '1234.004': { sdkMessageId: 'msg_bdrk_01Tp3g', type: 'assistant' as const, parentSlackTs: '1234.003' },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Step 1: Find fork point for message B (ts: 1234.002)
      const forkPointMessageId = findForkPointMessageId('C123', '1234.002');
      expect(forkPointMessageId).toBe('msg_017pagAKz');

      // Step 2: Create thread session at message B
      const threadResult = getOrCreateThreadSession('C123', '1234.002', forkPointMessageId);

      expect(threadResult.isNewFork).toBe(true);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
      expect(threadResult.session.forkedFrom).toBe('main-session-123');
    });

    it('should handle user replying to their own user message', () => {
      // Scenario: User replies to their user message, not a bot message
      // Should fork from the LAST assistant message BEFORE that user message
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'user_002', type: 'user' as const },  // User replies HERE
              '1234.004': { sdkMessageId: 'msg_002', type: 'assistant' as const },  // Future context
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Find fork point for user message at 1234.003
      const forkPointMessageId = findForkPointMessageId('C123', '1234.003');

      // Should get msg_001 (last assistant BEFORE 1234.003), NOT msg_002 (after)
      expect(forkPointMessageId).toBe('msg_001');

      // Create thread
      const threadResult = getOrCreateThreadSession('C123', '1234.003', forkPointMessageId);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_001');
    });

    it('should handle split messages (long responses)', () => {
      // Scenario: Bot response split into 3 Slack messages
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
              '1234.002': { sdkMessageId: 'msg_001', type: 'assistant' as const },
              '1234.003': { sdkMessageId: 'msg_001', type: 'assistant' as const, isContinuation: true },
              '1234.004': { sdkMessageId: 'msg_001', type: 'assistant' as const, isContinuation: true },
              '1234.005': { sdkMessageId: 'user_002', type: 'user' as const },
              '1234.006': { sdkMessageId: 'msg_002', type: 'assistant' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // User clicks on any part of the split message - should all return same ID
      expect(findForkPointMessageId('C123', '1234.002')).toBe('msg_001');
      expect(findForkPointMessageId('C123', '1234.003')).toBe('msg_001');
      expect(findForkPointMessageId('C123', '1234.004')).toBe('msg_001');
    });

    it('should gracefully handle old channels without message mappings', () => {
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
      const forkPointMessageId = findForkPointMessageId('C123', '1234.002');
      expect(forkPointMessageId).toBeNull();

      // Thread should still be created, but without resumeSessionAtMessageId
      const threadResult = getOrCreateThreadSession('C123', '1234.002', null);
      expect(threadResult.isNewFork).toBe(true);
      expect(threadResult.session.resumeSessionAtMessageId).toBeUndefined();
    });

    it('should handle forking from first message (no prior assistant messages)', () => {
      // Scenario: User's very first message in channel
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
            messageMap: {
              '1234.001': { sdkMessageId: 'user_001', type: 'user' as const },
            },
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // No assistant message exists before user message
      const forkPointMessageId = findForkPointMessageId('C123', '1234.001');
      expect(forkPointMessageId).toBeNull();
    });
  });

  describe('session storage and persistence', () => {
    it('should persist resumeSessionAtMessageId in thread session', () => {
      const mockStore = {
        channels: {
          'C123': {
            ...mockSession,
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore));

      // Create thread with fork point
      getOrCreateThreadSession('C123', '1234.002', 'msg_017pagAKz');

      // Verify it was written to disk
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.channels['C123'].threads['1234.002'].resumeSessionAtMessageId).toBe('msg_017pagAKz');
    });

    it('should preserve resumeSessionAtMessageId when returning existing thread', () => {
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
      const threadResult = getOrCreateThreadSession('C123', '1234.002');

      expect(threadResult.isNewFork).toBe(false);
      expect(threadResult.session.resumeSessionAtMessageId).toBe('msg_017pagAKz');
    });
  });
});
