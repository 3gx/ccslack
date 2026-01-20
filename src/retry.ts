/**
 * Retry utilities with exponential backoff.
 * Used to handle transient failures like rate limits and network errors.
 */

import { isRecoverable, getRetryAfter } from './errors.js';

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Custom function to determine if error is retryable */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry attempt */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  shouldRetry: (error) => isRecoverable(error),
};

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfter?: number | null
): number {
  // If server specified retry-after, use that
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }

  // Exponential backoff: base * 2^(attempt-1)
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);

  // Add jitter (random 0-100ms) to prevent thundering herd
  const jitter = Math.random() * 100;

  // Cap at max delay
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Execute a function with retry logic.
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchData(),
 *   { maxAttempts: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = opts.shouldRetry(error, attempt);
      const isLastAttempt = attempt === opts.maxAttempts;

      if (!shouldRetry || isLastAttempt) {
        throw error;
      }

      // Calculate delay (respect Retry-After header if present)
      const retryAfter = getRetryAfter(error);
      const delay = calculateDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        retryAfter
      );

      // Notify about retry
      if (opts.onRetry) {
        opts.onRetry(error, attempt, delay);
      }

      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError;
}

/**
 * Options specific to Slack retry behavior.
 */
export interface SlackRetryOptions extends Partial<RetryOptions> {
  /** Called once on first rate limit hit (not on every retry) */
  onRateLimit?: (retryAfter?: number) => void;
}

/**
 * Pre-configured retry function for Slack API calls.
 * Handles rate limits and network errors with appropriate backoff.
 *
 * @example
 * ```typescript
 * await withSlackRetry(() =>
 *   client.chat.postMessage({ channel, text })
 * );
 * ```
 */
export async function withSlackRetry<T>(
  fn: () => Promise<T>,
  options: SlackRetryOptions = {}
): Promise<T> {
  const { onRateLimit, ...retryOptions } = options;
  let rateLimitNotified = false;

  return withRetry(fn, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000, // Slack rate limits can be long
    shouldRetry: (error) => {
      // Retry on rate limits
      if (isSlackRateLimitError(error)) {
        return true;
      }

      // Retry on network errors
      if (isNetworkError(error)) {
        return true;
      }

      // Use default recoverable check for other errors
      return isRecoverable(error);
    },
    onRetry: (error, attempt, delayMs) => {
      const isRateLimit = isSlackRateLimitError(error);
      const errorType = isRateLimit ? 'rate limited' : 'network error';
      console.log(
        `Slack API ${errorType}, retrying in ${delayMs}ms (attempt ${attempt})`
      );

      // Call onRateLimit callback once on first rate limit hit
      if (isRateLimit && !rateLimitNotified && onRateLimit) {
        rateLimitNotified = true;
        const retryAfter = getRetryAfter(error) ?? undefined;
        onRateLimit(retryAfter);
      }
    },
    ...retryOptions,
  });
}

/**
 * Check if error is a Slack rate limit error.
 */
function isSlackRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const slackError = error as { data?: { error?: string } };
  return slackError.data?.error === 'ratelimited';
}

/**
 * Check if error is a network error.
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

/**
 * Options for infinite retry behavior.
 */
export interface InfiniteRetryOptions {
  /** Base delay in milliseconds (default: 3000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Called on each retry attempt */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Called on success after retries */
  onSuccess?: (attempts: number) => void;
}

/**
 * Execute a function with infinite retries until success.
 * Used by /ff command to ensure all messages eventually sync.
 *
 * Uses exponential backoff starting at baseDelayMs, capped at maxDelayMs.
 * Resets to baseDelayMs after success (for next call).
 *
 * @example
 * ```typescript
 * await withInfiniteRetry(
 *   () => postMessage(msg),
 *   {
 *     baseDelayMs: 3000,
 *     onRetry: (err, attempt, delay) => console.log(`Retry ${attempt} in ${delay}ms`)
 *   }
 * );
 * ```
 */
export async function withInfiniteRetry<T>(
  fn: () => Promise<T>,
  options: InfiniteRetryOptions = {}
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 3000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  let attempt = 0;

  while (true) {
    try {
      const result = await fn();
      // Success - notify if we had retries
      if (attempt > 0 && options.onSuccess) {
        options.onSuccess(attempt + 1);
      }
      return result;
    } catch (error) {
      attempt++;

      // Calculate delay with exponential backoff, capped at max
      // Check for Retry-After header first
      const retryAfter = getRetryAfter(error);
      let delay: number;
      if (retryAfter && retryAfter > 0) {
        delay = retryAfter * 1000;
      } else {
        delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      }

      // Add jitter (0-500ms) to prevent thundering herd
      delay += Math.random() * 500;

      if (options.onRetry) {
        options.onRetry(error, attempt, delay);
      }

      await sleep(delay);
      // Loop continues - never give up
    }
  }
}
