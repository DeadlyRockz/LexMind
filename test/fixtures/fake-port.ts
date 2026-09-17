import { ModelError } from '../../packages/core/src/model/errors.ts';
import type {
  JsonRequest,
  JsonResult,
  LlmPort,
  TextRequest,
} from '../../packages/core/src/model/port.ts';
import { NO_USAGE, parseWithSchema } from '../../packages/core/src/model/port.ts';

/**
 * A model port that answers from a script, for tests that must see what crosses the model
 * boundary — the same pattern as the fake in `analyse/pipeline.test.ts`.
 *
 * Responses go through `parseWithSchema`, the two-stage validation a live adapter runs, so a test
 * that survives here has survived the parser the product actually uses. Every request is recorded,
 * so a test can scan exactly what would have been sent to the provider.
 */

export type Responder = (request: JsonRequest<unknown>) => unknown;

export interface FakePort extends LlmPort {
  /** Every request the pipeline made, in order. */
  readonly requests: JsonRequest<unknown>[];
}

export function fakePort(responders: Readonly<Record<string, Responder>>): FakePort {
  const requests: JsonRequest<unknown>[] = [];

  return {
    label: 'fake-model',
    requests,
    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      requests.push(request as JsonRequest<unknown>);
      const responder = responders[request.task];
      if (responder === undefined) {
        throw new ModelError('NOT_CONFIGURED', `no fake response for task "${request.task}"`, {
          retryable: false,
          userMessage: `No response was configured for "${request.task}".`,
        });
      }
      return {
        value: parseWithSchema(
          JSON.stringify(responder(request as JsonRequest<unknown>)),
          request.schema,
        ),
        usage: NO_USAGE,
        repaired: false,
        model: 'fake-model',
      };
    },
    generateTextStream(_request: TextRequest): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          throw new Error('generateTextStream is not used by analyse()');
        },
      };
    },
    countTokens: (): Promise<number> => Promise.resolve(0),
  };
}

/** Everything a request would put on the wire, as text. The schema is code, not content. */
export function serialisedRequest(request: JsonRequest<unknown>): string {
  return JSON.stringify({ ...request, schema: undefined });
}
