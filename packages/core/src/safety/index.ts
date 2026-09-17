import { ModelError } from '../model/errors.ts';
import type { JsonRequest, JsonResult, LlmPort, TextRequest } from '../model/port.ts';
import { stripInvisible } from '../util/text.ts';
import {
  isChannelWrapped,
  SYSTEM_PREAMBLE,
  stripChannelMarkers,
  wrapDocumentChannel,
} from './injection.ts';
import { applyRedaction, redact, restore } from './redact.ts';
import type { SurrogateMap } from './surrogates.ts';

export type { AnswerableDecision, BoundaryDecision, RefusedDecision } from './boundary.ts';
export {
  adviceWithheldNote,
  classifyRequest,
  findAdvicePhrases,
  refusalText,
} from './boundary.ts';
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
  type ExportFooterOptions,
  exportFooter,
  NO_ADVICE_SUMMARY,
} from './disclosure.ts';
export {
  CHANNEL_CLOSE,
  CHANNEL_OPEN,
  findInjectionSpans,
  type InjectionSpan,
  isChannelWrapped,
  isWhollyCovered,
  neutraliseModelUrls,
  overlapsAny,
  SYSTEM_PREAMBLE,
  stripChannelMarkers,
  type TextRange,
  type TextSection,
  wrapDocumentChannel,
} from './injection.ts';
export { findLeaks, type RedactionResult, type RedactOptions, redact, restore } from './redact.ts';
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
 * Every original the map knows, replaced by its stand-in — after invisible characters are gone, so
 * a zero-width joiner inside a name cannot hide it. The same two steps, in the same order, that
 * produced the channel.
 *
 * Idempotent, which is what lets the guard below run it over text that is already redacted: a
 * stand-in is never minted where it already occurs in the document, so no stand-in is ever an
 * original, and redacting redacted text changes nothing.
 */
function scrub(text: string, map: SurrogateMap): string {
  return applyRedaction(stripInvisible(text), map);
}

/**
 * Prepare a piece of the same document for a prompt outside the channel — a clause excerpt, a
 * heading — with the stand-ins the channel already uses, so every part of a request agrees on who
 * is who and a quote copied from either place restores to the same original text.
 *
 * Channel markers are neutralised as well: text placed outside the channel must not be able to
 * forge its boundary. Call this **before** truncating. A cut can split a name, and half a name is
 * no longer a value the map can find.
 */
export function redactExcerpt(excerpt: string, safe: SafeDocument): string {
  return stripChannelMarkers(scrub(excerpt, safe.map));
}

function refuse(task: string, message: string): ModelError {
  return new ModelError('NOT_CONFIGURED', `Task "${task}" ${message}`, { retryable: false });
}

/**
 * Wrap a model port so that the safe path is the *only* path.
 *
 * This is the point of the whole safety layer. Guardrails added at the end are a wrapper somebody
 * eventually forgets to call; a port that refuses any request whose document has not been through
 * `prepareForModel` cannot be bypassed by forgetting. The check is structural — the channel
 * markers must be present — so it fails loudly at the call site during development rather than
 * quietly in production.
 *
 * **Every field that carries text is covered, not only `document`.** The guard is bound to one
 * prepared document, and holds the whole request to its surrogate map:
 *
 *  - `systemInstruction` must be the fixed `SYSTEM_PREAMBLE`. It is the one field not scrubbed, so
 *    it is the one field that may not vary; anything else is refused.
 *  - `document` must be channel-wrapped, or the request is refused as before. The prepared channel
 *    itself passes untouched; any other wrapped text is scrubbed.
 *  - `task_input` — where clause excerpts travel — is scrubbed on every call, and so is text sent
 *    for a token count, which reaches the provider just the same.
 *
 * Why scrub rather than refuse a leak in those fields: both fail closed, since either way no
 * original the map knows leaves the process, but only one of them fails *safely*. The map replaces
 * a party's name wherever it occurs as a word, so a tenant surnamed "English" or "Short" also
 * matches this module's own fixed instructions ("plain English"). A refusal would turn that
 * coincidence into a model pass that can never run for that lease; scrubbing costs one word of
 * instruction, exactly as the channel already costs that word of the lease. Structural mistakes —
 * an unwrapped document, a different system instruction — cannot be repaired that way, so they are
 * still refused. `task` and `tier` are code-owned labels that no adapter puts in the prompt.
 *
 * The call sites redact their own excerpts (`redactExcerpt`); this is the backstop that makes the
 * property hold for a call site written tomorrow.
 */
export function createGuardedPort(port: LlmPort, safe: SafeDocument): LlmPort {
  const vet = <R extends JsonRequest<unknown> | TextRequest>(request: R): R => {
    if (request.systemInstruction !== SYSTEM_PREAMBLE) {
      throw refuse(
        request.task,
        'replaced the fixed system instruction. It is the only part of a request that is not ' +
          'redacted, so it must be SYSTEM_PREAMBLE exactly.',
      );
    }
    const { document } = request;
    if (document !== undefined && !isChannelWrapped(document)) {
      throw refuse(
        request.task,
        'passed raw document text to the model. Document text must go through ' +
          'prepareForModel() so it is redacted and channel-wrapped. This is the guarantee that the ' +
          'model never sees raw personal data.',
      );
    }
    return {
      ...request,
      // The prepared channel is redacted by construction, so it is passed on rather than rescanned.
      ...(document === undefined || document === safe.channel
        ? {}
        : { document: scrub(document, safe.map) }),
      task_input: redactExcerpt(request.task_input, safe),
    };
  };

  // Both methods must surface the refusal as a rejection rather than a synchronous throw: a
  // caller holding only a `.catch()` would otherwise take an uncaught exception.
  return {
    label: port.label,
    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      return port.generateJson(vet(request));
    },
    generateTextStream(request: TextRequest): AsyncIterable<string> {
      const source = port.generateTextStream.bind(port);
      return (async function* guarded(): AsyncGenerator<string> {
        yield* source(vet(request));
      })();
    },
    countTokens(text: string): Promise<number> {
      return port.countTokens(scrub(text, safe.map));
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
