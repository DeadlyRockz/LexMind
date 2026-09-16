/**
 * The model error taxonomy.
 *
 * Every failure mode gets a type, because the correct response differs sharply between them:
 * a rate limit means back off and retry, a *quota* exhaustion means the daily cap is gone and
 * retrying within the day is futile, and malformed output means fail closed rather than show a
 * half-parsed result to someone reading it as legal information.
 */

export type ModelErrorCode =
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'MALFORMED'
  | 'TRUNCATED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'BUDGET_EXCEEDED'
  | 'CASSETTE_MISS';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;
  /** What the reader sees. Never a stack trace, never a vendor message. */
  readonly userMessage: string;

  constructor(
    code: ModelErrorCode,
    message: string,
    options?: {
      readonly retryable?: boolean;
      readonly userMessage?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.userMessage =
      options?.userMessage ??
      'LexMind could not complete the AI part of this analysis. The rule-based findings above are unaffected.';
  }
}

export function isModelError(error: unknown): error is ModelError {
  return error instanceof ModelError;
}

/**
 * Classify a vendor error into the taxonomy.
 *
 * The distinction that matters most: a 429 can mean either "too fast" or "you have used your
 * allowance for the day", and they are spelled `rate_limit_exceeded` and `quota_exceeded`.
 * Retrying the second one is pure waste, and it is the one that actually happens during a demo.
 */
export function classifyApiError(error: unknown): ModelError {
  const status = readStatus(error);
  const text = readMessage(error);

  if (status === 429) {
    const quota = /quota|exhausted|daily|per day|resource_exhausted/i.test(text);
    return quota
      ? new ModelError('QUOTA_EXHAUSTED', `Daily quota exhausted: ${text}`, {
          retryable: false,
          userMessage:
            "The AI provider's daily free allowance is used up. LexMind's rule-based analysis still works, and it covers deposits, notice periods, entry rights and the prohibited-clause checks.",
          cause: error,
        })
      : new ModelError('RATE_LIMITED', `Rate limited: ${text}`, { retryable: true, cause: error });
  }

  if (status === 408 || status === 499) {
    return new ModelError('TIMEOUT', `Request timed out: ${text}`, { retryable: true, cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new ModelError('UNAVAILABLE', `Provider unavailable (${status}): ${text}`, {
      retryable: true,
      cause: error,
    });
  }
  if (status === 401 || status === 403) {
    return new ModelError('NOT_CONFIGURED', `Rejected (${status}): ${text}`, {
      retryable: false,
      userMessage:
        'The AI provider rejected the API key. LexMind still runs its full rule-based analysis without one.',
      cause: error,
    });
  }
  if (status === 400) {
    return new ModelError('MALFORMED', `Bad request: ${text}`, { retryable: false, cause: error });
  }

  return new ModelError('UNAVAILABLE', text.length > 0 ? text : 'Unknown provider error', {
    retryable: true,
    cause: error,
  });
}

function readStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  // The SDK exports `ApiError extends Error` carrying a numeric `status`.
  const status = 'status' in error ? error.status : undefined;
  if (typeof status === 'number') return status;
  if (typeof status === 'string') {
    const parsed = Number.parseInt(status, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readMessage(error: unknown): string {
  if (error === null || typeof error !== 'object') return String(error ?? '');
  return 'message' in error ? String(error.message) : '';
}
