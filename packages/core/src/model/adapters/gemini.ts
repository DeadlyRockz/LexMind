/**
 * The Gemini adapter. **The only file in the repository that imports the vendor SDK, and the only
 * one that reads `GEMINI_API_KEY`.** A test greps for both facts.
 *
 * Every non-obvious behaviour encoded here cost someone an hour to discover, so each is recorded:
 *
 *  - **Package.** `@google/genai`. Not `@google/generative-ai` — that package was deprecated on
 *    2025-11-30 and its repository renamed to `deprecated-generative-ai-js`, yet it carries *no*
 *    npm deprecation flag, so an install prints no warning at all.
 *
 *  - **API surface.** `ai.models.generateContent({ model, contents, config })`, deliberately not
 *    `ai.interactions.*`. The SDK ships two parallel generation APIs; the newer `interactions`
 *    surface uses snake_case and **has no `temperature` / `topP` / `topK`**. LexMind needs
 *    sampling control — extraction runs at temperature 0 so it is reproducible — so it uses
 *    `models`. Mixing the two casings silently no-ops rather than erroring.
 *
 *  - **Reading the response.** `response.text` is a **getter, not a method**. `response.text()`
 *    throws `TypeError: response.text is not a function`, and it is `string | undefined` —
 *    undefined when content was blocked. Every read goes through `readText()` below, which checks
 *    `promptFeedback.blockReason` and `finishReason` *before* touching the text.
 *
 *  - **`MAX_TOKENS` is checked before parsing.** A truncated response is still valid JSON-ish
 *    text that `JSON.parse` will reject with a confusing message; the finish reason says exactly
 *    what happened.
 *
 *  - **Schema.** `responseMimeType: 'application/json'` is required alongside `responseJsonSchema`,
 *    and `responseSchema` must then be omitted. Unsupported keywords are stripped in
 *    `../schema.ts`, and the constraints they expressed are enforced in Zod after parsing.
 *
 *  - **Caching.** Implicit caching is on by default for the 2.5 series and keys on a shared
 *    prompt *prefix*, so the prompt is assembled as [stable instruction] + [document] + [task].
 *    The hit is read back from `usageMetadata.cachedContentTokenCount` and reported rather than
 *    assumed.
 *
 * This file is excluded from the coverage gate: exercising it needs a live key, and a mock of the
 * SDK would only assert that the mock behaves like the mock. Its logic is kept correspondingly
 * thin, and the behaviour that can be tested offline — schema sanitising, error classification,
 * retry, validation, repair — lives in the modules it calls.
 */
import { GoogleGenAI } from '@google/genai';
import { assertWithinPromptBudget, readBudgetConfig } from '../budget.ts';
import { classifyApiError, ModelError } from '../errors.ts';
import {
  assemblePrompt,
  type JsonRequest,
  type JsonResult,
  type LlmPort,
  type ModelTier,
  type TextRequest,
  type Usage,
} from '../port.ts';
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from '../retry.ts';
import { toGeminiSchema } from '../schema.ts';
import { parseWithRepair, repairInstruction } from '../validate.ts';

/**
 * Model ids come from the environment, never hardcoded in a call site.
 *
 * `flash-lite` for extraction is a deliberate tiering choice: thinking is off by default on that
 * model, which makes it simultaneously the cheapest and the most reproducible option for
 * structured extraction. Any id here can be corrected with one environment variable, which
 * matters because model ids drift.
 */
export function resolveModel(
  tier: ModelTier,
  env: Record<string, string | undefined> = process.env,
): string {
  return tier === 'extract'
    ? (env['LEXMIND_MODEL_EXTRACT'] ?? 'gemini-2.5-flash-lite')
    : (env['LEXMIND_MODEL_ANALYSIS'] ?? 'gemini-2.5-flash');
}

interface GeminiResponse {
  readonly text?: string | undefined;
  readonly promptFeedback?: { readonly blockReason?: string } | undefined;
  readonly candidates?: readonly { readonly finishReason?: string }[] | undefined;
  readonly usageMetadata?:
    | {
        readonly promptTokenCount?: number;
        readonly candidatesTokenCount?: number;
        readonly thoughtsTokenCount?: number;
        readonly cachedContentTokenCount?: number;
        readonly totalTokenCount?: number;
      }
    | undefined;
}

/** The one place a Gemini response is read. Checks why it might be empty before assuming text. */
export function readText(response: GeminiResponse): string {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined) {
    throw new ModelError('BLOCKED', `The provider blocked this request: ${blockReason}`, {
      retryable: false,
      userMessage:
        "The AI provider's safety filter blocked this request. LexMind's rule-based analysis is unaffected.",
    });
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    throw new ModelError('BLOCKED', `The provider blocked this response: ${finishReason}`, {
      retryable: false,
    });
  }
  if (finishReason === 'MAX_TOKENS') {
    // Checked before parsing on purpose: the JSON is truncated, so JSON.parse would throw a
    // syntax error that says nothing about the real cause.
    throw new ModelError('TRUNCATED', 'The response hit the output token cap and was cut off.', {
      retryable: false,
    });
  }

  // A getter, not a method.
  const text = response.text;
  if (text === undefined || text.length === 0) {
    throw new ModelError('MALFORMED', 'The provider returned an empty response.', {
      retryable: true,
    });
  }
  return text;
}

export function readUsage(response: GeminiResponse): Usage {
  const meta = response.usageMetadata;
  const promptTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = meta?.candidatesTokenCount ?? 0;
  const thoughtTokens = meta?.thoughtsTokenCount ?? 0;
  return {
    promptTokens,
    outputTokens,
    thoughtTokens,
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? promptTokens + outputTokens + thoughtTokens,
  };
}

export interface GeminiOptions {
  readonly apiKey?: string;
  readonly retry?: RetryPolicy;
  readonly env?: Record<string, string | undefined>;
}

export function createGeminiAdapter(options: GeminiOptions = {}): LlmPort {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env['GEMINI_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ModelError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set.', {
      retryable: false,
      userMessage:
        'No AI provider key is configured, so LexMind is running its rule-based analysis only. That still covers deposits, notice periods, entry rights, repair duties and the prohibited-clause checks.',
    });
  }

  const ai = new GoogleGenAI({ apiKey });
  const budget = readBudgetConfig(env);
  const retry = options.retry ?? DEFAULT_RETRY;

  const call = async (
    model: string,
    prompt: string,
    config: Record<string, unknown>,
  ): Promise<GeminiResponse> =>
    withRetry(async () => {
      try {
        return (await ai.models.generateContent({
          model,
          contents: prompt,
          config,
        })) as unknown as GeminiResponse;
      } catch (error) {
        throw classifyApiError(error);
      }
    }, retry);

  return {
    label: `gemini (${resolveModel('analysis', env)} / ${resolveModel('extract', env)})`,

    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      const model = resolveModel(request.tier, env);
      const prompt = assemblePrompt(request);
      assertWithinPromptBudget(prompt, budget);

      const { schema } = toGeminiSchema(request.schema);
      const config = {
        // Extraction must be reproducible; explanation may vary a little.
        temperature: request.tier === 'extract' ? 0 : 0.2,
        candidateCount: 1,
        maxOutputTokens: request.maxOutputTokens ?? budget.maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      };

      const first = await call(model, prompt, config);
      const firstText = readText(first);

      const { value, repaired } = await parseWithRepair(
        request.schema,
        firstText,
        async (error) => {
          const retryPrompt = `${prompt}\n\n${repairInstruction(error)}`;
          return readText(await call(model, retryPrompt, config));
        },
      );

      return { value, usage: readUsage(first), repaired, model };
    },

    generateTextStream(request: TextRequest): AsyncIterable<string> {
      const model = resolveModel(request.tier, env);
      const prompt = assemblePrompt(request);
      assertWithinPromptBudget(prompt, budget);

      return (async function* stream() {
        let iterator: AsyncIterable<GeminiResponse>;
        try {
          iterator = (await ai.models.generateContentStream({
            model,
            contents: prompt,
            config: {
              temperature: 0.2,
              candidateCount: 1,
              maxOutputTokens: request.maxOutputTokens ?? budget.maxOutputTokens,
            },
          })) as unknown as AsyncIterable<GeminiResponse>;
        } catch (error) {
          throw classifyApiError(error);
        }

        for await (const chunk of iterator) {
          if (request.signal?.aborted === true) return;
          const text = chunk.text;
          if (text !== undefined && text.length > 0) yield text;
        }
      })();
    },

    async countTokens(text: string): Promise<number> {
      try {
        const result = await ai.models.countTokens({
          model: resolveModel('extract', env),
          contents: text,
        });
        return result.totalTokens ?? 0;
      } catch (error) {
        throw classifyApiError(error);
      }
    },
  };
}
