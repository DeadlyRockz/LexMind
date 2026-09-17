import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readText, readUsage, resolveModel } from './adapters/gemini.ts';
import { createReplayAdapter, REGENERATE_HINT } from './adapters/replay.ts';
import { assertWithinPromptBudget, cacheHitRate, estimateTokens, recordUsage } from './budget.ts';
import { classifyApiError, isModelError } from './errors.ts';
import { selectModel } from './index.ts';
import { assemblePrompt, parseWithSchema, requestKey } from './port.ts';
import { backoffDelay, withRetry } from './retry.ts';
import { assertGeminiSafeSchema, schemaFingerprint, toGeminiSchema } from './schema.ts';
import { parseWithRepair } from './validate.ts';

const FactsSchema = z.object({
  depositAmount: z.number().nullable(),
  currency: z.string().min(1).nullable(),
  quote: z.string().min(12),
});

describe('Gemini-safe schema conversion', () => {
  it('strips the keywords Gemini accepts and silently ignores', () => {
    const { schema, stripped } = toGeminiSchema(FactsSchema);
    expect(JSON.stringify(schema)).not.toMatch(/minLength/);
    expect(JSON.stringify(schema)).not.toMatch(/\$schema/);
    expect(stripped.join(' ')).toMatch(/minLength/);
  });

  it('strips the top-level $schema, which silently re-routes the SDK to a different field', () => {
    const { schema } = toGeminiSchema(z.object({ a: z.string() }));
    expect(Object.keys(schema)).not.toContain('$schema');
  });

  it('rejects a schema carrying an ignored keyword', () => {
    expect(() => assertGeminiSafeSchema({ type: 'string', pattern: '^[a-z]+$' })).toThrow(
      /silently ignores/,
    );
    expect(() =>
      assertGeminiSafeSchema({ type: 'object', properties: { a: { minLength: 3 } } }),
    ).toThrow(/minLength/);
  });

  it('walks arrays of subschemas and names the offending index', () => {
    expect(() =>
      assertGeminiSafeSchema({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'string', minLength: 1 }],
      }),
    ).toThrow(/Schema at \$\.prefixItems\[1\] uses "minLength"/);
  });

  it('accepts a schema using only supported keywords', () => {
    expect(() =>
      assertGeminiSafeSchema({
        type: 'object',
        properties: { n: { type: 'number', minimum: 0 }, e: { type: 'string', enum: ['a'] } },
        required: ['n'],
      }),
    ).not.toThrow();
  });

  it('enforces in Zod what the provider would have ignored', () => {
    // `minLength: 12` never reaches the provider, so this is the only thing standing between a
    // four-character "quote" and a citation the reader will trust.
    expect(() =>
      parseWithSchema('{"depositAmount":1,"currency":"INR","quote":"short"}', FactsSchema),
    ).toThrow(/did not match the expected shape/);
  });

  it('fingerprints a schema stably, so a cassette key changes only when the shape does', () => {
    expect(schemaFingerprint(FactsSchema)).toBe(schemaFingerprint(FactsSchema));
    expect(schemaFingerprint(FactsSchema)).not.toBe(schemaFingerprint(z.object({ a: z.string() })));
  });
});

describe('prompt assembly', () => {
  const request = {
    task: 'extract',
    tier: 'extract' as const,
    systemInstruction: 'STABLE INSTRUCTION',
    document: 'THE LEASE',
    task_input: 'THE QUESTION',
    schema: FactsSchema,
  };

  it('orders the prompt stable-instruction, document, task so the prefix cache can hit', () => {
    const prompt = assemblePrompt(request);
    expect(prompt.indexOf('STABLE INSTRUCTION')).toBeLessThan(prompt.indexOf('THE LEASE'));
    expect(prompt.indexOf('THE LEASE')).toBeLessThan(prompt.indexOf('THE QUESTION'));
  });

  it('keys a request on tier, task, prompt and schema shape', () => {
    expect(requestKey(request)).toBe(requestKey(request));
    expect(requestKey({ ...request, task_input: 'OTHER' })).not.toBe(requestKey(request));
    expect(requestKey({ ...request, schema: z.object({ a: z.string() }) })).not.toBe(
      requestKey(request),
    );
  });
});

describe('error classification', () => {
  it('backs off on a rate limit but never on an exhausted daily quota', () => {
    const rate = classifyApiError({ status: 429, message: 'rate_limit_exceeded, slow down' });
    expect(rate.code).toBe('RATE_LIMITED');
    expect(rate.retryable).toBe(true);

    const quota = classifyApiError({ status: 429, message: 'quota_exceeded for the day' });
    expect(quota.code).toBe('QUOTA_EXHAUSTED');
    expect(quota.retryable).toBe(false);
    expect(quota.userMessage).toMatch(/rule-based analysis still works/i);
  });

  it('retries transient failures and not permanent ones', () => {
    expect(classifyApiError({ status: 503, message: 'unavailable' }).retryable).toBe(true);
    expect(classifyApiError({ status: 408, message: 'timeout' }).retryable).toBe(true);
    expect(classifyApiError({ status: 403, message: 'forbidden' }).retryable).toBe(false);
    expect(classifyApiError({ status: 400, message: 'bad' }).retryable).toBe(false);
  });

  it('never leaks a provider message into what the reader sees', () => {
    expect(
      classifyApiError({ status: 500, message: 'internal trace xyz' }).userMessage,
    ).not.toMatch(/xyz/);
  });
});

describe('retry', () => {
  const policy = {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  };

  it('grows the delay exponentially and caps it', () => {
    expect(backoffDelay(1, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(200);
    expect(backoffDelay(3, policy, () => 1)).toBe(400);
    expect(backoffDelay(9, policy, () => 1)).toBe(1000);
  });

  it('applies full jitter so concurrent callers do not re-collide', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
  });

  it('retries a rate limit and then succeeds', async () => {
    let calls = 0;
    const value = await withRetry(() => {
      calls += 1;
      if (calls < 3) throw classifyApiError({ status: 429, message: 'rate_limit_exceeded' });
      return Promise.resolve('ok');
    }, policy);
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('makes exactly zero retries on an exhausted quota', async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls += 1;
        throw classifyApiError({ status: 429, message: 'quota_exceeded' });
      }, policy),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(calls, 'retrying a daily cap is pure waste').toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls += 1;
        throw classifyApiError({ status: 503, message: 'down' });
      }, policy),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toBe(policy.maxAttempts);
  });
});

describe('validation and repair', () => {
  const schema = z.object({ n: z.number() });

  it('parses valid output with no repair', async () => {
    const result = await parseWithRepair(schema, '{"n":1}', () => {
      throw new Error('repair must not be called');
    });
    expect(result).toEqual({ value: { n: 1 }, repaired: false });
  });

  it('repairs exactly once, feeding the validation error back', async () => {
    const repair = vi.fn((_validationError: string) => Promise.resolve('{"n":2}'));
    const result = await parseWithRepair(schema, 'not json at all', repair);
    expect(result.value).toEqual({ n: 2 });
    expect(result.repaired).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
  });

  it('fails closed after a second failure rather than showing a half-parsed result', async () => {
    const repair = vi.fn((_validationError: string) => Promise.resolve('still not json'));
    await expect(parseWithRepair(schema, 'not json', repair)).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('tells the reader the rule-based findings are unaffected', async () => {
    try {
      await parseWithRepair(schema, 'bad', () => Promise.resolve('worse'));
      expect.unreachable();
    } catch (error) {
      expect(isModelError(error) && error.userMessage).toMatch(
        /rule-based findings are unaffected/,
      );
    }
  });
});

describe('reading a Gemini response', () => {
  it('reads text from the getter', () => {
    expect(readText({ text: 'hello', candidates: [{ finishReason: 'STOP' }] })).toBe('hello');
  });

  it('reports a blocked prompt before looking at the text', () => {
    expect(() => readText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/blocked/);
  });

  it('reports a truncated response before JSON.parse can throw a confusing error', () => {
    expect(() => readText({ text: '{"a":', candidates: [{ finishReason: 'MAX_TOKENS' }] })).toThrow(
      /output token cap/,
    );
  });

  it('treats undefined text as malformed rather than crashing', () => {
    expect(() => readText({ candidates: [{ finishReason: 'STOP' }] })).toThrow(/empty response/);
  });

  it('reads every usage counter the provider reports', () => {
    const usage = readUsage({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 60,
        totalTokenCount: 125,
      },
    });
    expect(usage).toEqual({
      promptTokens: 100,
      outputTokens: 20,
      thoughtTokens: 5,
      cachedTokens: 60,
      totalTokens: 125,
    });
    expect(cacheHitRate(usage)).toBe(0.6);
  });

  it('tiers models by job, from the environment', () => {
    const env = { LEXMIND_MODEL_ANALYSIS: 'a-model', LEXMIND_MODEL_EXTRACT: 'cheap-model' };
    expect(resolveModel('analysis', env)).toBe('a-model');
    expect(resolveModel('extract', env)).toBe('cheap-model');
    // The default extract tier is flash-lite: thinking is off by default, so it is both the
    // cheapest and the most reproducible choice for structured extraction.
    expect(resolveModel('extract', {})).toMatch(/flash-lite/);
  });
});

describe('the replay adapter', () => {
  const request = {
    task: 'extract-facts',
    tier: 'extract' as const,
    systemInstruction: 'sys',
    document: 'doc',
    task_input: 'task',
    schema: z.object({ n: z.number() }),
  };

  it('replays a recorded response', async () => {
    const adapter = createReplayAdapter([
      {
        key: requestKey(request),
        task: request.task,
        tier: 'extract',
        model: 'm',
        response: '{"n":7}',
      },
    ]);
    const result = await adapter.generateJson(request);
    expect(result.value).toEqual({ n: 7 });
    expect(result.usage.promptTokens).toBeGreaterThan(0);
  });

  it('makes a cassette miss a hard failure, so a test can never reach the network', async () => {
    const adapter = createReplayAdapter([]);
    await expect(adapter.generateJson(request)).rejects.toMatchObject({ code: 'CASSETTE_MISS' });
  });

  it('says "re-record" rather than "the model is broken" when the prompt has changed', async () => {
    const adapter = createReplayAdapter([
      {
        key: requestKey(request),
        task: request.task,
        tier: 'extract',
        model: 'm',
        response: '{"n":1}',
      },
    ]);
    try {
      await adapter.generateJson({ ...request, task_input: 'a different task' });
      expect.unreachable();
    } catch (error) {
      expect(isModelError(error) && error.message).toMatch(/re-record/);
      expect(isModelError(error) && error.message).toContain(REGENERATE_HINT);
    }
  });

  it('names a command that exists — the hint once pointed at a script nobody had written', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    const command = /`pnpm ([\w:-]+)`/.exec(REGENERATE_HINT)?.[1];

    expect(command).toBe('cassettes');
    expect(manifest.scripts[command ?? '']).toBe(
      'node --experimental-strip-types scripts/cassettes.ts',
    );
    expect(REGENERATE_HINT).not.toContain('cassettes:record');
  });

  it('replays a recorded malformed response and its one repair', async () => {
    const adapter = createReplayAdapter([
      {
        key: requestKey(request),
        task: request.task,
        tier: 'extract',
        model: 'm',
        response: 'not json',
        repairedResponse: '{"n":3}',
      },
    ]);
    const result = await adapter.generateJson(request);
    expect(result.value).toEqual({ n: 3 });
    expect(result.repaired).toBe(true);
  });

  it('replays a recorded provider failure', async () => {
    const adapter = createReplayAdapter([
      {
        key: requestKey(request),
        task: request.task,
        tier: 'extract',
        model: 'm',
        response: '',
        error: { code: 'QUOTA_EXHAUSTED', message: 'daily cap' },
      },
    ]);
    await expect(adapter.generateJson(request)).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
  });

  it('streams recorded chunks and stops when aborted', async () => {
    const adapter = createReplayAdapter(
      [
        {
          key: 'unused-when-matching-by-task',
          task: 'explain',
          tier: 'analysis',
          model: 'm',
          response: 'abc',
          chunks: ['a', 'b', 'c'],
        },
      ],
      { matchBy: 'task' },
    );

    const collected: string[] = [];
    for await (const chunk of adapter.generateTextStream({
      task: 'explain',
      tier: 'analysis',
      systemInstruction: 'sys',
      task_input: 'task',
    })) {
      collected.push(chunk);
    }
    expect(collected).toEqual(['a', 'b', 'c']);

    const controller = new AbortController();
    controller.abort();
    const aborted: string[] = [];
    for await (const chunk of adapter.generateTextStream({
      task: 'explain',
      tier: 'analysis',
      systemInstruction: 'sys',
      task_input: 'task',
      signal: controller.signal,
    })) {
      aborted.push(chunk);
    }
    expect(aborted).toEqual([]);
  });
});

describe('selectModel', () => {
  it('prefers offline mode even when a key is present, so CI can never call out', async () => {
    const selection = await selectModel({
      env: { LEXMIND_OFFLINE: '1', GEMINI_API_KEY: 'would-work' },
      cassettes: [],
    });
    expect(selection.offline).toBe(true);
    expect(selection.reason).toMatch(/offline/);
  });

  it('returns a cleanly-refusing adapter when no key is configured', async () => {
    const selection = await selectModel({ env: {} });
    expect(selection.offline).toBe(true);
    await expect(selection.port.countTokens('x')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('refuses a text stream on the first pull, not when the stream is requested', async () => {
    const selection = await selectModel({ env: {} });
    const stream = selection.port.generateTextStream({
      task: 't',
      tier: 'analysis',
      systemInstruction: 's',
      task_input: 'i',
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    // Like any finished generator, it stays finished rather than refusing a second time.
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('explains that rule-based findings still work when there is no model', async () => {
    const selection = await selectModel({ env: {} });
    try {
      await selection.port.generateJson({
        task: 't',
        tier: 'extract',
        systemInstruction: 's',
        task_input: 'i',
        schema: z.object({}),
      });
      expect.unreachable();
    } catch (error) {
      expect(isModelError(error) && error.userMessage).toMatch(/computed locally and unaffected/);
    }
  });
});

describe('token budget', () => {
  it('refuses an over-budget prompt before it is sent', () => {
    expect(() =>
      assertWithinPromptBudget('x'.repeat(500_000), {
        maxPromptTokens: 1000,
        maxOutputTokens: 100,
      }),
    ).toThrow(/over the 1,000 ceiling/);
  });

  it('accepts a normal lease and returns the estimate', () => {
    const estimate = assertWithinPromptBudget('word '.repeat(4000), {
      maxPromptTokens: 120_000,
      maxOutputTokens: 4096,
    });
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(120_000);
  });

  it('estimates zero tokens for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('accumulates usage per task for the efficiency report', () => {
    const usage = {
      promptTokens: 10,
      outputTokens: 2,
      thoughtTokens: 0,
      cachedTokens: 5,
      totalTokens: 12,
    };
    let meter = recordUsage(
      {
        total: {
          promptTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
        },
        byTask: new Map(),
        calls: 0,
      },
      'extract',
      usage,
    );
    meter = recordUsage(meter, 'extract', usage);
    expect(meter.calls).toBe(2);
    expect(meter.total.promptTokens).toBe(20);
    expect(meter.byTask.get('extract')?.promptTokens).toBe(20);
  });
});
