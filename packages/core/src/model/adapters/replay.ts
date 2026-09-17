import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../budget.ts';
import { ModelError, type ModelErrorCode } from '../errors.ts';
import {
  type JsonRequest,
  type JsonResult,
  type LlmPort,
  type ModelTier,
  requestKey,
  type TextRequest,
  type Usage,
} from '../port.ts';
import { parseWithRepair } from '../validate.ts';

/**
 * The deterministic replay adapter — the load-bearing piece of the whole model layer.
 *
 * Someone cloning this repository has no Gemini key. If `pnpm test` needed one, the Testing axis
 * would read as zero however many assertions there are, so the property that matters most is:
 * **`LEXMIND_OFFLINE=1 pnpm test` passes on a fresh clone with no key and no network.**
 *
 * A cassette miss is a *hard failure*, never a fallthrough to the live adapter. That is what makes
 * it impossible for a test to quietly reach the network and start costing money or leaking a
 * document.
 */

export interface Cassette {
  /** `requestKey()` of the recorded request. */
  readonly key: string;
  readonly task: string;
  readonly tier: ModelTier;
  readonly model: string;
  /** The raw response text, exactly as the provider returned it. */
  readonly response: string;
  /** A second response, used to exercise the one-shot repair path. */
  readonly repairedResponse?: string;
  /** Streaming chunks. Falls back to one chunk of `response`. */
  readonly chunks?: readonly string[];
  readonly usage?: Usage;
  /** A recorded failure, so the error paths are testable without provoking a real one. */
  readonly error?: { readonly code: ModelErrorCode; readonly message: string };
}

/**
 * What a developer is told to run on a key miss. It names the real `package.json` script, and a test
 * holds it to that: a hint pointing at a command that does not exist costs more time than no hint.
 */
export const REGENERATE_HINT = 're-record the cassettes with `pnpm cassettes`.';

export interface ReplayOptions {
  /** Match on the task label rather than the full request key. For unit tests only. */
  readonly matchBy?: 'key' | 'task';
  readonly label?: string;
}

function usageFor(cassette: Cassette, request: JsonRequest<unknown> | TextRequest): Usage {
  if (cassette.usage !== undefined) return cassette.usage;
  const promptTokens = estimateTokens(
    [request.systemInstruction, request.document ?? '', request.task_input].join('\n\n'),
  );
  const outputTokens = estimateTokens(cassette.response);
  return {
    promptTokens,
    outputTokens,
    thoughtTokens: 0,
    cachedTokens: 0,
    totalTokens: promptTokens + outputTokens,
  };
}

export function createReplayAdapter(
  cassettes: readonly Cassette[],
  options: ReplayOptions = {},
): LlmPort {
  const matchBy = options.matchBy ?? 'key';
  const byKey = new Map<string, Cassette>();
  for (const cassette of cassettes) {
    byKey.set(matchBy === 'task' ? cassette.task : cassette.key, cassette);
  }

  const find = (request: JsonRequest<unknown> | TextRequest): Cassette => {
    const key = matchBy === 'task' ? request.task : requestKey(request);
    const cassette = byKey.get(key);
    if (cassette === undefined) {
      throw new ModelError(
        'CASSETTE_MISS',
        matchBy === 'task'
          ? `No recorded response for task "${request.task}".`
          : `No recorded response for task "${request.task}" (key ${key.slice(0, 12)}). ` +
              `The prompt or schema has changed: ${REGENERATE_HINT}`,
        {
          retryable: false,
          userMessage:
            'LexMind is running in offline mode and has no recorded AI response for this request. The rule-based analysis is unaffected.',
        },
      );
    }
    if (cassette.error !== undefined) {
      throw new ModelError(cassette.error.code, cassette.error.message, {
        retryable: cassette.error.code === 'RATE_LIMITED' || cassette.error.code === 'UNAVAILABLE',
      });
    }
    return cassette;
  };

  return {
    label: options.label ?? 'replay (offline)',

    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      const cassette = find(request);
      const { value, repaired } = await parseWithRepair(request.schema, cassette.response, () => {
        const second = cassette.repairedResponse;
        if (second === undefined) {
          throw new ModelError('MALFORMED', 'The recorded response has no repair to replay.', {
            retryable: false,
          });
        }
        return Promise.resolve(second);
      });
      return { value, usage: usageFor(cassette, request), repaired, model: cassette.model };
    },

    generateTextStream(request: TextRequest): AsyncIterable<string> {
      const cassette = find(request);
      const chunks = cassette.chunks ?? [cassette.response];
      return (async function* stream() {
        for (const chunk of chunks) {
          if (request.signal?.aborted === true) return;
          yield chunk;
        }
      })();
    },

    countTokens(text: string): Promise<number> {
      return Promise.resolve(estimateTokens(text));
    },
  };
}

/** Load every cassette in a directory. Used by CI and by the offline demo path. */
export function loadCassettes(directory: string): readonly Cassette[] {
  let names: readonly string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Cassette);
}
