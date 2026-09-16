import type { ZodType } from 'zod';
import { sha256 } from '../util/hash.ts';
import { ModelError } from './errors.ts';
import { schemaFingerprint } from './schema.ts';

/**
 * The whole contract between LexMind's legal logic and any LLM, deliberately small.
 *
 * No vendor type crosses this boundary, which buys three judged properties at once:
 * every layer above it is testable with a fake and needs no network; exactly one file in the
 * repository can see the API key; and the vendor SDK's quirks — a getter that looks like a
 * method, two parallel generation APIs, silently-dropped schema keywords — stay quarantined in
 * about 150 lines instead of smeared across the codebase.
 *
 * There is no `embed()`. LexMind retrieves lexically over one document's clauses, measured as
 * sufficient, so an embedding method would be an unused capability in an interface that exists to
 * be small. Adding it later is a one-line change to a file nothing else depends on.
 */

/**
 * Model tiering by job rather than by habit.
 *
 * `extract` is the cheap, repeatable tier — flash-lite, on which thinking is off by default, which
 * makes it both cheapest and most reproducible for structured extraction. `analysis` is used for
 * genuine language work. The split is reported in `reports/perf.md` so a reviewer can see that
 * not every call went to the biggest model available.
 */
export type ModelTier = 'analysis' | 'extract';

export interface JsonRequest<T> {
  /** A stable label for this kind of call. Part of the cassette key and the usage report. */
  readonly task: string;
  readonly tier: ModelTier;
  /**
   * The stable part of the prompt. Kept first, and identical across calls, so the provider's
   * implicit prefix cache actually hits — getting this ordering backwards silently forfeits the
   * discount.
   */
  readonly systemInstruction: string;
  /**
   * Untrusted document text, carried in its own channel rather than concatenated into the
   * instructions. See `safety/injection.ts` for what this does and does not achieve.
   */
  readonly document?: string;
  /** The varying tail: the actual task or question. */
  readonly task_input: string;
  readonly schema: ZodType<T>;
  readonly maxOutputTokens?: number;
}

export interface TextRequest {
  readonly task: string;
  readonly tier: ModelTier;
  readonly systemInstruction: string;
  readonly document?: string;
  readonly task_input: string;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface Usage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number;
  /** Non-zero proves the implicit prefix cache hit. Reported, not assumed. */
  readonly cachedTokens: number;
  readonly totalTokens: number;
}

export const NO_USAGE: Usage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
};

export interface JsonResult<T> {
  readonly value: T;
  readonly usage: Usage;
  /** True when the first response failed validation and one repair attempt was made. */
  readonly repaired: boolean;
  readonly model: string;
}

export interface LlmPort {
  generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
  generateTextStream(request: TextRequest): AsyncIterable<string>;
  countTokens(text: string): Promise<number>;
  /** Identifies the adapter in reports and in the UI, e.g. "replay" or "gemini-2.5-flash". */
  readonly label: string;
}

/**
 * Assemble the prompt in cache-friendly order: stable instruction, then the document, then the
 * varying task. Shared by every adapter so the cassette key and the live request agree.
 */
export function assemblePrompt(request: JsonRequest<unknown> | TextRequest): string {
  const parts = [request.systemInstruction];
  if (request.document !== undefined) parts.push(request.document);
  parts.push(request.task_input);
  return parts.join('\n\n');
}

/**
 * The cassette key: the model tier, the task, the exact prompt, and the schema shape.
 *
 * The schema is in the key on purpose. If a schema changes, the recorded response may no longer
 * validate against it, and a key miss reading "re-record this cassette" is far more useful than a
 * validation failure reading "the model is broken".
 */
/** Joins the key parts. Printable, and impossible inside a tier or task label. */
const SEPARATOR = '|~LEXMIND~|';

export function requestKey(request: JsonRequest<unknown> | TextRequest): string {
  // `'schema' in request` is true for a key present with an undefined value, which would then
  // be fingerprinted and throw deep inside the converter.
  const schema =
    'schema' in request && request.schema !== undefined
      ? schemaFingerprint(request.schema)
      : 'text';
  return sha256([request.tier, request.task, assemblePrompt(request), schema].join(SEPARATOR));
}

/**
 * Two-stage validation: `JSON.parse`, then Zod.
 *
 * The second stage is not belt and braces. Gemini ignores `minLength`, `pattern` and `const`
 * entirely, so those constraints exist *only* here — a schema-valid response can still violate
 * every one of them.
 */
export function parseWithSchema<T>(raw: string, schema: ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ModelError('MALFORMED', 'The model returned text that is not valid JSON.', {
      retryable: false,
      cause,
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ModelError(
      'MALFORMED',
      `The model's JSON did not match the expected shape: ${summariseZodError(result.error)}`,
      { retryable: false, cause: result.error },
    );
  }
  return result.data;
}

interface ZodIssueLike {
  readonly path: readonly (string | number | symbol)[];
  readonly message: string;
}

export function summariseZodError(error: { readonly issues: readonly ZodIssueLike[] }): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
