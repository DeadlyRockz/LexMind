import { clauseType } from '../domain/clause-types.ts';
import { EMPTY_FACTS, type Clause, type LeaseFacts, type Party } from '../domain/types.ts';
import { splitSentences } from '../util/text.ts';
import {
  amountForSubject,
  largestAmount,
  parseDurationDays,
  parseDurationMonths,
  parseHours,
  parseMultipleOfRent,
  parsePercent,
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

export interface ExtractedFacts {
  readonly facts: LeaseFacts;
  readonly evidence: Readonly<Partial<Record<FactKey, FactEvidence>>>;
  readonly notices: readonly PartyNotice[];
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
 * The sentence requires a notice but does not say how long it must be.
 *
 * That is an abstention, not a zero: "by serving a section 21 notice at any time" does require a
 * notice, and reading it as no-notice-at-all would invent a term the document does not contain.
 */
const NOTICE_REQUIRED_BUT_UNSTATED =
  /\b(?:giving|serving|service of|upon|on)\s+(?:\w+\s+){0,4}notice\b/i;

/**
 * The notice a sentence states, in days.
 *
 * **Zero is a value, not a missing one.** "The landlord may terminate at any time" says the warning
 * the tenant gets is none, and that is exactly the fact the asymmetry finding compares against —
 * the same distinction the entry rule already draws, where no-notice entry is a finding and an
 * unstated entry notice is an abstention. A sentence that requires a notice without quantifying it
 * still returns `null`, because LexMind reports what the document says and nothing else.
 */
export function noticeDaysIn(sentence: string): number | null {
  const stated = parseDurationDays(sentence);
  if (stated !== null) return stated;
  if (!ENDS_THE_TENANCY.test(sentence)) return null;
  if (!NO_WARNING.test(sentence)) return null;
  if (NOTICE_REQUIRED_BUT_UNSTATED.test(sentence)) return null;
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

/** The longest notice a party must give — the burden that actually binds them. */
function worstNoticeFor(
  notices: readonly PartyNotice[],
  party: Party,
): PartyNotice | undefined {
  const forParty = notices.filter((notice) => notice.party === party);
  if (forParty.length === 0) return undefined;
  return forParty.reduce((worst, current) => (current.days > worst.days ? current : worst));
}

const NO_NOTICE_ENTRY = /\b(?:at any time|without (?:prior |any )?notice|without intimation|unannounced)\b/i;

/**
 * The words that name a money term, taken straight from the clause taxonomy.
 *
 * Reusing the taxonomy's synonyms rather than a second list here keeps one source of drafting
 * vocabulary: a new word for a deposit is added once, as data, and both clause typing and amount
 * attribution pick it up.
 */
const RENT_CUES = clauseType('rent').synonyms;
const DEPOSIT_CUES = clauseType('security-deposit').synonyms;

export function extractFacts(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
): ExtractedFacts {
  const facts: Record<string, unknown> = { ...EMPTY_FACTS };
  const evidence: Partial<Record<FactKey, FactEvidence>> = {};

  const record = (key: FactKey, value: unknown, clause: Clause, fragment: string): void => {
    facts[key] = value;
    evidence[key] = { clauseId: clause.id, quote: sentenceContaining(clause.text, fragment) };
  };

  // ── Rent ─────────────────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'rent')) {
    const amount = amountForSubject(clause.text, RENT_CUES);
    if (amount === null) continue;
    record('rentAmount', amount.value, clause, amount.source);
    facts['currency'] = amount.currency;
    facts['rentPeriod'] = /per\s+(?:week|wk)\b/i.test(clause.text)
      ? 'week'
      : /per\s+annum|\byearly\b|per\s+year/i.test(clause.text)
        ? 'year'
        : 'month';
    break;
  }

  // ── Deposit ──────────────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'security-deposit')) {
    const amount = amountForSubject(clause.text, DEPOSIT_CUES);
    if (amount !== null) record('depositAmount', amount.value, clause, amount.source);

    const multiple = parseMultipleOfRent(clause.text);
    if (multiple !== null) {
      record('depositMonths', Math.round(multiple.months * 100) / 100, clause, '');
    }
    if (amount !== null || multiple !== null) break;
  }

  // A deposit stated as a flat figure still has a months value, computed here rather than by the
  // model. This is the arithmetic the model is never allowed to do.
  const rent = facts['rentAmount'];
  const deposit = facts['depositAmount'];
  if (
    facts['depositMonths'] === null &&
    typeof rent === 'number' &&
    typeof deposit === 'number' &&
    rent > 0
  ) {
    facts['depositMonths'] = Math.round((deposit / rent) * 100) / 100;
  }
  // Conversely, a deposit stated only as a multiple gets its amount computed.
  if (
    facts['depositAmount'] === null &&
    typeof rent === 'number' &&
    typeof facts['depositMonths'] === 'number'
  ) {
    facts['depositAmount'] = Math.round(rent * facts['depositMonths']);
  }

  // ── Term and lock-in ─────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'term-duration')) {
    const months = parseDurationMonths(clause.text);
    if (months === null) continue;
    record('termMonths', months, clause, '');
    break;
  }

  for (const clause of clausesOfType(clauses, typings, 'lock-in')) {
    const months = parseDurationMonths(clause.text);
    if (months === null) continue;
    record('lockInMonths', months, clause, '');
    break;
  }

  // ── Notice ───────────────────────────────────────────────────────────────────────────────────
  const notices = extractNotices(clauses);
  const landlordNotice = worstNoticeFor(notices, 'landlord');
  const tenantNotice = worstNoticeFor(notices, 'tenant');
  if (landlordNotice !== undefined) {
    facts['noticeDaysLandlord'] = landlordNotice.days;
    evidence['noticeDaysLandlord'] = {
      clauseId: landlordNotice.clauseId,
      quote: landlordNotice.quote,
    };
  }
  if (tenantNotice !== undefined) {
    facts['noticeDaysTenant'] = tenantNotice.days;
    evidence['noticeDaysTenant'] = { clauseId: tenantNotice.clauseId, quote: tenantNotice.quote };
  }

  // ── Entry notice ─────────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'inspection-entry')) {
    // "At any time without notice" is a zero, not a missing value, and the distinction matters:
    // zero is a finding, missing is an abstention.
    if (NO_NOTICE_ENTRY.test(clause.text) && !/emergency/i.test(clause.text)) {
      const match = NO_NOTICE_ENTRY.exec(clause.text);
      record('entryNoticeHours', 0, clause, match?.[0] ?? '');
      break;
    }
    const hours = parseHours(clause.text);
    if (hours === null) continue;
    record('entryNoticeHours', hours, clause, '');
    break;
  }

  // ── Late fee ─────────────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'late-fee')) {
    const percent = parsePercent(clause.text);
    if (percent !== null) record('lateFeePercent', percent, clause, '');

    const amount = largestAmount(clause.text);
    if (percent === null && amount !== null) {
      record('lateFeeAmount', amount.value, clause, amount.source);
    }
    if (percent !== null || amount !== null) break;
  }

  // ── Renewal increase ─────────────────────────────────────────────────────────────────────────
  for (const clause of clausesOfType(clauses, typings, 'rent-escalation')) {
    const percent = parsePercent(clause.text);
    if (percent === null) continue;
    record('renewalIncreasePercent', percent, clause, '');
    break;
  }

  return { facts: facts as unknown as LeaseFacts, evidence, notices };
}
