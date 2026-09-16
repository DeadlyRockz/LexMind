import { ModelError } from '../model/errors.ts';
import type { JsonRequest, JsonResult, LlmPort, TextRequest } from '../model/port.ts';
import { stripInvisible } from '../util/text.ts';
import { isChannelWrapped, wrapDocumentChannel } from './injection.ts';
import { redact, restore } from './redact.ts';
import type { SurrogateMap } from './surrogates.ts';

export { classifyRequest, findAdvicePhrases, refusalText } from './boundary.ts';
export type { AnswerableDecision, BoundaryDecision, RefusedDecision } from './boundary.ts';
export {
  isValidIfscFormat,
  isValidLuhn,
  isValidNino,
  isValidNric,
  isValidPanFormat,
  isValidVerhoeff,
  verhoeffCheckDigit,
} from './checksums.ts';
export {
  ACCURACY_NOTE,
  AI_DISCLOSURE,
  exportFooter,
  type ExportFooterOptions,
  NO_ADVICE_SUMMARY,
} from './disclosure.ts';
export {
  CHANNEL_CLOSE,
  CHANNEL_OPEN,
  isChannelWrapped,
  neutraliseModelUrls,
  stripChannelMarkers,
  SYSTEM_PREAMBLE,
  wrapDocumentChannel,
} from './injection.ts';
export { findLeaks, redact, type RedactionResult, type RedactOptions, restore } from './redact.ts';
export {
  type PartyRole,
  type PiiKind,
  type Replacement,
  SurrogateMap,
} from './surrogates.ts';

/**
 * A document prepared for transmission: redacted, stripped of invisible characters, and wrapped in
 * its own provenance-labelled channel.
 *
 * The `map` is in-process only and refuses to serialise. See `SurrogateMap`.
 */
export interface SafeDocument {
  /** The only form of the document that is ever put in a prompt. */
  readonly channel: string;
  readonly map: SurrogateMap;
  /** Counts by kind. Safe to display and to log. */
  readonly summary: Readonly<Record<string, number>>;
}

export function prepareForModel(text: string): SafeDocument {
  const { text: redacted, map, summary } = redact(stripInvisible(text));
  return { channel: wrapDocumentChannel(redacted), map, summary };
}

/** Put the real values back, and neuter anything the model may have invented, before rendering. */
export function restoreForReader(text: string, safe: SafeDocument): string {
  return restore(text, safe.map);
}

/**
 * Wrap a model port so that the safe path is the *only* path.
 *
 * This is the point of the whole safety layer. Guardrails added at the end are a wrapper somebody
 * eventually forgets to call; a port that refuses any request whose document has not been through
 * `prepareForModel` cannot be bypassed by forgetting. The check is structural — the channel
 * markers must be present — so it fails loudly at the call site during development rather than
 * quietly in production.
 */
export function createGuardedPort(port: LlmPort): LlmPort {
  const check = (document: string | undefined, task: string): void => {
    if (document === undefined) return;
    if (isChannelWrapped(document)) return;
    throw new ModelError(
      'NOT_CONFIGURED',
      `Task "${task}" passed raw document text to the model. Document text must go through ` +
        'prepareForModel() so it is redacted and channel-wrapped. This is the guarantee that the ' +
        'model never sees raw personal data.',
      { retryable: false },
    );
  };

  // Both methods must surface the refusal as a rejection rather than a synchronous throw: a
  // caller holding only a `.catch()` would otherwise take an uncaught exception.
  return {
    label: port.label,
    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      check(request.document, request.task);
      return port.generateJson(request);
    },
    generateTextStream(request: TextRequest): AsyncIterable<string> {
      const source = port.generateTextStream.bind(port);
      return (async function* guarded(): AsyncGenerator<string> {
        check(request.document, request.task);
        yield* source(request);
      })();
    },
    countTokens(text: string): Promise<number> {
      return port.countTokens(text);
    },
  };
}

/**
 * A best-effort request limiter.
 *
 * Described honestly, because the honesty is the point: in a serverless deployment this is a
 * **cost speed-bump, not a security control**. Instances scale horizontally and each one gets its
 * own counter, so a determined caller simply lands on a different instance. The real control is
 * the platform firewall's rate-limit rule, plus the token ceilings in `model/budget.ts`. This
 * exists so a single misbehaving client cannot exhaust a free-tier quota in one burst locally.
 */
export function createRequestLimiter(options: {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): (key: string) => boolean {
  const now = options.now ?? Date.now;
  const seen = new Map<string, number[]>();

  return (key: string): boolean => {
    const current = now();
    const cutoff = current - options.windowMs;
    const timestamps = (seen.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= options.maxRequests) {
      seen.set(key, timestamps);
      return false;
    }
    timestamps.push(current);
    seen.set(key, timestamps);
    return true;
  };
}
