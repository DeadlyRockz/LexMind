import { type Cassette, createReplayAdapter, loadCassettes } from './adapters/replay.ts';
import { ModelError } from './errors.ts';
import type { LlmPort } from './port.ts';

export {
  addUsage,
  assertWithinPromptBudget,
  type BudgetConfig,
  cacheHitRate,
  EMPTY_METER,
  ESTIMATED_PRICE_PER_MILLION,
  estimateCostUsd,
  estimateTokens,
  PDF_TOKENS_PER_PAGE,
  readBudgetConfig,
  recordUsage,
  type UsageMeter,
} from './budget.ts';
export {
  classifyApiError,
  isModelError,
  ModelError,
  type ModelErrorCode,
} from './errors.ts';
export {
  assemblePrompt,
  type JsonRequest,
  type JsonResult,
  type LlmPort,
  type ModelTier,
  NO_USAGE,
  parseWithSchema,
  requestKey,
  summariseZodError,
  type TextRequest,
  type Usage,
} from './port.ts';
export { backoffDelay, DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts';
export {
  assertGeminiSafeSchema,
  GEMINI_IGNORED_KEYWORDS,
  GEMINI_SUPPORTED_KEYWORDS,
  type SanitisedSchema,
  schemaFingerprint,
  toGeminiSchema,
} from './schema.ts';
export { parseWithRepair, repairInstruction, type RepairOutcome } from './validate.ts';
export { type Cassette, createReplayAdapter, loadCassettes } from './adapters/replay.ts';

/**
 * An adapter that refuses every request, cleanly.
 *
 * This is not a stub for convenience — it is the honest default when no key is configured. The
 * deterministic engine is the product's floor, so "no model available" must be an ordinary,
 * well-typed state that the pipeline routes around, not an exception that ends the analysis.
 */
function buildError(reason: string): ModelError {
  return new ModelError('NOT_CONFIGURED', reason, {
    retryable: false,
    userMessage:
      'LexMind is running without an AI provider, so the plain-English explanations are unavailable. Every rule-based finding below — deposits, notice periods, entry rights, repair duties, prohibited clauses — is computed locally and unaffected.',
  });
}

export function createUnavailableAdapter(reason: string): LlmPort {
  const fail = (): never => {
    throw buildError(reason);
  };

  // Each method must *reject* rather than throw synchronously. `Promise.reject(fail())` would
  // evaluate `fail()` first and throw before the promise was ever built, so a caller holding only
  // a `.catch()` would take an uncaught exception instead of a handled refusal.
  return {
    label: 'unavailable (no API key)',
    generateJson: (): Promise<never> => Promise.reject(buildError(reason)),
    generateTextStream: (): AsyncIterable<string> =>
      (async function* refuse(): AsyncGenerator<string> {
        fail();
      })(),
    countTokens: (): Promise<number> => Promise.reject(buildError(reason)),
  };
}

export interface ModelSelection {
  readonly port: LlmPort;
  /** Why this adapter was chosen, shown in the CLI banner and the UI's provenance line. */
  readonly reason: string;
  readonly offline: boolean;
}

/**
 * Choose an adapter from the environment.
 *
 * `LEXMIND_OFFLINE=1` wins over a present key on purpose: CI sets it, and a test that could fall
 * through to a live call is a test that will eventually make one.
 *
 * The live adapter is imported dynamically so that the offline path — which is every test, and
 * the whole CLI when no key is set — never even loads the vendor SDK.
 */
export async function selectModel(options?: {
  readonly env?: Record<string, string | undefined>;
  readonly cassetteDir?: string;
  readonly cassettes?: readonly Cassette[];
}): Promise<ModelSelection> {
  const env = options?.env ?? process.env;

  if (env['LEXMIND_OFFLINE'] === '1') {
    const cassettes =
      options?.cassettes ??
      (options?.cassetteDir === undefined ? [] : loadCassettes(options.cassetteDir));
    return {
      port: createReplayAdapter(cassettes),
      reason: `offline mode: replaying ${cassettes.length} recorded response${cassettes.length === 1 ? '' : 's'}`,
      offline: true,
    };
  }

  const apiKey = env['GEMINI_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      port: createUnavailableAdapter('GEMINI_API_KEY is not set.'),
      reason: 'no API key: rule-based analysis only',
      offline: true,
    };
  }

  const { createGeminiAdapter } = await import('./adapters/gemini.ts');
  const port = createGeminiAdapter({ env });
  return { port, reason: `live: ${port.label}`, offline: false };
}
