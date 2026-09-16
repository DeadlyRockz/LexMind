import { ModelError, isModelError } from './errors.ts';

/**
 * Exponential backoff with jitter.
 *
 * Written rather than assumed: the documented automatic-retry policy belongs to the Python SDK.
 * The JavaScript SDK does not retry for you, so a 503 on the first call of a demo is a failed
 * demo unless this file exists.
 *
 * Jitter is full jitter — a random point in the whole window — rather than a fixed multiplier,
 * so several concurrent clause analyses that all hit a rate limit do not re-collide in lockstep.
 */

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Injected in tests so the suite never actually sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 16_000,
};

export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export interface RetryOutcome {
  readonly attempts: number;
  readonly delaysMs: readonly number[];
}

/**
 * Run an operation with backoff, retrying only what is worth retrying.
 *
 * `QUOTA_EXHAUSTED` is the case that matters: a daily cap does not clear in eight seconds, so
 * retrying it burns the remaining time budget for no possible gain. It is classified
 * non-retryable in `errors.ts` and this loop honours that immediately.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  onOutcome?: (outcome: RetryOutcome) => void,
): Promise<T> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = policy.random ?? Math.random;
  const delaysMs: number[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      onOutcome?.({ attempts: attempt, delaysMs });
      return value;
    } catch (error) {
      lastError = error;
      const retryable = isModelError(error) && error.retryable;
      if (!retryable || attempt === policy.maxAttempts) break;

      const delay = backoffDelay(attempt, policy, random);
      delaysMs.push(delay);
      await sleep(delay);
    }
  }

  onOutcome?.({ attempts: delaysMs.length + 1, delaysMs });
  throw isModelError(lastError)
    ? lastError
    : new ModelError('UNAVAILABLE', 'The model call failed.', { cause: lastError });
}
