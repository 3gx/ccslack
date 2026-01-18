import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SlackBotError,
  ErrorCode,
  toUserMessage,
  isRecoverable,
  Errors,
} from '../../errors.js';
import { withRetry, withSlackRetry, sleep } from '../../retry.js';
import { loadSessions } from '../../session-manager.js';
import fs from 'fs';

// Mock fs for session tests
vi.mock('fs');

describe('graceful failures - no crashes on invalid input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('error handling', () => {
    it('should handle missing session file gracefully', () => {
      const error = Errors.sessionFileMissing('abc-123');

      expect(error).toBeInstanceOf(SlackBotError);
      expect(error.code).toBe(ErrorCode.SESSION_FILE_MISSING);
      expect(toUserMessage(error)).toContain('Session not found');
      expect(toUserMessage(error)).toContain('new session');
    });

    it('should handle invalid working directory gracefully', () => {
      const error = Errors.workingDirNotFound('/nonexistent/path');

      expect(error).toBeInstanceOf(SlackBotError);
      expect(error.code).toBe(ErrorCode.WORKING_DIR_NOT_FOUND);
      expect(toUserMessage(error)).toContain('not found');
      expect(toUserMessage(error)).toContain('cwd');
    });

    it('should handle SDK errors gracefully', () => {
      const error = Errors.claudeSdkError('Connection refused');

      expect(error).toBeInstanceOf(SlackBotError);
      expect(error.code).toBe(ErrorCode.CLAUDE_SDK_ERROR);
      expect(toUserMessage(error)).toContain('Claude encountered an error');
      expect(toUserMessage(error)).toContain('Connection refused');
    });

    it('should handle malformed/null error gracefully', () => {
      expect(toUserMessage(null)).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage(undefined)).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage('')).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage({})).toBe('An unexpected error occurred. Please try again.');
    });

    it('should handle empty message gracefully', () => {
      const error = Errors.emptyMessage();

      expect(error).toBeInstanceOf(SlackBotError);
      expect(error.code).toBe(ErrorCode.EMPTY_MESSAGE);
      expect(toUserMessage(error)).toContain('Please provide a message');
    });

    it('should handle corrupted sessions.json gracefully', () => {
      // Mock fs to return invalid JSON
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

      // loadSessions should not throw, should return empty store
      const result = loadSessions();
      expect(result).toEqual({ channels: {} });
    });

    it('should handle Slack rate limit errors gracefully', () => {
      const slackError = {
        data: { error: 'ratelimited', response_metadata: { retry_after: 30 } },
      };

      expect(isRecoverable(slackError)).toBe(true);
      expect(toUserMessage(slackError)).toContain('Rate limited');
    });

    it('should handle generic Error objects gracefully', () => {
      const error = new Error('Something went wrong');

      // Should NOT expose internal error message to user
      expect(toUserMessage(error)).toBe('An unexpected error occurred. Please try again.');
    });

    it('should handle git conflict warning gracefully', () => {
      const error = Errors.gitConflict();

      expect(error.code).toBe(ErrorCode.GIT_CONFLICT);
      expect(toUserMessage(error)).toContain('Git conflicts detected');
      expect(toUserMessage(error)).toContain('Proceeding anyway');
    });

    it('should handle session file corrupted error gracefully', () => {
      const error = Errors.sessionFileCorrupted();

      expect(error.code).toBe(ErrorCode.SESSION_FILE_CORRUPTED);
      expect(toUserMessage(error)).toContain('corrupted');
      expect(toUserMessage(error)).toContain('new session');
    });
  });

  describe('recoverability detection', () => {
    it('should mark SlackBotError as recoverable when specified', () => {
      const recoverable = Errors.slackRateLimited(30);
      const notRecoverable = Errors.sessionNotFound('abc');

      expect(isRecoverable(recoverable)).toBe(true);
      expect(isRecoverable(notRecoverable)).toBe(false);
    });

    it('should mark network errors as recoverable', () => {
      const econnreset = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      const etimedout = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const econnrefused = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });

      expect(isRecoverable(econnreset)).toBe(true);
      expect(isRecoverable(etimedout)).toBe(true);
      expect(isRecoverable(econnrefused)).toBe(true);
    });

    it('should mark random errors as not recoverable', () => {
      expect(isRecoverable(new Error('Random error'))).toBe(false);
      expect(isRecoverable({ random: 'object' })).toBe(false);
      expect(isRecoverable('string error')).toBe(false);
    });
  });

  describe('retry logic', () => {
    it('should retry on recoverable errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const result = await withRetry(fn, { baseDelayMs: 10, maxDelayMs: 50 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-recoverable errors', async () => {
      const fn = vi.fn(async () => {
        throw Errors.sessionNotFound('abc');
      });

      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should respect maxAttempts limit', async () => {
      const fn = vi.fn(async () => {
        throw Errors.slackRateLimited();
      });

      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 })
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should call onRetry callback', async () => {
      let attempts = 0;
      const onRetry = vi.fn();
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      await withRetry(fn, { baseDelayMs: 10, onRetry });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.any(SlackBotError),
        1,
        expect.any(Number)
      );
    });
  });

  describe('sleep utility', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
      expect(elapsed).toBeLessThan(150);
    });
  });
});
