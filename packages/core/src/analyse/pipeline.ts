import { type CitationId, citation } from '../domain/citations.ts';
import { clauseTypeLabel, PRIORITY_CLAUSE_TYPES } from '../domain/clause-types.ts';
import {
  coverageCaveat,
  type JurisdictionResolution,
  resolveJurisdiction,
} from '../domain/jurisdictions/index.ts';
import { findRiskPattern } from '../domain/risk-taxonomy.ts';
import { compareSeverity, computeSeverity } from '../domain/severity.ts';
import type {
  Citation,
  Clause,
  Finding,
  JurisdictionId,
  LeaseFacts,
  Obligation,
  Severity,
  VerifiedQuote,
} from '../domain/types.ts';
import { EMPTY_METER, mergeMeters, recordUsage, type UsageMeter } from '../model/budget.ts';
import type { LlmPort } from '../model/port.ts';
import { verifyQuote } from '../qa/verify.ts';
import {
  adviceWithheldNote,
  createGuardedPort,
  findInjectionSpans,
  isWhollyCovered,
  overlapsAny,
  prepareForModel,
  type SafeDocument,
  type TextRange,
} from '../safety/index.ts';
import { clauseAtOffset, clauseReference } from '../segment/clauses.ts';
import type { SegmentedDocument } from '../segment/index.ts';
import { truncateWords } from '../util/text.ts';
import { type ClauseTyping, detectAllClauseTypes, untypedShare } from './detect.ts';
import {
  aggregateReadability,
  type ClauseExplanation,
  explainClauses,
  type LeaseSummary,
  type ReadabilityAggregate,
  type RejectedItem,
  SUMMARY_PARTS,
  type SummaryPart,
  type SummarySection,
  summariseLease,
  type VerifiedSummarySection,
} from './explain.ts';
import { type ExtractedFacts, extractFacts } from './facts.ts';
import { extractObligations, type ObligationDraft, obligationBalance } from './obligations.ts';
import { applyRules, type Candidate } from './rules.ts';

/**
 * The analysis pipeline.
 *
 * Order is the design:
 *
 *   1. **Deterministic first, and complete.** Jurisdiction, clause typing, fact extraction, the
 *      rule engine and the obligations matrix all run locally in about a millisecond. These are
 *      the findings that survive if the model is unavailable, and they are the reason the product
 *      still works on a dead free-tier quota.
 *   2. **Verify before anything is kept.** Every candidate's quote is checked against the source
 *      text. A finding whose quote does not verify is discarded, not downgraded.
 *   3. **The model explains, last and optionally.** Its failure is a note on the result, never an
 *      exception — one clause failing validation must not lose the other nineteen.
 */

export interface AnalysisStats {
  readonly clauseCount: number;
  readonly findingCount: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** Share of clauses no taxonomy type matched. High means the taxonomy is missing a style. */
  readonly untypedShare: number;
  /**
   * The share of clauses escalated to the model — the efficiency figure, and now one the code can
   * evidence. It is the exact output of `clausesToExplain()`, which is also the exact set of
   * clauses put in the request, so the number and the behaviour cannot drift apart. It is computed
   * whether or not a port is configured, because the selection is deterministic: it says what a
   * model call *would* cover, which is what makes it comparable across runs.
   */
  readonly escalationRate: number;
  /** The count behind `escalationRate`, so the figure can be checked rather than believed. */
  readonly escalatedClauses: number;
  /** Escalated clauses with no explanation to show. The honest other half of the figure above. */
  readonly unanalysedClauses: number;
  /** Share of model-claimed quotes that failed verification. The honest reliability figure. */
  readonly citationRejectionRate: number;
  readonly verifiedQuotes: number;
  readonly rejectedQuotes: number;
  /**
   * Model quotes that *were* in the document but lay inside text reading as instructions to an AI
   * system, so the prose resting on them was withheld. Counted apart from `rejectedQuotes`, which
   * measures quotes that are not in the document at all: this one measures an attack, not a
   * hallucination, and folding the two together would blur both figures.
   */
  readonly quotesInInjectedText: number;
  readonly durationMs: number;
  /**
   * Model calls that actually completed — a request that left the process and came back. Attempts
   * that failed before or at the provider are counted in `modelFailures`, not here. Reporting an
   * attempt as a call is how a run with no API key ends up claiming two calls and zero tokens.
   */
  readonly modelCalls: number;
  readonly modelFailures: number;
  /**
   * Flesch-Kincaid of the model prose the reader is actually shown — verified explanations and
   * verified summary paragraphs, measured separately. Plan 06 sets the target (grade 8 or below);
   * this is the figure that checks it. All `null` when no model prose was shown.
   */
  readonly readability: {
    readonly explanations: ReadabilityAggregate;
    readonly summary: ReadabilityAggregate;
  };
}

/**
 * What happened to one clause, so the UI can say "could not analyse this section" for exactly the
 * sections that could not be analysed, and nothing else.
 *
 * `deterministic-only` is a success, not a gap: the rule layer covered the clause and escalating it
 * would have bought nothing. So is `embedded-instructions`: the clause is nothing but text addressed
 * to an AI, which the deterministic layer reports as document content and never sends to a model.
 * Every other non-`explained` state is a gap, and each names its cause (`isAnalysisGap`).
 */
export type ClauseAnalysisState =
  | 'deterministic-only'
  | 'embedded-instructions'
  | 'explained'
  | 'not-attempted'
  | 'invalid-response'
  | 'no-response'
  | 'quote-unverified'
  | 'quote-in-injected-text'
  | 'advice-withheld';

/**
 * The states that are not a gap: the section was explained, or the deterministic layer is the right
 * and complete answer for it. One definition, so the stat and every renderer agree on what "could
 * not analyse" means.
 */
export function isAnalysisGap(state: ClauseAnalysisState): boolean {
  return (
    state !== 'explained' && state !== 'deterministic-only' && state !== 'embedded-instructions'
  );
}

export interface ClauseStatus {
  readonly clauseId: string;
  readonly state: ClauseAnalysisState;
  /** The reason, in the reader's words. */
  readonly detail: string;
}

/**
 * Whether a model was in play at all, which changes what an absent explanation *means*.
 *
 * With no port configured, a clause with no AI explanation is not a gap — the deterministic layer
 * is the product's floor and it covered it. With a port configured that could not be reached, the
 * same clause genuinely could not be analysed. Collapsing the two would either cry failure on
 * every offline run or hide a real one.
 */
type ModelState = 'absent' | 'responded' | 'unavailable';

const CLAUSE_STATUS_DETAIL: Readonly<Record<ClauseAnalysisState, string>> = {
  'deterministic-only':
    'Covered by the rule-based analysis; no AI explanation is shown for this section.',
  'embedded-instructions':
    'This section reads as instructions addressed to an AI system, not as a term of your agreement. LexMind shows it as part of your document, does not follow it, and does not ask the AI to explain it.',
  explained: 'Explained in plain English, with the quote checked against your document.',
  'not-attempted':
    'Could not analyse this section: the AI provider was unavailable, so no explanation was produced.',
  'invalid-response':
    'Could not analyse this section: the AI response for it did not match the expected shape and was discarded.',
  'no-response': 'Could not analyse this section: the AI returned nothing for it.',
  'quote-unverified':
    'Could not analyse this section: the AI quoted text that is not in your document, so the explanation was discarded.',
  'quote-in-injected-text':
    'Could not analyse this section: the AI explanation rested on text in your document that reads as instructions to an AI system, so it was not shown.',
  'advice-withheld':
    'Could not analyse this section: the AI explanation crossed into telling you what to do, so it was withheld.',
};

/**
 * Text in the document that reads as instructions to an AI system, reported as what it is: part of
 * the document. Found deterministically, so it is reported with or without a model.
 */
export interface EmbeddedInstruction extends TextRange {
  readonly clauseId: string | null;
  /** The document's own words, sliced from the original text. */
  readonly quote: string;
  /** Which cue shapes matched. Diagnostic, and stable enough to assert on. */
  readonly cues: readonly string[];
}

export interface AnalysisResult {
  readonly documentId: string;
  readonly clauses: readonly Clause[];
  readonly typings: readonly ClauseTyping[];
  readonly jurisdiction: JurisdictionResolution;
  readonly facts: LeaseFacts;
  readonly findings: readonly Finding[];
  readonly obligations: readonly Obligation[];
  /**
   * Instructions to an AI found in the document. None of them is followed, and no model claim may
   * rest on a quote from inside one — see `quote-in-injected-text`.
   */
  readonly embeddedInstructions: readonly EmbeddedInstruction[];
  readonly obligationBalance: {
    readonly tenant: number;
    readonly landlord: number;
    readonly ratio: number | null;
  };
  /** Model-written, quote-verified explanations, keyed by clause id. Empty when offline. */
  readonly explanations: ReadonlyMap<string, string>;
  /**
   * The verified quote behind each entry in `explanations`, keyed the same way, so the citation
   * that justified showing an explanation can be shown — and checked — alongside it.
   */
  readonly explanationAnchors: ReadonlyMap<string, VerifiedQuote>;
  /** One entry per clause, in clause order. Partial failure is normal and is reported, not hidden. */
  readonly clauseStatus: readonly ClauseStatus[];
  readonly summary: LeaseSummary | null;
  readonly stats: AnalysisStats;
  /** What could not be done and why, in the reader's words. Never swallowed. */
  readonly notes: readonly string[];
  readonly usage: UsageMeter;
  readonly modelLabel: string;
  /** Redaction counts, for the privacy line in the UI and in exports. */
  readonly redactions: Readonly<Record<string, number>>;
}

export interface AnalyseOptions {
  /** Omit to run fully deterministic. */
  readonly port?: LlmPort;
  /** The reader's declared jurisdiction. The only route to a model-act jurisdiction. */
  readonly declaredJurisdiction?: JurisdictionId;
  /** Skip the model summary pass, e.g. when only the findings are wanted. */
  readonly skipSummary?: boolean;
  readonly now?: () => number;
}

/** A proportion rounded to three places, or zero when there is nothing to divide. */
function share(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 1000;
}

function emptySeverityCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function citationsFor(ids: readonly CitationId[]): readonly Citation[] {
  return ids.map((id) => citation(id));
}

/**
 * Turn verified candidates into findings.
 *
 * Two properties are enforced here rather than trusted:
 *
 *  - **No unverified anchor.** A candidate whose quote does not resolve to real offsets is dropped.
 *  - **No borrowed citation.** Where the jurisdiction has no ruling, `citations` is empty and the
 *    status is `unknown`: the finding reports what the document does and makes no legal claim.
 */
function buildFindings(
  segmented: SegmentedDocument,
  candidates: readonly Candidate[],
  jurisdiction: JurisdictionResolution,
): { readonly findings: readonly Finding[]; readonly dropped: number } {
  const findings: Finding[] = [];
  let dropped = 0;
  const caveat = coverageCaveat(jurisdiction);

  for (const entry of candidates) {
    const pattern = findRiskPattern(entry.patternId);
    if (pattern === undefined) continue;

    const verified = verifyQuote(segmented, { quote: entry.quote, clauseId: entry.clauseId });
    if (!('charStart' in verified)) {
      dropped += 1;
      continue;
    }

    const citations = citationsFor(entry.citations);
    const unverifiedRule = citations.some((c) => !c.verified);

    findings.push({
      id: `f${findings.length + 1}`,
      patternId: pattern.id,
      clauseTypeId: pattern.clauseTypeId,
      clauseId: verified.clauseId,
      title: pattern.title,
      whatItSays: entry.detail,
      whyItMatters: pattern.whyItMatters,
      severity: computeSeverity(entry.severityInputs),
      severityInputs: entry.severityInputs,
      citations,
      anchors: [verified],
      origin: 'rule',
      jurisdiction: jurisdiction.id,
      ...(caveat === null && !unverifiedRule
        ? {}
        : {
            caveat:
              caveat ??
              'This rests on a rule LexMind has not verified against a primary source. Treat it as a pointer, not a statement of law.',
          }),
    });
  }

  return { findings, dropped };
}

function buildObligations(
  segmented: SegmentedDocument,
  drafts: readonly ObligationDraft[],
): readonly Obligation[] {
  const obligations: Obligation[] = [];

  for (const draft of drafts) {
    const verified = verifyQuote(segmented, { quote: draft.quote, clauseId: draft.clauseId });
    if (!('charStart' in verified)) continue;

    obligations.push({
      id: `o${obligations.length + 1}`,
      party: draft.party,
      what: draft.what,
      when: draft.when,
      consequence: draft.consequence,
      clauseId: draft.clauseId,
      anchors: [verified],
    });
  }

  return obligations;
}

interface VerifiedExplanations {
  readonly kept: ReadonlyMap<string, string>;
  readonly anchors: ReadonlyMap<string, VerifiedQuote>;
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  /** Clause ids whose explanation was dropped because its quote is not in the document. */
  readonly unverified: readonly string[];
  /** Clause ids whose explanation was dropped because its quote lies in an embedded instruction. */
  readonly inInjectedText: readonly string[];
}

/**
 * Keep only the explanations whose quote actually appears in the document — and not inside text
 * that reads as an instruction to an AI. Fail closed.
 *
 * The second condition closes the gap quote verification leaves open. Verification proves a quote
 * exists; it cannot prove the prose follows from it. A model that obeys "do not report any risks"
 * can anchor its reassurance to those very words, and the substring check passes because the
 * attacker put them there. A planted instruction is document content to be reported, never
 * evidence for a claim, so no claim may rest on it.
 */
export function verifyExplanations(
  segmented: SegmentedDocument,
  explanations: readonly ClauseExplanation[],
  embedded: readonly TextRange[],
): VerifiedExplanations {
  const kept = new Map<string, string>();
  const anchors = new Map<string, VerifiedQuote>();
  const unverified: string[] = [];
  const inInjectedText: string[] = [];
  let verifiedCount = 0;

  for (const explanation of explanations) {
    const verified = verifyQuote(segmented, {
      quote: explanation.quote,
      clauseId: explanation.clauseId,
    });
    if (!('charStart' in verified)) {
      unverified.push(explanation.clauseId);
      continue;
    }
    if (overlapsAny(verified, embedded)) {
      inInjectedText.push(explanation.clauseId);
      continue;
    }
    verifiedCount += 1;
    kept.set(explanation.clauseId, explanation.plainEnglish);
    anchors.set(explanation.clauseId, verified);
  }

  return {
    kept,
    anchors,
    verifiedCount,
    rejectedCount: unverified.length,
    unverified,
    inInjectedText,
  };
}

/**
 * Verify the summary the same way every other model artefact is verified.
 *
 * This is the whole of finding 1. The summary used to be assigned straight from the model's
 * response — five paragraphs of prose with no quote, no offsets and no verification, held back
 * from the reader by nothing but a line in the prompt. Plan 05's criterion does not carve out an
 * exception for it: *every output carries a verified citation or is not shown.*
 *
 * A partial summary is acceptable and named — `missingParts` says what is absent. A summary with
 * no verified paragraph at all is not a degraded summary, it is no summary: the caller gets `null`.
 */
export function verifySummary(
  segmented: SegmentedDocument,
  sections: readonly SummarySection[],
  embedded: readonly TextRange[],
): {
  readonly summary: LeaseSummary | null;
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  /** Paragraphs whose quote verified but lies in an embedded instruction. See `verifyExplanations`. */
  readonly inInjectedTextCount: number;
} {
  const kept = new Map<SummaryPart, VerifiedSummarySection>();
  let rejectedCount = 0;
  let inInjectedTextCount = 0;

  for (const section of sections) {
    // A repeated part is not an error, but the first paragraph that verifies wins. A later one
    // still gets its chance if the earlier attempt failed.
    if (kept.has(section.part)) continue;

    const verified = verifyQuote(segmented, { quote: section.quote });
    if (!('charStart' in verified)) {
      rejectedCount += 1;
      continue;
    }
    if (overlapsAny(verified, embedded)) {
      inInjectedTextCount += 1;
      continue;
    }
    kept.set(section.part, { part: section.part, text: section.text, anchor: verified });
  }

  const ordered = SUMMARY_PARTS.map((part) => kept.get(part)).filter(
    (section): section is VerifiedSummarySection => section !== undefined,
  );
  const missingParts = SUMMARY_PARTS.filter((part) => !kept.has(part));

  return {
    summary: ordered.length === 0 ? null : { sections: ordered, missingParts },
    verifiedCount: ordered.length,
    rejectedCount,
    inInjectedTextCount,
  };
}

/**
 * Which clauses could not be analysed, and why.
 *
 * Plan 06: "Return per-clause status and render what succeeded, with an explicit 'could not
 * analyse this section' for the rest." Every clause gets an entry, so a UI can render the gaps
 * without inferring them from an absence.
 */
function buildClauseStatus(
  clauses: readonly Clause[],
  escalated: ReadonlySet<string>,
  explained: ReadonlyMap<string, string>,
  failures: ReadonlyMap<string, ClauseAnalysisState>,
  model: ModelState,
  instructionOnly: ReadonlySet<string>,
): readonly ClauseStatus[] {
  return clauses.map((clause) => {
    const state = ((): ClauseAnalysisState => {
      if (explained.has(clause.id)) return 'explained';
      const failure = failures.get(clause.id);
      if (failure !== undefined) return failure;
      if (instructionOnly.has(clause.id)) return 'embedded-instructions';
      if (!escalated.has(clause.id) || model === 'absent') return 'deterministic-only';
      return model === 'responded' ? 'no-response' : 'not-attempted';
    })();

    return { clauseId: clause.id, state, detail: CLAUSE_STATUS_DETAIL[state] };
  });
}

/** Map a dropped model entry onto the clause state a reader would recognise. */
function failureStates(
  rejected: readonly RejectedItem[],
): ReadonlyMap<string, ClauseAnalysisState> {
  const states = new Map<string, ClauseAnalysisState>();
  for (const item of rejected) {
    if (item.id === null) continue;
    states.set(item.id, item.kind === 'advice' ? 'advice-withheld' : 'invalid-response');
  }
  return states;
}

/** Everything the optional model layer contributes, gathered so `analyse()` stays readable. */
interface ModelLayerOutcome {
  readonly explanations: ReadonlyMap<string, string>;
  readonly explanationAnchors: ReadonlyMap<string, VerifiedQuote>;
  readonly summary: LeaseSummary | null;
  readonly usage: UsageMeter;
  readonly verifiedQuotes: number;
  readonly rejectedQuotes: number;
  readonly quotesInInjectedText: number;
  readonly redactions: Readonly<Record<string, number>>;
  readonly modelFailures: number;
  readonly modelState: ModelState;
  readonly clauseFailures: ReadonlyMap<string, ClauseAnalysisState>;
  readonly notes: readonly string[];
}

const NO_MODEL_LAYER: ModelLayerOutcome = {
  explanations: new Map(),
  explanationAnchors: new Map(),
  summary: null,
  usage: EMPTY_METER,
  verifiedQuotes: 0,
  rejectedQuotes: 0,
  quotesInInjectedText: 0,
  redactions: {},
  modelFailures: 0,
  modelState: 'absent',
  clauseFailures: new Map(),
  notes: [],
};

interface SummaryPassOutcome {
  readonly summary: LeaseSummary | null;
  readonly usage: UsageMeter;
  readonly verifiedQuotes: number;
  readonly rejectedQuotes: number;
  readonly quotesInInjectedText: number;
  readonly failed: boolean;
  readonly adviceWithheld: number;
  readonly notes: readonly string[];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

async function runSummaryPass(
  segmented: SegmentedDocument,
  port: LlmPort,
  safe: SafeDocument,
  meter: UsageMeter,
  embedded: readonly TextRange[],
): Promise<SummaryPassOutcome> {
  const notes: string[] = [];
  const summarised = await summariseLease(port, safe);
  if (summarised.note !== null) notes.push(summarised.note);

  const verified = verifySummary(segmented, summarised.sections, embedded);
  if (verified.rejectedCount > 0) {
    notes.push(
      `${verified.rejectedCount} ${plural(verified.rejectedCount, 'part', 'parts')} of the AI summary could not be tied to a quote from your document, so ${plural(verified.rejectedCount, 'it is', 'they are')} not shown.`,
    );
  }
  const injected = verified.inInjectedTextCount;
  if (injected > 0) {
    notes.push(
      `${injected} ${plural(injected, 'part', 'parts')} of the AI summary rested on text in your document that reads as instructions to an AI system, so ${plural(injected, 'it is', 'they are')} not shown.`,
    );
  }
  if (summarised.outcome === 'completed' && verified.summary === null) {
    notes.push(
      'The AI summary is not shown: none of its paragraphs could be tied to a quote from your document. Unverified prose is withheld rather than shown with a caveat.',
    );
  }

  return {
    summary: verified.summary,
    usage: recordUsage(meter, 'summarise-lease', summarised.usage, summarised.outcome),
    verifiedQuotes: verified.verifiedCount,
    rejectedQuotes: verified.rejectedCount,
    quotesInInjectedText: injected,
    failed: summarised.outcome === 'failed',
    adviceWithheld: summarised.rejected.filter((item) => item.kind === 'advice').length,
    notes,
  };
}

/**
 * The model layer, end to end.
 *
 * Nothing here can throw its way out: every pass reports an outcome, and a failure becomes a note
 * on the result. The deterministic findings are the product's floor and must survive the model
 * being unavailable — which, on a free tier, it regularly is.
 */
async function runModelLayer(
  segmented: SegmentedDocument,
  port: LlmPort,
  escalated: readonly Clause[],
  skipSummary: boolean,
  embedded: readonly TextRange[],
): Promise<ModelLayerOutcome> {
  // The document is redacted and channel-wrapped once, and that single prepared form is the only
  // thing any model call ever sees. The guard is bound to it, so every other field of every request
  // is held to the same surrogate map rather than trusted to have been redacted at the call site.
  const safe: SafeDocument = prepareForModel(segmented.document.text);
  const guarded = createGuardedPort(port, safe);
  const notes: string[] = [];

  // Explanation and summary are independent model calls — neither reads the other's output — so
  // they run concurrently rather than paying their latency twice.
  const [explained, pass] = await Promise.all([
    explainClauses(guarded, safe, escalated),
    skipSummary ? null : runSummaryPass(segmented, guarded, safe, EMPTY_METER, embedded),
  ]);

  if (explained.note !== null) notes.push(explained.note);
  let usage = recordUsage(EMPTY_METER, 'explain-clauses', explained.usage, explained.outcome);
  let modelFailures = explained.outcome === 'failed' ? 1 : 0;

  // 'skipped' means nothing was escalated, so there is nothing a model could have failed at.
  const modelState: ModelState =
    explained.outcome === 'skipped'
      ? 'absent'
      : explained.outcome === 'completed'
        ? 'responded'
        : 'unavailable';

  const checked = verifyExplanations(segmented, explained.explanations, embedded);
  const clauseFailures = new Map(failureStates(explained.rejected));
  for (const clauseId of checked.unverified) clauseFailures.set(clauseId, 'quote-unverified');
  for (const clauseId of checked.inInjectedText) {
    clauseFailures.set(clauseId, 'quote-in-injected-text');
  }

  const invalid = explained.rejected.filter((item) => item.kind === 'invalid-shape').length;
  if (invalid > 0) {
    notes.push(
      `${invalid} AI ${plural(invalid, 'explanation', 'explanations')} came back in a shape LexMind could not read and ${plural(invalid, 'was', 'were')} discarded. The other sections are unaffected.`,
    );
  }
  if (checked.rejectedCount > 0) {
    notes.push(
      `${checked.rejectedCount} AI ${plural(checked.rejectedCount, 'explanation', 'explanations')} quoted text that is not in your document, so ${plural(checked.rejectedCount, 'it was', 'they were')} discarded.`,
    );
  }
  const injected = checked.inInjectedText.length;
  if (injected > 0) {
    notes.push(
      `${injected} AI ${plural(injected, 'explanation', 'explanations')} rested on text in your document that reads as instructions to an AI system, so ${plural(injected, 'it was', 'they were')} not shown.`,
    );
  }

  let adviceWithheld = explained.rejected.filter((item) => item.kind === 'advice').length;
  let summary: LeaseSummary | null = null;
  let verifiedQuotes = checked.verifiedCount;
  let rejectedQuotes = checked.rejectedCount;
  let quotesInInjectedText = injected;

  if (pass !== null) {
    summary = pass.summary;
    usage = mergeMeters(usage, pass.usage);
    verifiedQuotes += pass.verifiedQuotes;
    rejectedQuotes += pass.rejectedQuotes;
    quotesInInjectedText += pass.quotesInInjectedText;
    adviceWithheld += pass.adviceWithheld;
    if (pass.failed) modelFailures += 1;
    notes.push(...pass.notes);
  }

  if (adviceWithheld > 0) notes.push(adviceWithheldNote(adviceWithheld));

  return {
    explanations: checked.kept,
    explanationAnchors: checked.anchors,
    summary,
    usage,
    verifiedQuotes,
    rejectedQuotes,
    quotesInInjectedText,
    redactions: safe.summary,
    modelFailures,
    modelState,
    clauseFailures,
    notes,
  };
}

export async function analyse(
  segmented: SegmentedDocument,
  options: AnalyseOptions = {},
): Promise<AnalysisResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();

  const { document, clauses } = segmented;

  // ── Deterministic layer ──────────────────────────────────────────────────────────────────────
  const jurisdiction = resolveJurisdiction(document.text, options.declaredJurisdiction);
  const typings = detectAllClauseTypes(clauses);
  const extracted: ExtractedFacts = extractFacts(clauses, typings);
  const candidates = applyRules({ clauses, typings, extracted, jurisdiction });

  const { findings: ruleFindings, dropped } = buildFindings(segmented, candidates, jurisdiction);
  const obligationDrafts = extractObligations(clauses);
  const obligations = buildObligations(segmented, obligationDrafts);
  const embeddedInstructions = findEmbeddedInstructions(segmented);

  const notes: string[] = [];
  /**
   * Notes are a set, not a log. Both model passes fail with the same message when there is no API
   * key, and printing "LexMind is running without an AI provider" twice reads as a bug in the tool
   * rather than as one missing key.
   */
  const addNote = (note: string): void => {
    if (note.length > 0 && !notes.includes(note)) notes.push(note);
  };

  if (dropped > 0) {
    addNote(
      `${dropped} finding${dropped === 1 ? '' : 's'} could not be anchored to an exact quote and ${dropped === 1 ? 'was' : 'were'} discarded rather than shown unverified.`,
    );
  }
  for (const warning of document.warnings) addNote(warning);
  for (const instruction of embeddedInstructions) {
    addNote(embeddedInstructionNote(instruction, clauses));
  }

  // The escalation set is computed whether or not a model is configured: it is a deterministic
  // decision about which clauses the rule layer could not resolve, and it is the number reported
  // as `escalationRate`. When a port exists, this exact set is what goes in the request.
  const escalatedClauses = clausesToExplain(clauses, ruleFindings, typings, {
    embeddedInstructions,
  });
  const escalatedIds = new Set(escalatedClauses.map((clause) => clause.id));

  // ── Model layer: optional, and its failure is a note rather than an exception ────────────────
  const model =
    options.port === undefined
      ? NO_MODEL_LAYER
      : await runModelLayer(
          segmented,
          options.port,
          escalatedClauses,
          options.skipSummary === true,
          embeddedInstructions,
        );

  for (const note of model.notes) addNote(note);

  const modelLabel = options.port?.label ?? 'none (deterministic only)';
  const verifiedQuotes = ruleFindings.length + model.verifiedQuotes;
  const rejectedQuotes = dropped + model.rejectedQuotes;

  const clauseStatus = buildClauseStatus(
    clauses,
    escalatedIds,
    model.explanations,
    model.clauseFailures,
    model.modelState,
    new Set(
      clauses
        .filter((clause) => isWhollyCovered(clause, embeddedInstructions))
        .map((clause) => clause.id),
    ),
  );
  const unanalysedClauses = clauseStatus.filter((status) => isAnalysisGap(status.state)).length;

  const findings = [...ruleFindings].sort(
    (a, b) => compareSeverity(a.severity, b.severity) || a.clauseId.localeCompare(b.clauseId),
  );

  const bySeverity = emptySeverityCounts();
  for (const finding of findings) bySeverity[finding.severity] += 1;

  return {
    documentId: document.id,
    clauses,
    typings,
    jurisdiction,
    facts: extracted.facts,
    findings,
    obligations,
    embeddedInstructions,
    obligationBalance: obligationBalance(obligationDrafts),
    explanations: model.explanations,
    explanationAnchors: model.explanationAnchors,
    clauseStatus,
    summary: model.summary,
    stats: {
      clauseCount: clauses.length,
      findingCount: findings.length,
      bySeverity,
      untypedShare: untypedShare(typings),
      escalationRate: share(escalatedClauses.length, clauses.length),
      escalatedClauses: escalatedClauses.length,
      unanalysedClauses,
      citationRejectionRate: share(rejectedQuotes, verifiedQuotes + rejectedQuotes),
      verifiedQuotes,
      rejectedQuotes,
      quotesInInjectedText: model.quotesInInjectedText,
      durationMs: Math.round((now() - started) * 100) / 100,
      modelCalls: model.usage.calls,
      modelFailures: model.modelFailures,
      readability: {
        explanations: aggregateReadability([...model.explanations.values()]),
        summary: aggregateReadability(model.summary?.sections.map((section) => section.text) ?? []),
      },
    },
    notes,
    usage: model.usage,
    modelLabel,
    redactions: model.redactions,
  };
}

/** Below this, an untyped clause is a heading, a recital or a signature line, not a duty. */
const UNTYPED_ESCALATION_CHARS = 120;
const PRIORITY_TYPE_IDS: ReadonlySet<string> = new Set(PRIORITY_CLAUSE_TYPES.map((t) => t.id));

/**
 * Which clauses are escalated to the model.
 *
 * This used to take "everything the rules flagged, then the longest of the rest, up to 24" — which
 * on every lease in the golden set was *all of them*, because no golden lease has more than 24
 * clauses. An escalation rate reported next to a function that escalates everything is a number
 * describing nothing, and plan 06 makes that number the headline efficiency figure. So the
 * selection is now a real decision with a stated rule, in three tiers:
 *
 *  1. **Flagged** — the rule layer found a risk here, and a risk the reader cannot read is not much
 *     use. These go first, so a truncating limit never drops a finding's explanation.
 *  2. **Priority-typed** — deposit, notice, entry, repairs and the rest of the ten types a tenant is
 *     most exposed to. The rule layer had nothing to say, but the reader still has to understand it.
 *  3. **Untyped and substantial** — the taxonomy could not type it at all, which is the definition
 *     of a clause the deterministic layer cannot resolve. Longest first, since length correlates
 *     with content. Short untyped fragments are headings and signature blocks.
 *
 * Everything else — a clause confidently typed, with no finding against it — is already described
 * by the deterministic layer, so escalating it buys nothing and costs tokens. On the golden set
 * this sends between 17% and 82% of clauses depending on how bad the lease is, which is the
 * efficiency story told honestly: a fair lease is cheap to analyse and a one-sided one is not.
 */
export function clausesToExplain(
  clauses: readonly Clause[],
  findings: readonly Finding[],
  typings: readonly ClauseTyping[],
  options: {
    readonly limit?: number;
    /** From `AnalysisResult.embeddedInstructions`. A clause that is nothing else is never sent. */
    readonly embeddedInstructions?: readonly TextRange[];
  } = {},
): readonly Clause[] {
  const limit = options.limit ?? 24;
  const embedded = options.embeddedInstructions ?? [];
  // A clause that is nothing but a planted instruction is reported deterministically, and any
  // explanation of it could only quote the instruction — which `verifyExplanations` would drop. So
  // it is never sent: no tokens spent on a guaranteed discard, and the payload is kept out of
  // `task_input`, which sits outside the document channel.
  const candidates = clauses.filter((clause) => !isWhollyCovered(clause, embedded));
  const flagged = new Set(findings.map((f) => f.clauseId));
  const typesById = new Map(typings.map((typing) => [typing.clauseId, typing.typeIds]));

  const isPriorityTyped = (clause: Clause): boolean =>
    (typesById.get(clause.id) ?? []).some((id) => PRIORITY_TYPE_IDS.has(id));
  const isUntyped = (clause: Clause): boolean => (typesById.get(clause.id) ?? []).length === 0;

  const flaggedClauses = candidates.filter((clause) => flagged.has(clause.id));
  const priorityClauses = candidates.filter(
    (clause) => !flagged.has(clause.id) && isPriorityTyped(clause),
  );
  const ambiguous = candidates
    .filter(
      (clause) =>
        !flagged.has(clause.id) &&
        !isPriorityTyped(clause) &&
        isUntyped(clause) &&
        clause.text.length >= UNTYPED_ESCALATION_CHARS,
    )
    .sort((a, b) => b.text.length - a.text.length);

  return [...flaggedClauses, ...priorityClauses, ...ambiguous].slice(0, limit);
}

/**
 * Find the instructions to an AI that the document carries, clipped to the clause each sits in.
 *
 * Deterministic, and run whether or not a model is configured: reporting a planted instruction as
 * document content is part of the analysis floor, not a model feature.
 */
export function findEmbeddedInstructions(
  segmented: SegmentedDocument,
): readonly EmbeddedInstruction[] {
  const { document, clauses } = segmented;
  return findInjectionSpans(document.text, clauses).map((span) => ({
    charStart: span.charStart,
    charEnd: span.charEnd,
    clauseId: clauseAtOffset(clauses, span.charStart)?.id ?? null,
    quote: document.text.slice(span.charStart, span.charEnd),
    cues: span.cues,
  }));
}

/** Longest excerpt of a planted instruction quoted back in a note. The full text is in the result. */
const INSTRUCTION_EXCERPT_CHARS = 160;

/**
 * The reader is told, in the document's own words, that the text is there and what LexMind did with
 * it. Plan 07: the injected text is "reported as document content" — not hidden, and not obeyed.
 */
function embeddedInstructionNote(
  instruction: EmbeddedInstruction,
  clauses: readonly Clause[],
): string {
  const clause = clauses.find((candidate) => candidate.id === instruction.clauseId);
  const where = clause === undefined ? 'Your document' : `"${clauseReference(clause)}"`;
  const excerpt = truncateWords(instruction.quote.replace(/\s+/g, ' '), INSTRUCTION_EXCERPT_CHARS);
  return (
    `${where} contains text that reads as instructions to an AI system: "${excerpt}" ` +
    'LexMind reports it as part of your document and does not follow it. It changes nothing in ' +
    'this analysis, and no AI explanation is allowed to rest on it.'
  );
}

/** A one-line label for a finding, used in lists and exports. */
export function findingLabel(finding: Finding): string {
  return `${clauseTypeLabel(finding.clauseTypeId)}: ${finding.title}`;
}
