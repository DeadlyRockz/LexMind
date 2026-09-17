import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyApiError, isModelError, ModelError } from './errors.ts';
import { selectModel } from './index.ts';
import { DEFAULT_RETRY, withRetry } from './retry.ts';
import { parseWithRepair } from './validate.ts';

/**
 * Error classification and what each class does to a retry loop.
 *
 * The distinction that matters is not "did it fail" but "could the same request succeed if sent
 * again". Retrying a rejected key or an exhausted daily quota spends the time budget for nothing,
 * and failing to retry a 503 loses a clause explanation the next attempt would have produced. Every
 * vendor error shape the classifier might meet is pinned here, including the ones that are not
 * objects at all.
 */

describe('ModelError', () => {
  it('defaults to not retryable, with a reader-facing message that never carries the vendor text', () => {
    const error = new ModelError('MALFORMED', 'internal: token 4812 unexpected');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toMatch(/rule-based findings above are unaffected/);
    expect(error.userMessage).not.toMatch(/4812/);
    expect(error.cause).toBeUndefined();
    expect(isModelError(error)).toBe(true);
    expect(isModelError(new Error('plain'))).toBe(false);
  });
});

describe('classifyApiError', () => {
  it('reads a status the SDK reports as a string', () => {
    const error = classifyApiError({ status: '503', message: 'backend unavailable' });
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toBe('Provider unavailable (503): backend unavailable');
    expect(error.retryable).toBe(true);
  });

  it('treats an unparseable status as no status at all', () => {
    const error = classifyApiError({ status: 'n/a', message: 'socket hang up' });
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toBe('socket hang up');
  });

  it('classifies a client timeout as retryable', () => {
    const error = classifyApiError({ status: 499, message: 'client closed request' });
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });

  it('classifies a rejected key as not configured, and never retries it', () => {
    const error = classifyApiError({ status: 401, message: 'API key not valid' });
    expect(error.code).toBe('NOT_CONFIGURED');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toMatch(/rejected the API key/);
  });

  it('classifies a bad request as malformed', () => {
    expect(classifyApiError({ status: 400, message: 'invalid argument' }).code).toBe('MALFORMED');
  });

  it('reads "resource exhausted" on a 429 as the daily quota, not a rate limit', () => {
    const error = classifyApiError({ status: 429, message: 'RESOURCE_EXHAUSTED: per day limit' });
    expect(error.code).toBe('QUOTA_EXHAUSTED');
    expect(error.retryable).toBe(false);
  });

  it('falls back to a retryable unavailability for a status it has no rule for', () => {
    const error = classifyApiError({ status: 404, message: 'model not found' });
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('handles a thrown string, a thrown null and an object with no message', () => {
    expect(classifyApiError('ECONNRESET').message).toBe('ECONNRESET');
    expect(classifyApiError(null).message).toBe('Unknown provider error');
    expect(classifyApiError(undefined).message).toBe('Unknown provider error');
    expect(classifyApiError({}).message).toBe('Unknown provider error');
    expect(classifyApiError({ status: 500 }).message).toBe('Provider unavailable (500): ');
  });

  it('keeps the original error as the cause, for logs rather than for the reader', () => {
    const original = { status: 503, message: 'down' };
    expect(classifyApiError(original).cause).toBe(original);
  });
});

describe('withRetry beyond ModelError', () => {
  it('succeeds on the first attempt with the default policy, without sleeping', async () => {
    const outcomes: number[] = [];
    const value = await withRetry(
      () => Promise.resolve('explained'),
      DEFAULT_RETRY,
      (outcome) => outcomes.push(outcome.attempts),
    );
    expect(value).toBe('explained');
    expect(outcomes).toEqual([1]);
  });

  it('does not retry an unclassified exception, and wraps it so callers see one error type', async () => {
    let calls = 0;
    const cause = new TypeError('cannot read properties of undefined');
    try {
      await withRetry(() => {
        calls += 1;
        throw cause;
      });
      expect.unreachable('the exception must propagate');
    } catch (error) {
      expect(isModelError(error)).toBe(true);
      expect(isModelError(error) && error.code).toBe('UNAVAILABLE');
      expect(isModelError(error) && error.cause).toBe(cause);
    }
    expect(calls).toBe(1);
  });
});

describe('parseWithRepair when the repair itself fails', () => {
  const schema = z.object({ quote: z.string() });

  it('passes a classified repair failure through unchanged', async () => {
    const quota = classifyApiError({ status: 429, message: 'quota exhausted' });
    await expect(parseWithRepair(schema, 'not json', () => Promise.reject(quota))).rejects.toBe(
      quota,
    );
  });

  it('wraps an unclassified repair failure as malformed, keeping the cause', async () => {
    const cause = new Error('stream closed');
    try {
      await parseWithRepair(schema, '{"quote": 3}', () => Promise.reject(cause));
      expect.unreachable('a failed repair must fail closed');
    } catch (error) {
      expect(isModelError(error) && error.code).toBe('MALFORMED');
      expect(isModelError(error) && error.message).toBe('The repair attempt failed.');
      expect(isModelError(error) && error.cause).toBe(cause);
    }
  });

  it('feeds the validation error to the repair, and reports that a repair happened', async () => {
    let seen = '';
    const outcome = await parseWithRepair(schema, '{"quote": 3}', (validationError) => {
      seen = validationError;
      return Promise.resolve('{"quote":"The tenant shall pay rent."}');
    });
    expect(seen).toMatch(/did not match the expected shape/);
    expect(outcome).toEqual({ value: { quote: 'The tenant shall pay rent.' }, repaired: true });
  });
});

describe('selectModel edge cases', () => {
  it('reads the process environment when none is passed, which the test setup forces offline', async () => {
    const selection = await selectModel();
    expect(selection.offline).toBe(true);
    expect(selection.reason).toBe('offline mode: replaying 0 recorded responses');
  });

  it('says "response" in the singular for one cassette', async () => {
    const selection = await selectModel({
      env: { LEXMIND_OFFLINE: '1' },
      cassettes: [{ key: 'k', task: 't', tier: 'extract', model: 'm', response: '{}' }],
    });
    expect(selection.reason).toBe('offline mode: replaying 1 recorded response');
  });

  it('treats an empty API key as no key, rather than attempting a live call with it', async () => {
    const selection = await selectModel({ env: { GEMINI_API_KEY: '' } });
    expect(selection.offline).toBe(true);
    expect(selection.reason).toBe('no API key: rule-based analysis only');
  });
});
