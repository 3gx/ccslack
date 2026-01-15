import { describe, it, expect } from 'vitest';
import {
  SlackBotError,
  ErrorCode,
  toUserMessage,
  isRecoverable,
  getRetryAfter,
  Errors,
} from '../../errors.js';

describe('errors module', () => {
  describe('SlackBotError', () => {
    it('should create error with code and message', () => {
      const error = new SlackBotError('test message', ErrorCode.SESSION_NOT_FOUND);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SlackBotError);
      expect(error.name).toBe('SlackBotError');
      expect(error.message).toBe('test message');
      expect(error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    });

    it('should default recoverable to false', () => {
      const error = new SlackBotError('test', ErrorCode.SESSION_NOT_FOUND);
      expect(error.recoverable).toBe(false);
    });

    it('should accept recoverable parameter', () => {
      const recoverableError = new SlackBotError('test', ErrorCode.SLACK_RATE_LIMITED, true);
      const nonRecoverableError = new SlackBotError('test', ErrorCode.SESSION_NOT_FOUND, false);

      expect(recoverableError.recoverable).toBe(true);
      expect(nonRecoverableError.recoverable).toBe(false);
    });

    it('should have all expected error codes', () => {
      // Slack errors
      expect(ErrorCode.SLACK_RATE_LIMITED).toBe('SLACK_RATE_LIMITED');
      expect(ErrorCode.SLACK_CHANNEL_NOT_FOUND).toBe('SLACK_CHANNEL_NOT_FOUND');
      expect(ErrorCode.SLACK_MESSAGE_TOO_LONG).toBe('SLACK_MESSAGE_TOO_LONG');
      expect(ErrorCode.SLACK_API_ERROR).toBe('SLACK_API_ERROR');

      // Claude errors
      expect(ErrorCode.CLAUDE_SDK_ERROR).toBe('CLAUDE_SDK_ERROR');
      expect(ErrorCode.CLAUDE_TIMEOUT).toBe('CLAUDE_TIMEOUT');

      // Session errors
      expect(ErrorCode.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
      expect(ErrorCode.SESSION_FILE_MISSING).toBe('SESSION_FILE_MISSING');
      expect(ErrorCode.SESSION_FILE_CORRUPTED).toBe('SESSION_FILE_CORRUPTED');

      // File system errors
      expect(ErrorCode.WORKING_DIR_NOT_FOUND).toBe('WORKING_DIR_NOT_FOUND');
      expect(ErrorCode.FILE_READ_ERROR).toBe('FILE_READ_ERROR');
      expect(ErrorCode.FILE_WRITE_ERROR).toBe('FILE_WRITE_ERROR');

      // Git errors
      expect(ErrorCode.GIT_CONFLICT).toBe('GIT_CONFLICT');

      // Input errors
      expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(ErrorCode.EMPTY_MESSAGE).toBe('EMPTY_MESSAGE');
    });
  });

  describe('toUserMessage', () => {
    it('should return friendly message for SESSION_NOT_FOUND', () => {
      const error = Errors.sessionNotFound('abc-123');
      expect(toUserMessage(error)).toBe('Session not found. Starting a new session.');
    });

    it('should return friendly message for SESSION_FILE_MISSING', () => {
      const error = Errors.sessionFileMissing('abc-123');
      expect(toUserMessage(error)).toBe('Session not found. Starting a new session.');
    });

    it('should return friendly message for SESSION_FILE_CORRUPTED', () => {
      const error = Errors.sessionFileCorrupted();
      expect(toUserMessage(error)).toBe('Session data was corrupted. Starting a new session.');
    });

    it('should return friendly message for WORKING_DIR_NOT_FOUND', () => {
      const error = Errors.workingDirNotFound('/bad/path');
      expect(toUserMessage(error)).toContain('Directory not found');
      expect(toUserMessage(error)).toContain('cwd');
    });

    it('should return friendly message for GIT_CONFLICT', () => {
      const error = Errors.gitConflict();
      expect(toUserMessage(error)).toBe('Git conflicts detected. Proceeding anyway.');
    });

    it('should include error message for CLAUDE_SDK_ERROR', () => {
      const error = Errors.claudeSdkError('Connection refused');
      const message = toUserMessage(error);
      expect(message).toContain('Claude encountered an error');
      expect(message).toContain('Connection refused');
    });

    it('should return friendly message for CLAUDE_TIMEOUT', () => {
      const error = Errors.claudeTimeout();
      expect(toUserMessage(error)).toBe('Request timed out. Please try again.');
    });

    it('should return friendly message for SLACK_RATE_LIMITED', () => {
      const error = Errors.slackRateLimited();
      expect(toUserMessage(error)).toBe('Rate limited. Retrying...');
    });

    it('should return friendly message for SLACK_MESSAGE_TOO_LONG', () => {
      const error = new SlackBotError('too long', ErrorCode.SLACK_MESSAGE_TOO_LONG);
      expect(toUserMessage(error)).toContain('too long');
      expect(toUserMessage(error)).toContain('split');
    });

    it('should return friendly message for SLACK_API_ERROR', () => {
      const error = Errors.slackApiError('channel_not_found');
      expect(toUserMessage(error)).toBe('Failed to communicate with Slack. Please try again.');
    });

    it('should include path for FILE_READ_ERROR', () => {
      const error = Errors.fileReadError('/path/to/file');
      expect(toUserMessage(error)).toContain('Could not read file');
      expect(toUserMessage(error)).toContain('/path/to/file');
    });

    it('should include path for FILE_WRITE_ERROR', () => {
      const error = Errors.fileWriteError('/path/to/file');
      expect(toUserMessage(error)).toContain('Could not write file');
      expect(toUserMessage(error)).toContain('/path/to/file');
    });

    it('should return friendly message for EMPTY_MESSAGE', () => {
      const error = Errors.emptyMessage();
      expect(toUserMessage(error)).toContain('Please provide a message');
    });

    it('should include message for INVALID_INPUT', () => {
      const error = Errors.invalidInput('bad format');
      expect(toUserMessage(error)).toContain('Invalid input');
      expect(toUserMessage(error)).toContain('bad format');
    });

    it('should handle Slack API rate limit errors', () => {
      const slackError = { data: { error: 'ratelimited' } };
      expect(toUserMessage(slackError)).toBe('Rate limited. Retrying...');
    });

    it('should handle Slack API channel_not_found errors', () => {
      const slackError = { data: { error: 'channel_not_found' } };
      expect(toUserMessage(slackError)).toBe('Channel not found.');
    });

    it('should handle generic Slack API errors', () => {
      const slackError = { data: { error: 'some_other_error' } };
      expect(toUserMessage(slackError)).toContain('Slack error');
      expect(toUserMessage(slackError)).toContain('some_other_error');
    });

    it('should return generic message for standard Error', () => {
      const error = new Error('Internal implementation detail');
      expect(toUserMessage(error)).toBe('An unexpected error occurred. Please try again.');
    });

    it('should return generic message for null/undefined', () => {
      expect(toUserMessage(null)).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage(undefined)).toBe('An unexpected error occurred. Please try again.');
    });

    it('should return generic message for non-error objects', () => {
      expect(toUserMessage({})).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage({ random: 'object' })).toBe('An unexpected error occurred. Please try again.');
      expect(toUserMessage('string error')).toBe('An unexpected error occurred. Please try again.');
    });
  });

  describe('isRecoverable', () => {
    it('should return recoverable property for SlackBotError', () => {
      const recoverable = Errors.slackRateLimited();
      const notRecoverable = Errors.sessionNotFound('abc');

      expect(isRecoverable(recoverable)).toBe(true);
      expect(isRecoverable(notRecoverable)).toBe(false);
    });

    it('should mark claudeTimeout as recoverable', () => {
      const error = Errors.claudeTimeout();
      expect(isRecoverable(error)).toBe(true);
    });

    it('should mark slackApiError as recoverable', () => {
      const error = Errors.slackApiError('temporary');
      expect(isRecoverable(error)).toBe(true);
    });

    it('should mark Slack rate limit API errors as recoverable', () => {
      const slackError = { data: { error: 'ratelimited' } };
      expect(isRecoverable(slackError)).toBe(true);
    });

    it('should mark ECONNRESET as recoverable', () => {
      const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      expect(isRecoverable(error)).toBe(true);
    });

    it('should mark ETIMEDOUT as recoverable', () => {
      const error = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      expect(isRecoverable(error)).toBe(true);
    });

    it('should mark ECONNREFUSED as recoverable', () => {
      const error = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      expect(isRecoverable(error)).toBe(true);
    });

    it('should NOT mark non-recoverable SlackBotErrors as recoverable', () => {
      expect(isRecoverable(Errors.sessionNotFound('abc'))).toBe(false);
      expect(isRecoverable(Errors.workingDirNotFound('/bad'))).toBe(false);
      expect(isRecoverable(Errors.claudeSdkError('fatal'))).toBe(false);
      expect(isRecoverable(Errors.emptyMessage())).toBe(false);
      expect(isRecoverable(Errors.gitConflict())).toBe(false);
    });

    it('should NOT mark generic errors as recoverable', () => {
      expect(isRecoverable(new Error('random'))).toBe(false);
    });

    it('should NOT mark non-error values as recoverable', () => {
      expect(isRecoverable(null)).toBe(false);
      expect(isRecoverable(undefined)).toBe(false);
      expect(isRecoverable({})).toBe(false);
      expect(isRecoverable('string')).toBe(false);
    });
  });

  describe('getRetryAfter', () => {
    it('should extract retry_after from Slack API error', () => {
      const error = {
        data: {
          error: 'ratelimited',
          response_metadata: { retry_after: 30 },
        },
      };
      expect(getRetryAfter(error)).toBe(30);
    });

    it('should return null if no retry_after present', () => {
      const error = { data: { error: 'ratelimited' } };
      expect(getRetryAfter(error)).toBe(null);
    });

    it('should return null for non-Slack errors', () => {
      expect(getRetryAfter(new Error('test'))).toBe(null);
      expect(getRetryAfter(null)).toBe(null);
      expect(getRetryAfter({})).toBe(null);
    });

    it('should return null for SlackBotError (not Slack API error)', () => {
      const error = Errors.slackRateLimited(30);
      expect(getRetryAfter(error)).toBe(null);
    });
  });

  describe('Errors factory', () => {
    it('should create sessionNotFound error correctly', () => {
      const error = Errors.sessionNotFound('abc-123');
      expect(error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
      expect(error.message).toContain('abc-123');
      expect(error.recoverable).toBe(false);
    });

    it('should create sessionFileMissing error correctly', () => {
      const error = Errors.sessionFileMissing('xyz-789');
      expect(error.code).toBe(ErrorCode.SESSION_FILE_MISSING);
      expect(error.message).toContain('xyz-789');
      expect(error.recoverable).toBe(false);
    });

    it('should create sessionFileCorrupted error correctly', () => {
      const error = Errors.sessionFileCorrupted();
      expect(error.code).toBe(ErrorCode.SESSION_FILE_CORRUPTED);
      expect(error.recoverable).toBe(false);
    });

    it('should create workingDirNotFound error correctly', () => {
      const error = Errors.workingDirNotFound('/nonexistent');
      expect(error.code).toBe(ErrorCode.WORKING_DIR_NOT_FOUND);
      expect(error.message).toContain('/nonexistent');
      expect(error.recoverable).toBe(false);
    });

    it('should create gitConflict error correctly', () => {
      const error = Errors.gitConflict();
      expect(error.code).toBe(ErrorCode.GIT_CONFLICT);
      expect(error.recoverable).toBe(false);
    });

    it('should create claudeSdkError error correctly', () => {
      const error = Errors.claudeSdkError('API connection failed');
      expect(error.code).toBe(ErrorCode.CLAUDE_SDK_ERROR);
      expect(error.message).toBe('API connection failed');
      expect(error.recoverable).toBe(false);
    });

    it('should create claudeTimeout error as recoverable', () => {
      const error = Errors.claudeTimeout();
      expect(error.code).toBe(ErrorCode.CLAUDE_TIMEOUT);
      expect(error.recoverable).toBe(true);
    });

    it('should create slackRateLimited error with retry time', () => {
      const error = Errors.slackRateLimited(30);
      expect(error.code).toBe(ErrorCode.SLACK_RATE_LIMITED);
      expect(error.message).toContain('30');
      expect(error.recoverable).toBe(true);
    });

    it('should create slackRateLimited error without retry time', () => {
      const error = Errors.slackRateLimited();
      expect(error.code).toBe(ErrorCode.SLACK_RATE_LIMITED);
      expect(error.recoverable).toBe(true);
    });

    it('should create slackApiError as recoverable', () => {
      const error = Errors.slackApiError('temporary failure');
      expect(error.code).toBe(ErrorCode.SLACK_API_ERROR);
      expect(error.recoverable).toBe(true);
    });

    it('should create emptyMessage error correctly', () => {
      const error = Errors.emptyMessage();
      expect(error.code).toBe(ErrorCode.EMPTY_MESSAGE);
      expect(error.recoverable).toBe(false);
    });

    it('should create invalidInput error correctly', () => {
      const error = Errors.invalidInput('missing field');
      expect(error.code).toBe(ErrorCode.INVALID_INPUT);
      expect(error.message).toBe('missing field');
      expect(error.recoverable).toBe(false);
    });

    it('should create fileReadError with path', () => {
      const error = Errors.fileReadError('/some/path');
      expect(error.code).toBe(ErrorCode.FILE_READ_ERROR);
      expect(error.message).toBe('/some/path');
    });

    it('should create fileReadError with path and cause', () => {
      const error = Errors.fileReadError('/some/path', 'ENOENT');
      expect(error.code).toBe(ErrorCode.FILE_READ_ERROR);
      expect(error.message).toContain('/some/path');
      expect(error.message).toContain('ENOENT');
    });

    it('should create fileWriteError with path', () => {
      const error = Errors.fileWriteError('/some/path');
      expect(error.code).toBe(ErrorCode.FILE_WRITE_ERROR);
      expect(error.message).toBe('/some/path');
    });

    it('should create fileWriteError with path and cause', () => {
      const error = Errors.fileWriteError('/some/path', 'EACCES');
      expect(error.code).toBe(ErrorCode.FILE_WRITE_ERROR);
      expect(error.message).toContain('/some/path');
      expect(error.message).toContain('EACCES');
    });
  });
});
