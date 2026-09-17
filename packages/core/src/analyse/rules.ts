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
import type { ExtractedFacts, FactKey } from './facts.ts';
import { conflictNoteFor, MAX_CREDIBLE_DEPOSIT_MONTHS } from './facts.ts';

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

const CUE_REGEX_CACHE = new Map<string, RegExp>();
const CUE_REGEX_ALL_CACHE = new Map<string, RegExp>();

/**
 * A cue phrase, matched on a word boundary at its **start** only.
 *
 * Only the start, because half the cue vocabulary is a deliberate stem: `terminat` covers
 * terminate, terminates, termination and terminated in one row, and anchoring the end would break
 * every row that relies on it. The leading boundary is the half that was missing and the half that
 * matters — a bare `indexOf` finds `rent` inside "cur**rent** market value", `fail` inside
 * "un**fail**ingly", `bond` inside "abs**cond**" and `on` inside almost everything, and each of
 * those is a finding shown to a tenant about a clause that does not say what the finding claims.
 */
function cueRegex(phrase: string): RegExp {
  const cached = CUE_REGEX_CACHE.get(phrase);
  if (cached !== undefined) return cached;

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^[\p{L}\p{N}]/u.test(phrase) ? '(?<![\\p{L}\\p{N}])' : '';
  const built = new RegExp(`${lead}${escaped}`, 'iu');
  CUE_REGEX_CACHE.set(phrase, built);
  return built;
}

/** The same matcher, global, for walking every occurrence. Compiled once and reused. */
function cueRegexAll(phrase: string): RegExp {
  const cached = CUE_REGEX_ALL_CACHE.get(phrase);
  if (cached !== undefined) return cached;
  const built = new RegExp(cueRegex(phrase).source, 'giu');
  CUE_REGEX_ALL_CACHE.set(phrase, built);
  return built;
}

function firstCueHit(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (cueRegex(phrase).test(text)) return phrase;
  }
  return null;
}

/** Words that turn a phrase into its own opposite when they sit just before it. */
const NEGATED_BEFORE = /\b(?:no|not|without|never|neither|nor)\s+(?:\w+\s+){0,2}$/i;

/**
 * An exclusion phrase that is actually present — not one appearing inside its own negation.
 *
 * `no-cure-period` lists `no opportunity to` as a cue and `opportunity to cure` as an exclusion.
 * Those match the same characters, and the exclusion wins, so the rule named after the phrase "no
 * cure period" was switched off by that phrase appearing in a lease. Three of its four canonical
 * true positives were dropped in silence. A stated chance to put a breach right still answers the
 * check; a *denial* of one never did.
 */
function isExcluded(clauseText: string, pattern: RiskPattern): boolean {
  for (const phrase of pattern.exclude ?? []) {
    for (const match of clauseText.matchAll(cueRegexAll(phrase))) {
      if (!NEGATED_BEFORE.test(clauseText.slice(0, match.index ?? 0))) return true;
    }
  }
  return false;
}

/**
 * Match a cue pattern against a clause: every group must contribute at least one phrase, **within
 * one sentence**.
 *
 * AND-of-ORs rather than a single regex, because that is what makes a new drafting variant a data
 * change. The sentence is what makes it mean anything. Conjoining the groups across a whole clause
 * lets unrelated sentences satisfy different halves of a pattern, so *generalising* a row into more
 * and looser groups lowers its precision instead of raising its recall — and the failures are not
 * subtle ones:
 *
 *  - "Rent is payable immediately on the first of each month. Failure to pay is a breach. Either
 *    party may terminate on ninety days notice." fired `no-cure-period` on the word *immediately*,
 *    in a clause that grants ninety days.
 *  - "The Tenant may terminate this Agreement on thirty days notice at any time without penalty."
 *    fired `unilateral-termination-landlord` — reported as *the landlord can end the tenancy at
 *    will* — on a clause that gives the tenant a right the landlord does not have.
 *  - "In any dispute the Landlord shall pay the reasonable legal costs of the Tenant." fired
 *    `landlord-attorney-fees`, reported as *the tenant pays the landlord legal costs*, on the one
 *    drafting a tenant would be pleased to find.
 *
 * A finding that inverts what a clause says is worse than no finding, and it arrives with the same
 * confidence as a true one.
 */
function cueMatchIn(
  clauseText: string,
  pattern: RiskPattern,
): { readonly evidence: string; readonly sentence: string } | null {
  if (pattern.cues.length === 0) return null;
  if (isExcluded(clauseText, pattern)) return null;

  for (const sentence of splitSentences(clauseText)) {
    let evidence = '';
    let complete = true;

    for (const group of pattern.cues) {
      const hit = firstCueHit(sentence, group);
      if (hit === null) {
        complete = false;
        break;
      }
      if (hit.length > evidence.length) evidence = hit;
    }

    if (complete) return { evidence, sentence };
  }

  return null;
}

export function matchesCues(clauseText: string, pattern: RiskPattern): string | null {
  return cueMatchIn(clauseText, pattern)?.evidence ?? null;
}

export function applyCueRules(input: RuleInput): readonly Candidate[] {
  const found: Candidate[] = [];

  for (const clause of input.clauses) {
    for (const pattern of CUE_PATTERNS) {
      const match = cueMatchIn(clause.text, pattern);
      if (match === null) continue;

      // Quote the sentence that carries the cues, not the whole clause: a short quote is easier to
      // verify, easier to read, and easier to check against the document by eye. It is also the
      // sentence in which the pattern was actually satisfied, so the quote and the finding agree.
      const at = match.sentence.search(cueRegex(match.evidence));
      const fragment = at === -1 ? '' : match.sentence.slice(at, at + match.evidence.length);

      const entry = candidate(
        pattern.id,
        clause,
        match.sentence,
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

/**
 * Add the document's own disagreement about a number to a finding computed from it.
 *
 * A reader is entitled to know that the figure behind an arithmetic finding is one of two the
 * document states, and which one was used. Silence here is how a contradiction becomes a
 * conclusion.
 */
function withConflictNote(
  entry: Candidate,
  extracted: ExtractedFacts,
  ...keys: readonly FactKey[]
): Candidate {
  const note = conflictNoteFor(extracted, ...keys);
  return note === null ? entry : { ...entry, detail: `${entry.detail} ${note}` };
}

function depositCapRule(input: RuleInput): readonly Candidate[] {
  const { facts, evidence } = input.extracted;
  const rules = input.jurisdiction.rules;
  const months = facts.depositMonths;
  const source = evidence.depositMonths ?? evidence.depositAmount;
  if (months === null || source === undefined) return [];
  // A ratio outside this range is evidence that one of the two figures was misread, not evidence
  // of a breach. "The deposit is 40 months of rent, 20 times the limit", cited to a statute, is a
  // hallucination with a number in it — the exact failure this engine exists to make impossible.
  if (months <= 0 || months > MAX_CREDIBLE_DEPOSIT_MONTHS) return [];

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
    return entry === null
      ? []
      : [
          withConflictNote(
            withCitation(entry, capMonths.citation),
            input.extracted,
            'depositMonths',
            'depositAmount',
            'rentAmount',
          ),
        ];
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
      return entry === null
        ? []
        : [
            withConflictNote(
              withCitation(entry, capWeeks.citation),
              input.extracted,
              'depositMonths',
              'depositAmount',
              'rentAmount',
            ),
          ];
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
  return entry === null ? [] : [withConflictNote(entry, input.extracted, 'lockInMonths')];
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

  // A landlord side of zero is the point of the comparison, not a divide-by-zero to be clamped
  // away: "thirty times as much warning" understates a clause that provides for none at all.
  const detail =
    landlord === 0
      ? `The tenant must give ${tenant} days notice. The landlord may end the tenancy with none at all.`
      : `The tenant must give ${tenant} days notice. The landlord must give ${landlord}. ` +
        `That is ${round(tenant / landlord)} times as much warning one way as the other.`;

  const entry = candidate('notice-asymmetry', clause, source.quote, detail, input.jurisdiction);
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
  return entry === null ? [] : [withConflictNote(entry, input.extracted, 'entryNoticeHours')];
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
  return entry === null ? [] : [withConflictNote(entry, input.extracted, 'lateFeePercent')];
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
  return entry === null ? [] : [withConflictNote(entry, input.extracted, 'renewalIncreasePercent')];
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
  return entry === null ? [] : [withConflictNote(entry, input.extracted, 'termMonths')];
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
