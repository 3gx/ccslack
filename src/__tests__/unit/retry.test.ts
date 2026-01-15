import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, withSlackRetry, sleep } from '../../retry.js';
import { Errors } from '../../errors.js';

describe('retry module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sleep', () => {
    it('should resolve after specified duration', async () => {
      const promise = sleep(100);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
    });

    it('should not resolve before specified duration', async () => {
      let resolved = false;
      sleep(100).then(() => { resolved = true; });

      vi.advanceTimersByTime(50);
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(50);
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const promise = withRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on recoverable errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withRetry(fn, { baseDelayMs: 10, maxDelayMs: 50 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should NOT retry on non-recoverable errors', async () => {
      const fn = vi.fn(async () => {
        throw Errors.sessionNotFound('abc');
      });

      const promise = withRetry(fn, { maxAttempts: 3 });
      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
      const expectRejects = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await expectRejects;

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should respect maxAttempts limit', async () => {
      const fn = vi.fn(async () => {
        throw Errors.slackRateLimited();
      });

      const promise = withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 });
      const expectRejects = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await expectRejects;

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should use default maxAttempts of 3', async () => {
      const fn = vi.fn(async () => {
        throw Errors.slackRateLimited();
      });

      const promise = withRetry(fn, { baseDelayMs: 10 });
      const expectRejects = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await expectRejects;

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should call onRetry callback before each retry', async () => {
      let attempts = 0;
      const onRetry = vi.fn();
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withRetry(fn, { baseDelayMs: 10, onRetry });
      await vi.runAllTimersAsync();
      await promise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.any(Error),
        1,
        expect.any(Number)
      );
    });

    it('should pass error, attempt, and delay to onRetry', async () => {
      let attempts = 0;
      const onRetry = vi.fn();
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withRetry(fn, { baseDelayMs: 100, onRetry });
      await vi.runAllTimersAsync();
      await promise;

      expect(onRetry).toHaveBeenCalledTimes(2);
      // First retry
      expect(onRetry.mock.calls[0][1]).toBe(1); // attempt
      expect(onRetry.mock.calls[0][2]).toBeGreaterThanOrEqual(100); // delay
      // Second retry
      expect(onRetry.mock.calls[1][1]).toBe(2); // attempt
    });

    it('should use custom shouldRetry function', async () => {
      let attempts = 0;
      const shouldRetry = vi.fn((error, attempt) => {
        return attempt < 2 && (error as Error).message.includes('retry');
      });
      const fn = vi.fn(async () => {
        attempts++;
        throw new Error('please retry');
      });

      const promise = withRetry(fn, {
        shouldRetry,
        baseDelayMs: 10,
        maxAttempts: 5
      });
      const expectRejects = expect(promise).rejects.toThrow('please retry');
      await vi.runAllTimersAsync();
      await expectRejects;

      expect(fn).toHaveBeenCalledTimes(2);
      expect(shouldRetry).toHaveBeenCalledTimes(2);
    });

    it('should apply exponential backoff', async () => {
      let attempts = 0;
      const delays: number[] = [];
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 4) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withRetry(fn, {
        baseDelayMs: 100,
        maxDelayMs: 10000,
        maxAttempts: 4,
        onRetry: (_, __, delay) => delays.push(delay)
      });
      await vi.runAllTimersAsync();
      await promise;

      // Delays should increase (with some jitter)
      expect(delays[0]).toBeGreaterThanOrEqual(100);
      expect(delays[0]).toBeLessThan(210); // 100 + up to 100 jitter
      expect(delays[1]).toBeGreaterThanOrEqual(200);
      expect(delays[2]).toBeGreaterThanOrEqual(400);
    });

    it('should cap delay at maxDelayMs', async () => {
      let attempts = 0;
      const delays: number[] = [];
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 5) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withRetry(fn, {
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        maxAttempts: 5,
        onRetry: (_, __, delay) => delays.push(delay)
      });
      await vi.runAllTimersAsync();
      await promise;

      // All delays should be <= maxDelayMs
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(2000);
      }
    });

    it('should respect Retry-After header from Slack errors', async () => {
      let attempts = 0;
      const delays: number[] = [];
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw { data: { error: 'ratelimited', response_metadata: { retry_after: 5 } } };
        }
        return 'success';
      });

      const promise = withRetry(fn, {
        baseDelayMs: 100,
        onRetry: (_, __, delay) => delays.push(delay)
      });
      await vi.runAllTimersAsync();
      await promise;

      // Should use retry_after (5 seconds = 5000ms)
      expect(delays[0]).toBe(5000);
    });
  });

  describe('withSlackRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('data');

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('data');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on Slack rate limit errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw { data: { error: 'ratelimited' } };
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ECONNRESET network errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('ECONNRESET');
          (error as NodeJS.ErrnoException).code = 'ECONNRESET';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ETIMEDOUT network errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('ETIMEDOUT');
          (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ECONNREFUSED network errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('ECONNREFUSED');
          (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ENOTFOUND network errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('ENOTFOUND');
          (error as NodeJS.ErrnoException).code = 'ENOTFOUND';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on EAI_AGAIN network errors', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('EAI_AGAIN');
          (error as NodeJS.ErrnoException).code = 'EAI_AGAIN';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on non-retryable errors', async () => {
      const fn = vi.fn(async () => {
        throw new Error('Unknown error');
      });

      const promise = withSlackRetry(fn);
      const expectRejects = expect(promise).rejects.toThrow('Unknown error');
      await vi.runAllTimersAsync();
      await expectRejects;

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should have maxDelayMs of 30000 for Slack', async () => {
      // Test that withSlackRetry uses 30s max delay (documented for long rate limits)
      let attempts = 0;
      const delays: number[] = [];
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 5) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      // Override with higher maxAttempts to test delay capping
      const promise = withSlackRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10000, // Large base to hit cap quickly
        onRetry: (_, __, delay) => delays.push(delay)
      });
      await vi.runAllTimersAsync();
      await promise;

      // All delays should be <= 30000
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(30000);
      }
    });

    it('should allow overriding options', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 5) {
          throw Errors.slackRateLimited();
        }
        return 'success';
      });

      const promise = withSlackRetry(fn, { maxAttempts: 2 });
      const expectRejects = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await expectRejects;

      // Should respect overridden maxAttempts
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should log retry attempts', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw { data: { error: 'ratelimited' } };
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      await promise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Slack API rate limited')
      );
      consoleSpy.mockRestore();
    });

    it('should log network errors as network error type', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('ECONNRESET');
          (error as NodeJS.ErrnoException).code = 'ECONNRESET';
          throw error;
        }
        return 'success';
      });

      const promise = withSlackRetry(fn);
      await vi.runAllTimersAsync();
      await promise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('network error')
      );
      consoleSpy.mockRestore();
    });
  });
});
