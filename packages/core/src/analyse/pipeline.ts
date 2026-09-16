import { citation, type CitationId } from '../domain/citations.ts';
import { clauseTypeLabel } from '../domain/clause-types.ts';
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
} from '../domain/types.ts';
import { EMPTY_METER, recordUsage, type UsageMeter } from '../model/budget.ts';
import type { LlmPort } from '../model/port.ts';
import { verifyQuote, verifyQuotes } from '../qa/verify.ts';
import { createGuardedPort, prepareForModel, type SafeDocument } from '../safety/index.ts';
import type { SegmentedDocument } from '../segment/index.ts';
import { type ClauseTyping, detectAllClauseTypes, untypedShare } from './detect.ts';
import { type ClauseExplanation, explainClauses, type LeaseSummary, summariseLease } from './explain.ts';
import { extractFacts, type ExtractedFacts } from './facts.ts';
import { extractObligations, obligationBalance, type ObligationDraft } from './obligations.ts';
import { applyRules, type Candidate, escalationRate } from './rules.ts';

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
  /** Share of clauses the deterministic layer found nothing in. The efficiency figure. */
  readonly escalationRate: number;
  /** Share of model-claimed quotes that failed verification. The honest reliability figure. */
  readonly citationRejectionRate: number;
  readonly verifiedQuotes: number;
  readonly rejectedQuotes: number;
  readonly durationMs: number;
  readonly modelCalls: number;
}

export interface AnalysisResult {
  readonly documentId: string;
  readonly clauses: readonly Clause[];
  readonly typings: readonly ClauseTyping[];
  readonly jurisdiction: JurisdictionResolution;
  readonly facts: LeaseFacts;
  readonly findings: readonly Finding[];
  readonly obligations: readonly Obligation[];
  readonly obligationBalance: { readonly tenant: number; readonly landlord: number; readonly ratio: number | null };
  /** Model-written, quote-verified explanations, keyed by clause id. Empty when offline. */
  readonly explanations: ReadonlyMap<string, string>;
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

/** Keep only the explanations whose quote actually appears in the document. Fail closed. */
function verifyExplanations(
  segmented: SegmentedDocument,
  explanations: readonly ClauseExplanation[],
): { readonly kept: ReadonlyMap<string, string>; readonly verifiedCount: number; readonly rejectedCount: number } {
  const result = verifyQuotes(
    segmented,
    explanations.map((e) => ({ quote: e.quote, clauseId: e.clauseId })),
  );
  const verifiedClauses = new Set(result.verified.map((v) => v.clauseId));

  const kept = new Map<string, string>();
  for (const explanation of explanations) {
    if (verifiedClauses.has(explanation.clauseId)) kept.set(explanation.clauseId, explanation.plainEnglish);
  }

  return {
    kept,
    verifiedCount: result.verified.length,
    rejectedCount: result.rejected.length,
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

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(
      `${dropped} finding${dropped === 1 ? '' : 's'} could not be anchored to an exact quote and ${dropped === 1 ? 'was' : 'were'} discarded rather than shown unverified.`,
    );
  }
  if (document.warnings.length > 0) notes.push(...document.warnings);

  // ── Model layer: optional, and its failure is a note rather than an exception ────────────────
  let explanations: ReadonlyMap<string, string> = new Map();
  let summary: LeaseSummary | null = null;
  let usage: UsageMeter = EMPTY_METER;
  let verifiedQuotes = ruleFindings.length;
  let rejectedQuotes = dropped;
  let redactions: Readonly<Record<string, number>> = {};
  let modelLabel = 'none (deterministic only)';

  if (options.port !== undefined) {
    const guarded = createGuardedPort(options.port);
    modelLabel = options.port.label;

    // The document is redacted and channel-wrapped once, and that single prepared form is the
    // only thing any model call ever sees.
    const safe: SafeDocument = prepareForModel(document.text);
    redactions = safe.summary;

    const focus = clausesToExplain(clauses, ruleFindings);
    const explained = await explainClauses(guarded, safe, focus);
    if (explained.note !== null) notes.push(explained.note);
    usage = recordUsage(usage, 'explain-clauses', explained.usage);

    const checked = verifyExplanations(segmented, explained.explanations);
    explanations = checked.kept;
    verifiedQuotes += checked.verifiedCount;
    rejectedQuotes += checked.rejectedCount;
    if (checked.rejectedCount > 0) {
      notes.push(
        `${checked.rejectedCount} AI explanation${checked.rejectedCount === 1 ? '' : 's'} quoted text that is not in your document, so ${checked.rejectedCount === 1 ? 'it was' : 'they were'} discarded.`,
      );
    }

    if (options.skipSummary !== true) {
      const summarised = await summariseLease(guarded, safe);
      if (summarised.note !== null) notes.push(summarised.note);
      summary = summarised.summary;
      usage = recordUsage(usage, 'summarise-lease', summarised.usage);
    }
  }

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
    obligationBalance: obligationBalance(obligationDrafts),
    explanations,
    summary,
    stats: {
      clauseCount: clauses.length,
      findingCount: findings.length,
      bySeverity,
      untypedShare: untypedShare(typings),
      escalationRate: escalationRate(clauses, candidates),
      citationRejectionRate: share(rejectedQuotes, verifiedQuotes + rejectedQuotes),
      verifiedQuotes,
      rejectedQuotes,
      durationMs: Math.round((now() - started) * 100) / 100,
      modelCalls: usage.calls,
    },
    notes,
    usage,
    modelLabel,
    redactions,
  };
}

/**
 * Which clauses are worth a model call.
 *
 * Escalate only what the deterministic layer flagged, plus the longest remaining clauses — the
 * ones most likely to hide something the cue table has not seen. Sending all eighty clauses would
 * cost four times the tokens to explain the recitals.
 */
export function clausesToExplain(
  clauses: readonly Clause[],
  findings: readonly Finding[],
  limit = 24,
): readonly Clause[] {
  const flagged = new Set(findings.map((f) => f.clauseId));
  const priority = clauses.filter((clause) => flagged.has(clause.id));
  const rest = clauses
    .filter((clause) => !flagged.has(clause.id))
    .sort((a, b) => b.text.length - a.text.length);

  return [...priority, ...rest].slice(0, limit);
}

/** A one-line label for a finding, used in lists and exports. */
export function findingLabel(finding: Finding): string {
  return `${clauseTypeLabel(finding.clauseTypeId)}: ${finding.title}`;
}
