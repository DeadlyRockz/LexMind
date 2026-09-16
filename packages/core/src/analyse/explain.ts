import { z } from 'zod';
import type { Clause } from '../domain/types.ts';
import { isModelError } from '../model/errors.ts';
import type { JsonRequest, LlmPort, Usage } from '../model/port.ts';
import { NO_USAGE } from '../model/port.ts';
import { SYSTEM_PREAMBLE } from '../safety/injection.ts';
import type { SafeDocument } from '../safety/index.ts';
import { truncateWords } from '../util/text.ts';

/**
 * The model pass: plain-English explanation per clause.
 *
 * Note what this asks for and what it does not. It asks the model to say **what a clause means**
 * and to **quote the document** while doing it. It never asks whether the clause is lawful,
 * whether a cap is exceeded, or what the reader should do — those are computed in code against a
 * cited rule, or refused.
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

export const ClauseExplanationsSchema = z.object({
  explanations: z.array(ClauseExplanationSchema).max(60),
});

export type ClauseExplanation = z.infer<typeof ClauseExplanationSchema>;

export const LeaseSummarySchema = z.object({
  /** One short paragraph the reader sees first. */
  overview: z.string().min(40),
  money: z.string().min(20),
  timing: z.string().min(20),
  obligations: z.string().min(20),
  exit: z.string().min(20),
});

export type LeaseSummary = z.infer<typeof LeaseSummarySchema>;

export interface ExplainOutcome {
  readonly explanations: readonly ClauseExplanation[];
  readonly usage: Usage;
  /** Why the model pass produced nothing, when it did. Shown to the reader, not swallowed. */
  readonly note: string | null;
}

/** Keep the request bounded: the clauses that matter, not all eighty. */
const MAX_CLAUSES_PER_REQUEST = 24;
const CLAUSE_EXCERPT_CHARS = 900;

function clauseLabel(clause: Clause): string {
  if (clause.heading !== null) return clause.heading;
  const numbered = clause.path.join('.');
  return numbered.length > 0 ? numbered : 'unheaded';
}

function clauseList(clauses: readonly Clause[]): string {
  return clauses
    .slice(0, MAX_CLAUSES_PER_REQUEST)
    .map(
      (clause) =>
        `[${clause.id}] ${clauseLabel(clause)}\n${truncateWords(clause.text, CLAUSE_EXCERPT_CHARS)}`,
    )
    .join('\n\n');
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
 */
export async function explainClauses(
  port: LlmPort,
  safe: SafeDocument,
  clauses: readonly Clause[],
): Promise<ExplainOutcome> {
  if (clauses.length === 0) return { explanations: [], usage: NO_USAGE, note: null };

  const request: JsonRequest<z.infer<typeof ClauseExplanationsSchema>> = {
    task: 'explain-clauses',
    tier: 'analysis',
    systemInstruction: SYSTEM_PREAMBLE,
    document: safe.channel,
    task_input: `${EXPLAIN_TASK}\n\nClauses to explain:\n\n${clauseList(clauses)}`,
    schema: ClauseExplanationsSchema,
  };

  try {
    const result = await port.generateJson(request);
    return { explanations: result.value.explanations, usage: result.usage, note: null };
  } catch (error) {
    return {
      explanations: [],
      usage: NO_USAGE,
      note: isModelError(error)
        ? error.userMessage
        : 'The plain-English explanations could not be generated. The findings below are unaffected.',
    };
  }
}

export interface SummaryOutcome {
  readonly summary: LeaseSummary | null;
  readonly usage: Usage;
  readonly note: string | null;
}

const SUMMARY_TASK = [
  'Write a one-page plain-English summary of this tenancy agreement for the tenant, in five parts:',
  '',
  '  overview    - two or three sentences on what this agreement is and how long it runs.',
  '  money       - what the tenant pays, when, and what is held as a deposit.',
  '  timing      - key dates and notice periods.',
  '  obligations - what each party must do, kept short.',
  '  exit        - how the tenancy ends, for each party.',
  '',
  'Short sentences, one idea each, eighth-grade reading level. Describe only what the document says.',
  'Do not state what the law requires, do not say whether anything is enforceable, and do not',
  'recommend a course of action. Where the document is silent on something, say it is not mentioned.',
].join('\n');

export async function summariseLease(
  port: LlmPort,
  safe: SafeDocument,
): Promise<SummaryOutcome> {
  try {
    const result = await port.generateJson({
      task: 'summarise-lease',
      tier: 'analysis',
      systemInstruction: SYSTEM_PREAMBLE,
      document: safe.channel,
      task_input: SUMMARY_TASK,
      schema: LeaseSummarySchema,
    });
    return { summary: result.value, usage: result.usage, note: null };
  } catch (error) {
    return {
      summary: null,
      usage: NO_USAGE,
      note: isModelError(error)
        ? error.userMessage
        : 'The plain-English summary could not be generated.',
    };
  }
}
