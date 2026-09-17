import { clauseType } from '../domain/clause-types.ts';
import { type Clause, EMPTY_FACTS, type LeaseFacts, type Party } from '../domain/types.ts';
import { splitSentences } from '../util/text.ts';
import {
  detectCurrency,
  largestAmount,
  parseDurationDays,
  parseDurationMonths,
  parseHours,
  parseMultipleOfRent,
  parsePercent,
  subjectAmounts,
  subjectSentences,
} from './amounts.ts';
import { type ClauseTyping, clausesOfType } from './detect.ts';

/**
 * Deterministic fact extraction.
 *
 * Everything here runs locally, in microseconds, with no model call — which is why the UI can show
 * real numbers before any AI response arrives, and why the product still works when the free-tier
 * quota is gone. The model's role is to *explain* these facts, never to produce them.
 *
 * Every fact carries evidence: the clause it came from and the sentence that states it. A number
 * with no quote behind it cannot be cited, and anything LexMind cannot cite, it does not show.
 */

export interface FactEvidence {
  readonly clauseId: string;
  /** The sentence that states the fact, ready to be verified against the source text. */
  readonly quote: string;
}

export interface PartyNotice {
  readonly party: Party;
  readonly days: number;
  readonly clauseId: string;
  readonly quote: string;
}

export type FactKey = keyof LeaseFacts;

/**
 * Two clauses state the same term differently, and LexMind had to pick one.
 *
 * It is recorded rather than resolved silently because document order is written by the landlord.
 * A lease that says "the security deposit of 1,000 has already been settled" three paragraphs
 * above "a security deposit of 5,000" is not an ambiguity to be smoothed over: whichever figure is
 * used, a statutory comparison rests on it, and **a suppressed finding must never look the same as
 * an absent one**. The reader is told what the other clause said and which one was used.
 */
export interface FactConflict {
  readonly key: FactKey;
  readonly used: number;
  readonly usedClauseId: string;
  readonly alsoStated: readonly number[];
  readonly otherClauseIds: readonly string[];
  /** The same thing, in the reader's words. */
  readonly note: string;
}

export interface ExtractedFacts {
  readonly facts: LeaseFacts;
  readonly evidence: Readonly<Partial<Record<FactKey, FactEvidence>>>;
  readonly notices: readonly PartyNotice[];
  /** Where the document contradicts itself about a number. Never empty silently. */
  readonly conflicts: readonly FactConflict[];
  /** Every conflict, plus any reading LexMind declined to make, in plain English. */
  readonly notes: readonly string[];
}

/** The sentence inside a clause that contains a given fragment. Keeps quotes short and citable. */
export function sentenceContaining(clauseText: string, fragment: string): string {
  if (fragment.length === 0) return clauseText;
  const sentences = splitSentences(clauseText);
  const found = sentences.find((sentence) => sentence.includes(fragment));
  return found ?? clauseText;
}

const LANDLORD_WORDS = ['landlord', 'lessor', 'licensor', 'owner'];
const TENANT_WORDS = ['tenant', 'lessee', 'licensee'];
const MUTUAL_WORDS = ['either party', 'both parties', 'each party', 'either of the parties'];

/**
 * Whose obligation is this sentence about?
 *
 * The role word that appears first is taken as the actor. It is a heuristic and it is the right
 * one for legal drafting, which is overwhelmingly "The <party> shall <do something>" — subject
 * first, verb second.
 */
export function actingParty(sentence: string): Party {
  const lower = sentence.toLowerCase();
  if (MUTUAL_WORDS.some((word) => lower.includes(word))) return 'both';

  const landlordAt = Math.min(
    ...LANDLORD_WORDS.map((word) => {
      const at = lower.indexOf(word);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    }),
  );
  const tenantAt = Math.min(
    ...TENANT_WORDS.map((word) => {
      const at = lower.indexOf(word);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    }),
  );

  if (landlordAt === Number.POSITIVE_INFINITY && tenantAt === Number.POSITIVE_INFINITY) {
    return 'unknown';
  }
  return landlordAt < tenantAt ? 'landlord' : 'tenant';
}

const NOTICE_MENTION = /\bnotice\b|\bterminat|\bvacate\b|\bend this\b|\bquit\b/i;

/** The sentence is about bringing the tenancy to an end, rather than about entry or repairs. */
const ENDS_THE_TENANCY =
  /\bterminat|\bvacate\b|\bquit\b|\bend (?:this|the) (?:tenancy|agreement|lease|licence|license)\b|\brecover possession\b|\brepossess/i;

/** The sentence says the right may be exercised with no warning. */
const NO_WARNING =
  /\b(?:at any time|without (?:prior |any )?notice|with immediate effect|forthwith|immediately)\b/i;

/**
 * The sentence grants a *right* to bring the tenancy to an end, rather than describing what
 * follows once it has ended.
 *
 * "If the Tenant terminates, all outstanding rent becomes due immediately" ends nothing and grants
 * nobody anything; the word "immediately" belongs to the payment. Reading it as a notice period
 * would put a zero into the asymmetry comparison on the strength of an adverb about money.
 */
const RIGHT_TO_END =
  /\b(?:may|can|shall be entitled to|is entitled to|shall have the right to|reserves the right to|is at liberty to|shall be at liberty to)\s+(?:\w+\s+){0,4}?(?:terminat|revoke|cancel|re-?enter|recover|repossess|evict|end|determine|vacate|quit|forfeit)/i;

/**
 * Every mention of notice that is a *denial* of one rather than a requirement for one.
 *
 * Global, because a sentence can deny notice twice and still require it once.
 */
const NOTICE_DENIED =
  /\b(?:without|no|sans)\s+(?:(?:prior|any|further|advance|written|separate|additional)\s+){0,3}notices?\b/gi;

/**
 * The notice a sentence states, in days.
 *
 * **Zero is a value, not a missing one.** "The landlord may terminate at any time" says the warning
 * the tenant gets is none, and that is exactly the fact the asymmetry finding compares against —
 * the same distinction the entry rule already draws, where no-notice entry is a finding and an
 * unstated entry notice is an abstention.
 *
 * The axis that decides between zero and abstention is the mention of notice itself, not the verb
 * in front of it. A closed list of verbs — `giving|serving|service of|upon|on` — reads "by serving
 * notice" correctly and then asserts "no warning at all" for *by written notice*, *with notice in
 * writing*, *after notice*, *following written notice*, *having served notice*, *subject to notice
 * being given* and every other way a drafter can say the same thing. Inverted, the rule is: if the
 * word "notice" survives at all once the denials of it are removed, the document requires a notice
 * and LexMind will not say how long it is. Only a right exercisable *at any time* with no surviving
 * mention of notice is a stated zero.
 */
export function noticeDaysIn(sentence: string): number | null {
  const stated = parseDurationDays(sentence);
  if (stated !== null) return stated;
  if (!ENDS_THE_TENANCY.test(sentence) || !RIGHT_TO_END.test(sentence)) return null;
  if (!NO_WARNING.test(sentence)) return null;
  // A notice is required; the document simply does not quantify it. That is an abstention.
  if (/\bnotices?\b/i.test(sentence.replace(NOTICE_DENIED, ' '))) return null;
  return 0;
}

/**
 * Notice periods, per party.
 *
 * This is the input to the asymmetry finding, which is the most generalisable signal LexMind has:
 * a thirty-day / two-day split is a finding in any jurisdiction on earth, with no statute needed.
 */
export function extractNotices(clauses: readonly Clause[]): readonly PartyNotice[] {
  const notices: PartyNotice[] = [];

  for (const clause of clauses) {
    for (const sentence of splitSentences(clause.text)) {
      if (!NOTICE_MENTION.test(sentence)) continue;

      const days = noticeDaysIn(sentence);
      if (days === null) continue;

      const party = actingParty(sentence);
      if (party === 'unknown') continue;

      if (party === 'both') {
        notices.push({ party: 'landlord', days, clauseId: clause.id, quote: sentence });
        notices.push({ party: 'tenant', days, clauseId: clause.id, quote: sentence });
        continue;
      }
      notices.push({ party, days, clauseId: clause.id, quote: sentence });
    }
  }

  return notices;
}

/**
 * The notice that actually matters for a party, which is a different figure for each of them.
 *
 * For the **tenant** it is the longest period they must give: the heaviest burden is the one that
 * binds, and a document offering them a shorter route elsewhere does not relieve them of the
 * longer one.
 *
 * For the **landlord** it is the shortest period the tenant can be given: what matters to someone
 * whose home is at stake is the *least* warning they may get, not the most. Taking the maximum on
 * both sides quietly discards exactly the fact the zero exists to carry — "thirty days notice to
 * vacate at the end of the term" followed by "notwithstanding the foregoing, the landlord may
 * terminate at any time" reads as a symmetrical thirty-day arrangement, which is the opposite of
 * what the document does.
 */
function bindingNoticeFor(notices: readonly PartyNotice[], party: Party): PartyNotice | undefined {
  const forParty = notices.filter((notice) => notice.party === party);
  if (forParty.length === 0) return undefined;
  return party === 'landlord'
    ? forParty.reduce((least, current) => (current.days < least.days ? current : least))
    : forParty.reduce((worst, current) => (current.days > worst.days ? current : worst));
}

const NO_NOTICE_ENTRY =
  /\b(?:at any time|without (?:prior |any )?notice|without intimation|unannounced)\b/i;

/**
 * The words that name a money term, taken straight from the clause taxonomy.
 *
 * Reusing the taxonomy's synonyms rather than a second list here keeps one source of drafting
 * vocabulary: a new word for a deposit is added once, as data, and both clause typing and amount
 * attribution pick it up.
 */
const RENT_CUES = clauseType('rent').synonyms;
const DEPOSIT_CUES = clauseType('security-deposit').synonyms;

/**
 * A sentence that *imposes* the payment, rather than mentioning one.
 *
 * This is the difference between "The tenant shall pay a security deposit of 5,000" and "the
 * security deposit of 1,000 has already been settled in full", and it is tested only against the
 * part of the sentence **before** the figure, because that is where the obligation sits in every
 * drafting convention: subject, modal, verb, then the sum.
 */
const PAYMENT_OBLIGATION =
  /\b(?:shall|must|will|agrees?\s+to|undertakes?\s+to|is\s+required\s+to|has\s+agreed\s+to)\s+(?:\w+\s+){0,3}?(?:pay|paid|deposit|deposited|furnish|place|lodge|provide)\b|\b(?:payable|pays)\b/i;

/** A deposit above this many months of rent is not a reading LexMind will rest a statute on. */
export const MAX_CREDIBLE_DEPOSIT_MONTHS = 24;

/**
 * One sentence's claim to state a fact, with everything needed to rank it against the others.
 *
 * The unit is the sentence, not the clause, because an injected sentence inside the real clause
 * must be rankable against the real one.
 */
interface Reading {
  readonly value: number;
  readonly currency: string | null;
  readonly clause: Clause;
  readonly quote: string;
  /**
   * True when the figure was tied to its subject only by a word that *follows* it.
   *
   * "Rs. 75,000, being three months licence fee" characterises a deposit; it does not state the
   * rent. Such a reading can still be used when nothing better exists, but it is never treated as
   * a competing statement of the term for the purpose of reporting a contradiction.
   */
  readonly weak: boolean;
  /** Lower sorts first, compared element by element. */
  readonly rank: readonly number[];
}

function typingFor(typings: readonly ClauseTyping[], clause: Clause): ClauseTyping | undefined {
  return typings.find((typing) => typing.clauseId === clause.id);
}

/**
 * How strong a claim this sentence has to be *the* statement of the fact.
 *
 * In order: a sentence that imposes the payment beats one that merely mentions the sum; a clause
 * whose top-ranked type is the subject beats one where the subject is a secondary type; a clause
 * the taxonomy scores higher for that subject beats a lower-scoring one; and only then does
 * document order decide. Document order is written by the landlord, so it is the last word rather
 * than the first.
 */
function authorityRank(
  typing: ClauseTyping | undefined,
  typeId: string,
  imposed: boolean,
): readonly number[] {
  return [imposed ? 0 : 1, typing?.typeIds[0] === typeId ? 0 : 1, -(typing?.scores[typeId] ?? 0)];
}

function byRank(a: Reading, b: Reading): number {
  for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i += 1) {
    const difference = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Every sentence of every clause the taxonomy gave this type, in document order. */
function* typedSentences(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
  typeId: string,
): Generator<{
  clause: Clause;
  typing: ClauseTyping | undefined;
  sentence: string;
  order: number;
}> {
  let order = 0;
  for (const clause of clausesOfType(clauses, typings, typeId)) {
    const typing = typingFor(typings, clause);
    for (const span of subjectSentences(clause.text)) {
      yield { clause, typing, sentence: span.text, order };
      order += 1;
    }
  }
}

/** Every figure stated for a money subject, one reading per sentence that states one. */
function moneyReadings(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
  typeId: string,
  cues: readonly string[],
): readonly Reading[] {
  const readings: Reading[] = [];

  for (const { clause, typing, sentence, order } of typedSentences(clauses, typings, typeId)) {
    const best = subjectAmounts(sentence, cues)[0];
    if (best === undefined) continue;
    const { amount } = best;
    const imposed = PAYMENT_OBLIGATION.test(sentence.slice(0, amount.at));
    readings.push({
      value: amount.value,
      // The currency is a property of the document rather than of the sentence: "Rs. 25,000" is
      // split from its own figure by any sentence splitter that treats "Rs." as a full stop.
      currency: amount.currency ?? detectCurrency(clause.text),
      clause,
      quote: sentence,
      weak: best.direction === 1,
      // How tightly the figure is tied to the word naming it breaks the tie between two sentences
      // of equal standing: a caption three sentences up names the subject of all of them.
      rank: [...authorityRank(typing, typeId, imposed), best.direction, best.gap, order],
    });
  }

  return readings;
}

/** Every reading a per-sentence parser produces for a typed clause. */
function parsedReadings(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
  typeId: string,
  parse: (sentence: string) => number | null,
): readonly Reading[] {
  const readings: Reading[] = [];

  for (const { clause, typing, sentence, order } of typedSentences(clauses, typings, typeId)) {
    const value = parse(sentence);
    if (value === null) continue;
    readings.push({
      value,
      currency: null,
      clause,
      quote: sentence,
      weak: false,
      rank: [...authorityRank(typing, typeId, false), order],
    });
  }

  return readings;
}

function plainList(values: readonly number[]): string {
  return values.map((value) => value.toLocaleString('en-US')).join(', ');
}

/**
 * The disagreement between readings, when there is one worth telling the reader about.
 *
 * A figure stated in **another clause** is a competing statement of the same term and is always
 * reported: that is the shape every ordering attack takes. Within a single clause the nearest-cue
 * reading governs and a smaller figure alongside it is ordinarily a part of the same sum — "£500
 * of the £7,200 deposit" — so only a **larger** competing figure is reported there, because
 * under-stating what the tenant is exposed to is the more dangerous of the two errors.
 */
function conflictFor(key: FactKey, chosen: Reading, all: readonly Reading[]): FactConflict | null {
  const competing = all.filter(
    (reading) =>
      !reading.weak &&
      reading.value !== chosen.value &&
      (reading.clause.id !== chosen.clause.id || reading.value > chosen.value),
  );
  if (competing.length === 0) return null;

  const alsoStated = [...new Set(competing.map((reading) => reading.value))];
  const otherClauseIds = [...new Set(competing.map((reading) => reading.clause.id))];

  return {
    key,
    used: chosen.value,
    usedClauseId: chosen.clause.id,
    alsoStated,
    otherClauseIds,
    note:
      `This document states more than one figure for ${FACT_LABELS[key]}: ${plainList([chosen.value, ...alsoStated])}. ` +
      `LexMind read it as ${chosen.value.toLocaleString('en-US')}, from the clause that sets out the obligation, ` +
      'and every check below uses that figure. The other figure is in the document too, and worth reading yourself.',
  };
}

/** What each fact is called when LexMind has to talk about it. */
const FACT_LABELS: Readonly<Record<FactKey, string>> = {
  currency: 'the currency',
  rentAmount: 'the rent',
  rentPeriod: 'the rent period',
  depositAmount: 'the security deposit',
  depositMonths: 'the deposit in months of rent',
  termMonths: 'the length of the term',
  lockInMonths: 'the lock-in period',
  noticeDaysTenant: 'the notice the tenant must give',
  noticeDaysLandlord: 'the notice the landlord must give',
  entryNoticeHours: 'the notice before entry',
  lateFeePercent: 'the late payment charge',
  lateFeeAmount: 'the late payment charge',
  renewalIncreasePercent: 'the rent increase on renewal',
};

/** Facts, as they are built: the same shape as `LeaseFacts`, writable and still type-checked. */
type FactsDraft = { -readonly [K in keyof LeaseFacts]: LeaseFacts[K] };

/**
 * The accumulating result.
 *
 * `draft` is typed as `LeaseFacts` rather than `Record<string, unknown>` so that a mistyped key or
 * a string written into a number field is a compile error here, in the one function that populates
 * it, rather than a `null` that appears three layers away in the UI.
 */
interface Accumulator {
  readonly draft: FactsDraft;
  readonly evidence: Partial<Record<FactKey, FactEvidence>>;
  readonly conflicts: FactConflict[];
  readonly notes: string[];
}

function emptyAccumulator(): Accumulator {
  return { draft: { ...EMPTY_FACTS }, evidence: {}, conflicts: [], notes: [] };
}

/**
 * Take the best-supported reading for a fact, and record any disagreement rather than resolving it
 * silently.
 */
function applyReadings<K extends FactKey>(
  into: Accumulator,
  key: K,
  readings: readonly Reading[],
  toValue: (reading: Reading) => LeaseFacts[K],
): Reading | undefined {
  if (readings.length === 0) return undefined;

  const chosen = [...readings].sort(byRank)[0];
  if (chosen === undefined) return undefined;

  into.draft[key] = toValue(chosen);
  into.evidence[key] = { clauseId: chosen.clause.id, quote: chosen.quote };

  const conflict = conflictFor(key, chosen, readings);
  if (conflict !== null) {
    into.conflicts.push(conflict);
    into.notes.push(conflict.note);
  }

  return chosen;
}

const PER_WEEK = /per\s+(?:week|wk)\b/i;
const PER_YEAR = /per\s+annum|\byearly\b|per\s+year/i;

function rentPeriodIn(text: string): LeaseFacts['rentPeriod'] {
  if (PER_WEEK.test(text)) return 'week';
  if (PER_YEAR.test(text)) return 'year';
  return 'month';
}

function extractRent(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  const chosen = applyReadings(
    into,
    'rentAmount',
    moneyReadings(clauses, typings, 'rent', RENT_CUES),
    (reading) => reading.value,
  );
  if (chosen === undefined) return;

  into.draft.currency = chosen.currency;
  into.draft.rentPeriod = rentPeriodIn(chosen.clause.text);
}

function extractDeposit(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  applyReadings(
    into,
    'depositAmount',
    moneyReadings(clauses, typings, 'security-deposit', DEPOSIT_CUES),
    (reading) => reading.value,
  );

  // A deposit stated as a multiple of rent is resolved against the extracted rent below, never by
  // asking a model to multiply.
  applyReadings(
    into,
    'depositMonths',
    parsedReadings(clauses, typings, 'security-deposit', (sentence) => {
      const multiple = parseMultipleOfRent(sentence);
      return multiple === null ? null : Math.round(multiple.months * 100) / 100;
    }),
    (reading) => reading.value,
  );
}

/**
 * The deposit as a multiple of rent, and the rent implied by a deposit stated as a multiple.
 *
 * This is the arithmetic the model is never allowed to do — and the place where a misread rent
 * turns into a confident statutory claim, so the ratio is only reported when it is credible. Forty
 * months of rent is not a deposit; it is evidence that one of the two figures was misread, and
 * "the deposit is 20 times the limit" cited to a statute would be a hallucination with a number in
 * it.
 */
function deriveDepositRatio(into: Accumulator): void {
  const { draft } = into;
  const rent = draft.rentAmount;
  const deposit = draft.depositAmount;

  if (draft.depositMonths === null && rent !== null && deposit !== null && rent > 0) {
    const months = Math.round((deposit / rent) * 100) / 100;
    if (months > 0 && months <= MAX_CREDIBLE_DEPOSIT_MONTHS) draft.depositMonths = months;
    else into.notes.push(unreliableRatioNote(months));
    return;
  }

  if (draft.depositAmount === null && rent !== null && draft.depositMonths !== null) {
    draft.depositAmount = Math.round(rent * draft.depositMonths);
  }
}

function unreliableRatioNote(months: number): string {
  return (
    `The deposit in this document is ${months} times the rent it states. That is too far outside ` +
    'normal practice for LexMind to treat as a reliable reading, so no deposit-to-rent comparison ' +
    'is reported and no limit is applied to it. Both figures are worth checking by eye.'
  );
}

/**
 * A stated multiple can be as implausible as a derived one, and the rule engine will decline to
 * compare either against a statute. Declining in silence is what makes a suppressed finding look
 * like an absent one, so the reason is recorded here whichever way the figure was arrived at.
 */
function noteImplausibleRatio(into: Accumulator): void {
  const months = into.draft.depositMonths;
  if (months === null) return;
  if (months > 0 && months <= MAX_CREDIBLE_DEPOSIT_MONTHS) return;
  into.notes.push(unreliableRatioNote(months));
}

function extractDurations(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  applyReadings(
    into,
    'termMonths',
    parsedReadings(clauses, typings, 'term-duration', parseDurationMonths),
    (reading) => reading.value,
  );
  applyReadings(
    into,
    'lockInMonths',
    parsedReadings(clauses, typings, 'lock-in', parseDurationMonths),
    (reading) => reading.value,
  );
}

function extractNoticePeriods(into: Accumulator, notices: readonly PartyNotice[]): void {
  for (const party of ['landlord', 'tenant'] as const) {
    const notice = bindingNoticeFor(notices, party);
    if (notice === undefined) continue;
    const key = party === 'landlord' ? 'noticeDaysLandlord' : 'noticeDaysTenant';
    into.draft[key] = notice.days;
    into.evidence[key] = { clauseId: notice.clauseId, quote: notice.quote };
  }
}

/**
 * Entry notice, in hours.
 *
 * "At any time without notice" is a zero, not a missing value, and the distinction matters: zero is
 * a finding, missing is an abstention. The smallest figure in the document wins, because what a
 * tenant is exposed to is the least warning the landlord may give, not the most generous sentence
 * in the clause. An emergency exception is read across the whole clause, as drafters write it.
 */
function extractEntryNotice(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  const readings: Reading[] = [];

  for (const { clause, typing, sentence, order } of typedSentences(
    clauses,
    typings,
    'inspection-entry',
  )) {
    const unannounced = NO_NOTICE_ENTRY.test(sentence) && !/emergency/i.test(clause.text);
    const hours = unannounced ? 0 : parseHours(sentence);
    if (hours === null) continue;
    readings.push({
      value: hours,
      currency: null,
      clause,
      quote: sentence,
      weak: false,
      // Least warning first: a right to enter unannounced is not cured by a notice period stated
      // for some other kind of visit.
      rank: [hours, ...authorityRank(typing, 'inspection-entry', false), order],
    });
  }

  applyReadings(into, 'entryNoticeHours', readings, (reading) => reading.value);
}

function extractLateFee(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  const percent = applyReadings(
    into,
    'lateFeePercent',
    parsedReadings(clauses, typings, 'late-fee', parsePercent),
    (reading) => reading.value,
  );
  if (percent !== undefined) return;

  applyReadings(
    into,
    'lateFeeAmount',
    parsedReadings(
      clauses,
      typings,
      'late-fee',
      (sentence) => largestAmount(sentence)?.value ?? null,
    ),
    (reading) => reading.value,
  );
}

function extractEscalation(
  into: Accumulator,
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): void {
  applyReadings(
    into,
    'renewalIncreasePercent',
    parsedReadings(clauses, typings, 'rent-escalation', parsePercent),
    (reading) => reading.value,
  );
}

/**
 * Every number LexMind reads out of a lease, with the evidence for each and the disagreements it
 * found on the way.
 *
 * Each extractor collects **every** candidate reading and ranks them, rather than taking the first
 * and stopping. First-match-then-break makes document order decisive, and document order is chosen
 * by whoever drafted the lease: a sentence placed above the real deposit clause could halve the
 * deposit LexMind reported and erase a statutory finding without leaving a trace. Collecting the
 * candidates costs microseconds and turns that attack into a note the reader can see.
 */
export function extractFacts(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): ExtractedFacts {
  const accumulator = emptyAccumulator();
  const notices = extractNotices(clauses);

  extractRent(accumulator, clauses, typings);
  extractDeposit(accumulator, clauses, typings);
  deriveDepositRatio(accumulator);
  noteImplausibleRatio(accumulator);
  extractDurations(accumulator, clauses, typings);
  extractNoticePeriods(accumulator, notices);
  extractEntryNotice(accumulator, clauses, typings);
  extractLateFee(accumulator, clauses, typings);
  extractEscalation(accumulator, clauses, typings);

  return {
    facts: accumulator.draft,
    evidence: accumulator.evidence,
    notices,
    conflicts: accumulator.conflicts,
    notes: accumulator.notes,
  };
}

/** The conflict recorded for a fact, when the reader needs telling alongside a finding. */
export function conflictNoteFor(
  extracted: ExtractedFacts,
  ...keys: readonly FactKey[]
): string | null {
  const found = extracted.conflicts.find((conflict) => keys.includes(conflict.key));
  return found?.note ?? null;
}
