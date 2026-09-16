import type { CitationId } from '../domain/citations.ts';
import type { JurisdictionResolution } from '../domain/jurisdictions/index.ts';
import {
  ALL_RISK_PATTERNS,
  CUE_PATTERNS,
  findRiskPattern,
  type RiskPattern,
} from '../domain/risk-taxonomy.ts';
import type { Clause, SeverityInputs, StatutoryStatus } from '../domain/types.ts';
import { OBSCURE_GRADE_LEVEL, readability } from '../util/readability.ts';
import { countWords, splitSentences } from '../util/text.ts';
import type { ClauseTyping } from './detect.ts';
import { clausesOfType } from './detect.ts';
import type { ExtractedFacts } from './facts.ts';
import { sentenceContaining } from './facts.ts';

/**
 * The rule engine.
 *
 * The split it enforces, stated once and applied everywhere:
 *
 * | Job                                              | Owner  |
 * |--------------------------------------------------|--------|
 * | Is there a clause of type X?                     | rules  |
 * | Does the deposit exceed the cap?                 | rules  |
 * | Is notice asymmetric between the parties?        | rules  |
 * | Does URLTA §1.403(a) prohibit this clause?       | rules  |
 * | What does this clause *mean* in plain English?   | model  |
 * | How severe is it?                                | rules  |
 *
 * "Your deposit is three times the legal cap" must be arithmetic against a cited statute, or it is
 * a hallucination with a number in it. So the model never sees a statutory figure and never
 * decides compliance.
 */

export interface Candidate {
  readonly patternId: string;
  readonly clauseId: string;
  /** Verbatim from the document, to be verified in code before anything is shown. */
  readonly quote: string;
  /** The computed specifics, e.g. "The deposit is 3 months of rent; the cap here is 2 months." */
  readonly detail: string;
  readonly severityInputs: SeverityInputs;
  readonly citations: readonly CitationId[];
}

export interface RuleInput {
  readonly clauses: readonly Clause[];
  readonly typings: readonly ClauseTyping[];
  readonly extracted: ExtractedFacts;
  readonly jurisdiction: JurisdictionResolution;
}

/**
 * How this jurisdiction treats this pattern, and the provisions that say so.
 *
 * When there is no ruling for the resolved jurisdiction the status is `unknown` and **no citation
 * is attached**. That is deliberate: a finding with no statutory backing makes no legal claim, so
 * borrowing another jurisdiction's provision to decorate it would be exactly the confidently-wrong
 * assertion this product exists to avoid. The finding still stands on what the document does.
 */
export function rulingFor(
  pattern: RiskPattern,
  jurisdiction: JurisdictionResolution,
): { readonly status: StatutoryStatus; readonly citations: readonly CitationId[] } {
  const ruling = pattern.rulings.find((r) => r.jurisdiction === jurisdiction.id);
  if (ruling === undefined) return { status: 'unknown', citations: [] };
  return { status: ruling.status, citations: ruling.citations };
}

function inputsFor(
  pattern: RiskPattern,
  jurisdiction: JurisdictionResolution,
  overrides?: Partial<SeverityInputs>,
): SeverityInputs {
  const { status } = rulingFor(pattern, jurisdiction);
  return {
    statutoryStatus: status,
    financialExposure: pattern.financialExposure,
    asymmetric: pattern.asymmetric,
    reversible: pattern.reversible,
    ...overrides,
  };
}

function candidate(
  patternId: string,
  clause: Clause,
  quote: string,
  detail: string,
  jurisdiction: JurisdictionResolution,
  overrides?: Partial<SeverityInputs>,
): Candidate | null {
  const pattern = findRiskPattern(patternId);
  if (pattern === undefined) return null;
  const { citations } = rulingFor(pattern, jurisdiction);
  return {
    patternId,
    clauseId: clause.id,
    quote,
    detail,
    severityInputs: inputsFor(pattern, jurisdiction, overrides),
    citations,
  };
}

// ─── Cue rules ─────────────────────────────────────────────────────────────────────────────────

/**
 * Match a cue pattern against a clause: every group must contribute at least one phrase.
 *
 * AND-of-ORs rather than a single regex, because that is what makes a new drafting variant a data
 * change. It is also what keeps precision up: requiring both "indemnify" and a party word is far
 * more selective than either alone.
 */
export function matchesCues(clauseText: string, pattern: RiskPattern): string | null {
  const lower = clauseText.toLowerCase();

  if (pattern.exclude?.some((phrase) => lower.includes(phrase.toLowerCase())) === true) return null;

  let evidence = '';
  for (const group of pattern.cues) {
    const hit = group.find((phrase) => lower.includes(phrase.toLowerCase()));
    if (hit === undefined) return null;
    if (hit.length > evidence.length) evidence = hit;
  }
  return pattern.cues.length === 0 ? null : evidence;
}

export function applyCueRules(input: RuleInput): readonly Candidate[] {
  const found: Candidate[] = [];

  for (const clause of input.clauses) {
    for (const pattern of CUE_PATTERNS) {
      const evidence = matchesCues(clause.text, pattern);
      if (evidence === null) continue;

      // Quote the sentence that carries the cue, not the whole clause: a short quote is easier to
      // verify, easier to read, and easier to check against the document by eye.
      const index = clause.text.toLowerCase().indexOf(evidence);
      const fragment = index === -1 ? '' : clause.text.slice(index, index + evidence.length);
      const quote = sentenceContaining(clause.text, fragment);

      const entry = candidate(
        pattern.id,
        clause,
        quote,
        `The clause says "${fragment}".`,
        input.jurisdiction,
      );
      if (entry !== null) found.push(entry);
    }
  }

  return found;
}

// ─── Numeric rules ─────────────────────────────────────────────────────────────────────────────

/** A week of rent, in months. England states its deposit cap in weeks. */
const WEEKS_PER_MONTH = 4.345;

function depositCapRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const rules = input.jurisdiction.rules;
  const months = facts.depositMonths;
  const source = evidence.depositMonths ?? evidence.depositAmount;
  if (months === null || source === undefined) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const capMonths = rules.depositCapMonths;
  const capWeeks = rules.depositCapWeeks;

  if (capMonths !== null && months > capMonths.value) {
    const plural = capMonths.value === 1 ? 'month' : 'months';
    const entry = candidate(
      'deposit-excessive',
      clause,
      source.quote,
      `The deposit is ${months} months of rent. The limit that applies here is ${capMonths.value} ${plural}, ` +
        `so the deposit is ${round(months / capMonths.value)} times the limit.` +
        (capMonths.note === undefined ? '' : ` ${capMonths.note}`),
      input.jurisdiction,
    );
    // The provision that sets the cap is cited alongside the pattern's own rulings, because this
    // finding is arithmetic against that specific limit.
    return entry === null ? [] : [withCitation(entry, capMonths.citation)];
  }

  if (capWeeks !== null) {
    const weeks = round(months * WEEKS_PER_MONTH);
    if (weeks > capWeeks.value) {
      const entry = candidate(
        'deposit-excessive',
        clause,
        source.quote,
        `The deposit is about ${weeks} weeks of rent. The limit that applies here is ${capWeeks.value} weeks.` +
          (capWeeks.note === undefined ? '' : ` ${capWeeks.note}`),
        input.jurisdiction,
      );
      return entry === null ? [] : [withCitation(entry, capWeeks.citation)];
    }
  }

  return [];
}

/** Attach the provision that sets a numeric limit, without duplicating it. */
function withCitation(entry: Candidate, citation: CitationId): Candidate {
  if (entry.citations.includes(citation)) return entry;
  return { ...entry, citations: [...entry.citations, citation] };
}

function lockInRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const months = facts.lockInMonths;
  const source = evidence.lockInMonths;
  if (months === null || source === undefined) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const term = facts.termMonths;
  const share = term === null ? null : Math.round((months / term) * 100);
  const detail =
    share === null
      ? `The agreement locks the tenant in for ${months} months.`
      : `The agreement locks the tenant in for ${months} of its ${term} months, which is ${share} per cent of the term.`;

  // A lock-in covering most of the term is materially worse than a short one, and that is a
  // computed judgement about exposure, not a legal claim.
  const exposure = share !== null && share >= 50 ? 3 : 2;
  const entry = candidate('lock-in-period', clause, source.quote, detail, input.jurisdiction, {
    financialExposure: exposure,
  });
  return entry === null ? [] : [entry];
}

/** The minimum difference that makes a notice split a finding rather than rounding. */
const NOTICE_GAP_DAYS = 7;

function noticeAsymmetryRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const tenant = facts.noticeDaysTenant;
  const landlord = facts.noticeDaysLandlord;
  if (tenant === null || landlord === null) return [];
  if (tenant - landlord < NOTICE_GAP_DAYS) return [];

  const source = evidence.noticeDaysTenant;
  if (source === undefined) return [];
  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const entry = candidate(
    'notice-asymmetry',
    clause,
    source.quote,
    `The tenant must give ${tenant} days notice. The landlord must give ${landlord}. ` +
      `That is ${round(tenant / Math.max(landlord, 1))} times as much warning one way as the other.`,
    input.jurisdiction,
  );
  return entry === null ? [] : [entry];
}

function entryNoticeRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const hours = facts.entryNoticeHours;
  const source = evidence.entryNoticeHours;
  if (hours === null || source === undefined) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const minimum = input.jurisdiction.rules.minEntryNoticeHours;
  if (minimum !== null && hours >= minimum.value) return [];
  // With no local minimum, zero notice is still a structural finding: an unannounced right of
  // entry to someone's home is one-sided whatever the jurisdiction.
  if (minimum === null && hours > 0) return [];

  const detail =
    hours === 0
      ? 'The clause lets the landlord enter with no advance notice at all.'
      : `The clause requires ${hours} hours notice. The standard that applies here is ${minimum?.value} hours.`;

  const entry = candidate('entry-without-notice', clause, source.quote, detail, input.jurisdiction);
  return entry === null ? [] : [entry];
}

function lateFeeRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const percent = facts.lateFeePercent;
  const cap = input.jurisdiction.rules.lateFeeMaxPercentOfRent;
  const source = evidence.lateFeePercent;
  if (percent === null || cap === null || source === undefined) return [];
  if (percent <= cap.value) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const entry = candidate(
    'late-fee-excessive',
    clause,
    source.quote,
    `The late charge is ${percent} per cent. The ceiling referenced here is ${cap.value} per cent.`,
    input.jurisdiction,
  );
  return entry === null ? [] : [entry];
}

/** Above this, a stated annual increase is reported as steep — as a figure, not a legal claim. */
const STEEP_INCREASE_PERCENT = 10;

function escalationRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const percent = facts.renewalIncreasePercent;
  const source = evidence.renewalIncreasePercent;
  if (percent === null || source === undefined || percent < STEEP_INCREASE_PERCENT) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const entry = candidate(
    'rent-escalation-steep',
    clause,
    source.quote,
    `The agreement states an increase of ${percent} per cent. Over a three-year stay that compounds to about ${Math.round(((1 + percent / 100) ** 3 - 1) * 100)} per cent above the starting rent.`,
    input.jurisdiction,
  );
  return entry === null ? [] : [entry];
}

const REGISTRATION_MENTIONED = /\bregist(?:er|ered|ration)\b|\bsub-registrar\b/i;

function registrationRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const threshold = input.jurisdiction.rules.registrationRequiredOverMonths;
  const months = facts.termMonths;
  const source = evidence.termMonths;
  if (threshold === null || months === null || source === undefined) return [];
  if (months <= threshold.value) return [];

  // The document saying it is registered is the answer to this check.
  if (input.clauses.some((clause) => REGISTRATION_MENTIONED.test(clause.text))) return [];

  const clause = input.clauses.find((c) => c.id === source.clauseId);
  if (clause === undefined) return [];

  const entry = candidate(
    'unregistered-tenancy-over-one-year',
    clause,
    source.quote,
    `The term is ${months} months, above the ${threshold.value}-month point at which registration becomes compulsory, and the document does not mention registration.`,
    input.jurisdiction,
  );
  return entry === null ? [] : [entry];
}

/** Long enough that a high reading grade reflects the drafting rather than a short fragment. */
const MIN_WORDS_FOR_READABILITY = 45;

function readabilityRule(input: RuleInput): readonly Candidate[] {
  const found: Candidate[] = [];

  for (const clause of input.clauses) {
    if (countWords(clause.text) < MIN_WORDS_FOR_READABILITY) continue;

    const score = readability(clause.text);
    if (score.gradeLevel <= OBSCURE_GRADE_LEVEL) continue;

    const sentences = splitSentences(clause.text);
    const longest = sentences.reduce(
      (worst, sentence) => (countWords(sentence) > countWords(worst) ? sentence : worst),
      sentences[0] ?? clause.text,
    );

    const entry = candidate(
      'unintelligible-drafting',
      clause,
      longest,
      `This clause reads at about grade ${score.gradeLevel}, with its longest sentence running to ${countWords(longest)} words.`,
      input.jurisdiction,
    );
    if (entry !== null) found.push(entry);
  }

  return found;
}

const NUMERIC_RULES: readonly ((input: RuleInput) => readonly Candidate[])[] = [
  depositCapRule,
  lockInRule,
  noticeAsymmetryRule,
  entryNoticeRule,
  lateFeeRule,
  escalationRule,
  registrationRule,
  readabilityRule,
];

export function applyNumericRules(input: RuleInput): readonly Candidate[] {
  return NUMERIC_RULES.flatMap((rule) => rule(input));
}

/**
 * Every rule-based candidate, de-duplicated.
 *
 * Runs with no network in well under a millisecond on a typical lease, which is what lets the UI
 * show real findings before any model call returns — and what keeps the product working when the
 * provider's daily quota is gone.
 */
export function applyRules(input: RuleInput): readonly Candidate[] {
  const all = [...applyNumericRules(input), ...applyCueRules(input)];

  const seen = new Set<string>();
  return all.filter((entry) => {
    const key = `${entry.patternId}:${entry.clauseId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The share of clauses a model would have to look at.
 *
 * Reported as the efficiency figure: if the deterministic layer already covers a clause, escalating
 * it to a model buys nothing and costs tokens.
 */
export function escalationRate(
  clauses: readonly Clause[],
  candidates: readonly Candidate[],
): number {
  if (clauses.length === 0) return 0;
  const covered = new Set(candidates.map((c) => c.clauseId));
  return Math.round(((clauses.length - covered.size) / clauses.length) * 1000) / 1000;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Patterns that can never fire, for the coverage report. */
export function unreachablePatterns(candidates: readonly Candidate[]): readonly string[] {
  const fired = new Set(candidates.map((c) => c.patternId));
  return ALL_RISK_PATTERNS.filter((p) => !fired.has(p.id)).map((p) => p.id);
}

export { clausesOfType };
