/**
 * Deterministic parsing of the numbers a lease states.
 *
 * Amounts are hard and are treated as such. Real agreements say `Rs. 50,000/-`,
 * `₹ 2,00,000 (Rupees Two Lakh only)`, `$2,450.00`, `£1,200`, `fifty thousand rupees only`,
 * and `two (2) months' rent`. All of it is parsed here, in code, with tests — because the
 * alternative is asking a model to do arithmetic, and a model that multiplies is a model that
 * will eventually tell someone their deposit is three times the legal cap when it is not.
 *
 * The rule the whole engine rests on: **anything numeric, statutory or comparative is computed in
 * TypeScript. The model extracts and explains; it never calculates and never cites law.**
 */

import { splitSentences } from '../util/text.ts';

export interface ParsedAmount {
  readonly value: number;
  /** ISO-ish code where a symbol or name identified one. */
  readonly currency: string | null;
  /** The exact source text, so a finding can quote what it parsed. */
  readonly source: string;
  /** Offset of the figure within the text it was read from, so it can be tied to what names it. */
  readonly at: number;
}

const CURRENCY_BY_SYMBOL: readonly { readonly pattern: RegExp; readonly code: string }[] = [
  { pattern: /(?:₹|\bRs\.?\b|\bINR\b|\brupees?\b)/i, code: 'INR' },
  { pattern: /(?:£|\bGBP\b|\bpounds?\b)/i, code: 'GBP' },
  { pattern: /(?:\$|\bUSD\b|\bdollars?\b)/i, code: 'USD' },
  { pattern: /(?:€|\bEUR\b|\beuros?\b)/i, code: 'EUR' },
];

export function detectCurrency(text: string): string | null {
  return CURRENCY_BY_SYMBOL.find((entry) => entry.pattern.test(text))?.code ?? null;
}

/**
 * The number-word tables are `Map`s, not object literals, on purpose. A lookup by a word taken from
 * the document must never reach `Object.prototype`: with a plain object, `UNITS['constructor']` is a
 * function, so "Rupees constructor two lakh" read as a number word, poisoned the running total and
 * returned null instead of 200,000. A `Map` has no inherited keys to find.
 */
const UNITS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  }),
);

const TENS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    twenty: 20,
    thirty: 30,
    forty: 40,
    fourty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  }),
);

const SCALES: ReadonlyMap<string, number> = new Map(
  Object.entries({
    hundred: 100,
    thousand: 1000,
    lakh: 100_000,
    lakhs: 100_000,
    lac: 100_000,
    lacs: 100_000,
    million: 1_000_000,
    crore: 10_000_000,
    crores: 10_000_000,
    billion: 1_000_000_000,
  }),
);

/**
 * What a token adds to the group being built: a digit run, a unit word or a tens word.
 *
 * `undefined` means the token is not additive — it may still be a scale word, or not a number at
 * all. Units are consulted before tens, though no word is in both tables.
 */
function additiveValue(token: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number.parseFloat(token);
  return UNITS.get(token) ?? TENS.get(token);
}

/**
 * Parse an English number phrase, including Indian lakh and crore.
 *
 * Handles "fifty thousand", "two lakh", "twenty-four", "one hundred and fifty", "1.5 crore".
 * Returns null rather than a partial reading, because a half-parsed amount is worse than none.
 */
export function wordsToNumber(phrase: string): number | null {
  const tokens = phrase
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9. ]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && token !== 'and' && token !== 'only');
  if (tokens.length === 0) return null;

  let total = 0;
  let current = 0;
  let sawAnything = false;

  for (const token of tokens) {
    const addend = additiveValue(token);
    if (addend !== undefined) {
      current += addend;
      sawAnything = true;
      continue;
    }

    const scale = SCALES.get(token);
    if (scale !== undefined) {
      if (!sawAnything) return null;
      // With nothing pending (straight after another scale word), a scale counts one of itself.
      const multiplier = current === 0 ? 1 : current;
      if (scale === 100) {
        current = multiplier * 100;
      } else {
        total += multiplier * scale;
        current = 0;
      }
      continue;
    }

    // Before the number starts, an unrecognised word is a prefix to skip — "Rupees Two Lakh"
    // leads with a currency name. Once digits are flowing, an unrecognised word ends the phrase,
    // so "fifty thousand rupees and other terms" stops at the right place.
    if (!sawAnything) continue;
    break;
  }

  if (!sawAnything) return null;
  const value = total + current;
  return value > 0 ? value : null;
}

/**
 * Parse a digit-grouped figure, handling Indian grouping.
 *
 * `2,00,000` is two lakh, not two hundred thousand grouped oddly — but they are the same number,
 * so stripping separators is correct for both conventions. What matters is not treating the comma
 * as a decimal point, which is why the decimal is detected explicitly.
 */
export function parseGroupedNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (cleaned.length === 0) return null;

  // A trailing ",00" style decimal comma is not used in any jurisdiction LexMind covers, so the
  // dot is the decimal separator and every comma is a group separator.
  const normalised = cleaned.replace(/,/g, '');
  const value = Number.parseFloat(normalised);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const AMOUNT_PATTERN =
  /(?:(₹|\$|£|€)\s*|(?:\bRs\.?|\bINR|\bUSD|\bGBP|\bEUR)\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/-)?|\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|lac|lacs|crore|crores|million|billion|and|-)\s*){2,})\b/gi;

/**
 * A bare digit run this long, with no grouping and no currency marker, is an identifier.
 *
 * Bank account numbers, IFSC codes and card numbers sit in the payment clause next to the words
 * "rent" and "deposit", and reading one as a money figure produces a stated fact that is not
 * merely wrong but absurd. Anything genuinely this large in a lease is written with separators or
 * with a currency beside it, both of which survive this check.
 */
const IDENTIFIER_DIGITS = /^\d{7,}$/;

/**
 * True for the `2` in "two (2) months" — a parenthetical restating the number word before it.
 *
 * The digit gloss is the most common convention in Indian and US drafting, and reading it as a
 * money figure is how `two (2) months' rent` becomes a deposit of two rupees. It is not a second
 * amount; it is the same amount written twice, so only the first reading is kept.
 */
function isParentheticalGloss(text: string, at: number, source: string, value: number): boolean {
  const before = text.slice(0, at);
  if (!/\(\s*$/.test(before)) return false;
  if (!/^\s*\)/.test(text.slice(at + source.length))) return false;

  const preceding = before.replace(/\(\s*$/, '');
  const trailing = /([A-Za-z]+(?:[\s-][A-Za-z]+){0,3}|\d[\d,]*(?:\.\d+)?)\s*$/.exec(preceding);
  const restated = trailing?.[1];
  if (restated === undefined) return false;

  const parsed = /^\d/.test(restated) ? parseGroupedNumber(restated) : wordsToNumber(restated);
  return parsed === value;
}

/**
 * The numbering a clause opens with: "3. RENT", "ARTICLE 2 - RENT AND DEPOSIT", "5.2 Deposit".
 *
 * Everything from the start of the line to the figure must be the numbering itself, so a figure
 * mid-sentence is never mistaken for one.
 */
const CLAUSE_NUMBERING =
  /(?:^|\n)[ \t]*(?:(?:article|section|clause|para|paragraph|item|part|schedule|annexure)\s+)?(?:\d+[.)]\s*)*$/i;

/** Above this a leading integer is a figure rather than a clause number. */
const CLAUSE_NUMBER_MAX = 99;

/**
 * True for the `3` in "3. SECURITY DEPOSIT" — the clause's own number, not a sum of money.
 *
 * It matters because the number sits *immediately before* the words naming the clause's subject,
 * which is precisely the position a figure has to be in to be read as that subject's amount. A
 * deposit of "5" read off the heading "5. SECURITY DEPOSIT" would be compared to a statutory cap.
 */
function isClauseNumber(
  text: string,
  at: number,
  source: string,
  currency: string | null,
): boolean {
  // "5.2" is a numbering path, not five rupees and twenty paise.
  if (currency !== null || !/^\d+(?:\.\d+)?$/.test(source)) return false;
  if (Number.parseFloat(source) > CLAUSE_NUMBER_MAX) return false;
  return CLAUSE_NUMBERING.test(text.slice(0, at));
}

/**
 * A scale word standing immediately after a digit figure, as in "Rs. 2 lakh" or "1.5 crore".
 *
 * Indian drafting mixes the two notations freely, and a parser that reads only `2,00,000` or only
 * `two lakh` reads half of them.
 */
const TRAILING_SCALE = /^\s*(lakhs?|lacs?|crores?|thousand|million|billion|hundred)\b/i;

/** Every amount in a piece of text, in document order. */
export function parseAmounts(text: string): readonly ParsedAmount[] {
  const found: ParsedAmount[] = [];

  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const source = match[0].trim();
    const digits = match[2];
    const words = match[3];

    const value = digits !== undefined ? parseGroupedNumber(digits) : wordsToNumber(words ?? '');
    if (value === null) continue;

    // Look a little either side for a currency marker, since "Rs." often precedes and "rupees"
    // often follows.
    const at = match.index ?? 0;
    const context = text.slice(Math.max(0, at - 12), at + source.length + 20);
    const currency = detectCurrency(context);
    const grouped = digits?.replace(/,+$/, '');

    if (grouped !== undefined && currency === null && IDENTIFIER_DIGITS.test(grouped)) continue;
    if (isClauseNumber(text, at, source, currency)) continue;
    if (isParentheticalGloss(text, at, source, value)) continue;

    const scale = digits === undefined ? null : TRAILING_SCALE.exec(text.slice(at + source.length));
    const multiplier = scale === null ? 1 : (SCALES.get((scale[1] ?? '').toLowerCase()) ?? 1);
    const scaled = scale === null ? source : text.slice(at, at + source.length + scale[0].length);

    found.push({ value: value * multiplier, currency, source: scaled, at });
  }

  return found;
}

/** The largest amount in a piece of text — usually the figure the clause is about. */
export function largestAmount(text: string): ParsedAmount | null {
  const amounts = parseAmounts(text);
  if (amounts.length === 0) return null;
  return amounts.reduce((best, current) => (current.value > best.value ? current : best));
}

/**
 * How far *before* a figure the word naming it may sit, when the label follows the figure.
 *
 * "$1,800 shall be paid as rent" and "25,000 rupees as rent each month" are ordinary drafting, and
 * a forward-only rule reads neither. The backward window is short because a label that trails its
 * figure trails it closely; a distant one is naming something else.
 */
const LABEL_AFTER_WINDOW = 40;

/** Where a naming word starts and finishes. */
export interface CueSpan {
  readonly start: number;
  readonly end: number;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every occurrence of `cue` in `text`, matched on word boundaries and without lower-casing.
 *
 * Two bugs live in the obvious `haystack.toLowerCase().indexOf(needle)`:
 *
 *  - It finds `rent` inside "cur**rent** market value" and `bond` inside "abs**cond**", and a
 *    figure bound to a false cue becomes a stated fact with a citation behind it.
 *  - `'İ'.toLowerCase()` is two code units, so every offset after a Turkish dotted capital — or
 *    any of the other expanding case foldings — is shifted relative to the text the offsets are
 *    used against. Matching case-insensitively over the original string removes the class of bug
 *    rather than the instance.
 */
export function cueOccurrences(text: string, cue: string): readonly CueSpan[] {
  const needle = cue.trim();
  if (needle.length === 0) return [];

  const lead = /^\w/.test(needle) ? '\\b' : '';
  const tail = /\w$/.test(needle) ? '\\b' : '';
  const pattern = new RegExp(`${lead}${escapeRegExp(needle)}${tail}`, 'gi');

  const spans: CueSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

/** A span of the source text, with the text itself. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * An abbreviation whose full stop is not a full stop.
 *
 * `Rs.` is the one that matters most: "a security deposit of Rs. 2,00,000" is how an Indian lease
 * states its deposit, and a splitter that takes that dot as a sentence end puts the words naming
 * the sum in one sentence and the sum itself in the next.
 */
const ABBREVIATION_END =
  /(?:^|[\s("'])(?:Rs|INR|No|Nos|Mr|Mrs|Ms|Dr|Sr|Jr|St|Ltd|Pvt|Inc|Co|Corp|Ref|Approx|Fig|Sec|Cl|Art|vs|viz|etc|i\.e|e\.g|u\.s\.c)\.$/i;

/**
 * Sentences for the purpose of tying a figure to the word that names it.
 *
 * The canonical splitter in `util/text.ts` is shared by readability scoring and by quote
 * anchoring, where being conservative is the right trade; it is also deliberately frozen, because
 * every offset in the system is measured against it. The abbreviation join belongs here instead,
 * where it changes nothing but which words count as being in the same breath as a number.
 */
export function subjectSentences(text: string): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;

  for (const sentence of splitSentences(text)) {
    const at = text.indexOf(sentence, cursor);
    if (at === -1) continue;
    cursor = at + sentence.length;

    const previous = spans[spans.length - 1];
    if (previous !== undefined && ABBREVIATION_END.test(previous.text)) {
      spans[spans.length - 1] = {
        start: previous.start,
        end: cursor,
        text: text.slice(previous.start, cursor),
      };
      continue;
    }
    spans.push({ start: at, end: cursor, text: sentence });
  }

  return spans.length === 0 ? [{ start: 0, end: text.length, text }] : spans;
}

/** How well a figure is tied to a naming word: lower is better, `null` when it is not tied at all. */
function subjectRank(
  amount: ParsedAmount,
  cues: readonly CueSpan[],
  sentence: TextSpan,
): readonly [number, number] | null {
  const end = amount.at + amount.source.length;
  let forward = Number.POSITIVE_INFINITY;
  let backward = Number.POSITIVE_INFINITY;

  for (const cue of cues) {
    if (cue.start < sentence.start || cue.end > sentence.end) continue;
    if (cue.end <= amount.at) forward = Math.min(forward, amount.at - cue.end);
    else if (cue.start >= end) backward = Math.min(backward, cue.start - end);
  }

  if (forward !== Number.POSITIVE_INFINITY) return [0, forward];
  if (backward <= LABEL_AFTER_WINDOW) return [1, backward];
  return null;
}

/**
 * The figure a piece of text states **for a named subject**, rather than the largest figure in it.
 *
 * Leases routinely put two money terms in one article — "ARTICLE 2 - RENT AND DEPOSIT. Tenant
 * shall pay rent of $1,800 per month. Tenant shall pay a security deposit of $3,600." — and the
 * largest-figure heuristic then reads the deposit as the rent and concludes that the deposit is
 * one month of rent. Since that reading is the input to a statutory cap comparison, getting it
 * wrong is not a cosmetic error: it is the difference between reporting a breach of the cap and
 * silently clearing it.
 *
 * The subject and its figure must be in the **same sentence**. A character window cannot express
 * that: at 80 characters it reaches across a full stop into "The Licensee has paid a brokerage of
 * Rs. 5,000", reading a brokerage as the rent and then reporting a deposit of forty months of a
 * rent the document never states — a hallucination with a number in it, produced deterministically.
 * At the same time a window that short cannot reach the figure at the end of a long, properly
 * drafted sentence. The sentence is the unit that means what the window was trying to approximate.
 *
 * `cues` are the clause-type synonyms from the taxonomy, so covering a new drafting word stays a
 * data change.
 */
export function amountForSubject(text: string, cues: readonly string[]): ParsedAmount | null {
  return subjectAmounts(text, cues)[0]?.amount ?? null;
}

/** A figure with the strength of its tie to the naming word, so callers can rank across sentences. */
export interface SubjectAmount {
  readonly amount: ParsedAmount;
  /** 0 when the naming word comes before the figure, 1 when it follows it. */
  readonly direction: 0 | 1;
  /** Characters between the naming word and the figure. */
  readonly gap: number;
}

/**
 * Every figure in `text` that a cue names, best-tied first.
 *
 * Exposed as well as `amountForSubject` because attributing an amount across a whole clause needs
 * the strength of each tie, not just the winner within one sentence: "ARTICLE 2 - RENT AND DEPOSIT.
 * Tenant shall pay rent of $1,800 per month. Tenant shall pay a security deposit of $3,600." offers
 * the deposit two candidates, and it is the four characters between "security deposit of" and
 * "$3,600" that settle it.
 */
export function subjectAmounts(text: string, cues: readonly string[]): readonly SubjectAmount[] {
  const cueSpans = cues.flatMap((cue) => cueOccurrences(text, cue));
  if (cueSpans.length === 0) return [];
  const sentences = subjectSentences(text);

  const found: SubjectAmount[] = [];
  for (const amount of parseAmounts(text)) {
    const sentence = sentences.find((span) => amount.at >= span.start && amount.at < span.end);
    if (sentence === undefined) continue;

    const rank = subjectRank(amount, cueSpans, sentence);
    if (rank === null) continue;
    found.push({ amount, direction: rank[0] === 0 ? 0 : 1, gap: rank[1] });
  }

  // A tie goes to the larger figure: "£500 of the £7,200 deposit" names the deposit twice, and
  // the deposit is the larger of the two.
  return found.sort(
    (a, b) => a.direction - b.direction || a.gap - b.gap || b.amount.value - a.amount.value,
  );
}

/**
 * A tens word joined to a unit word: "forty-five", "twenty one".
 *
 * Offered ahead of the single words in every duration pattern. A pattern that knows only "five"
 * finds it inside "forty-five (45) days" and reads a forty-five day notice as five days — which
 * silently turns a tenant who must give far more warning than the landlord into one who gives less.
 */
const COMPOUND_NUMBER =
  '(?:twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)[\\s-](?:one|two|three|four|five|six|seven|eight|nine)';

/**
 * Refuse a figure that starts inside a larger number phrase.
 *
 * "one hundred and twenty days" is not twenty days, and "one hundred and twenty-five days" is not
 * five. Where the whole phrase is not something these patterns read, abstaining is the honest
 * answer: a half-read duration is worse than none.
 */
const NOT_INSIDE_A_LARGER_NUMBER =
  '(?<!\\b(?:twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)[\\s-]+(?:and[\\s-]+)?)';

/** A number — digits, a compound, or one of `words` — with an optional "(45)" gloss, then `tail`. */
function numberPhrasePattern(words: string, tail: string): RegExp {
  return new RegExp(
    `${NOT_INSIDE_A_LARGER_NUMBER}\\b((?:\\d+|${COMPOUND_NUMBER}|${words})(?:\\s*\\(\\d+\\))?)${tail}`,
    'i',
  );
}

const MONTHS_PATTERN = numberPhrasePattern(
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[\\s-]?four|thirty[\\s-]?six',
  '\\s*(month|months|year|years)\\b',
);

/** A duration in months. "one year" is twelve, "eleven (11) months" is eleven. */
export function parseDurationMonths(text: string): number | null {
  const match = MONTHS_PATTERN.exec(text);
  if (match === null) return null;

  const raw = (match[1] ?? '').replace(/\(\d+\)/, '').trim();
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : wordsToNumber(raw);
  if (value === null) return null;

  const unit = (match[2] ?? '').toLowerCase();
  return unit.startsWith('year') ? value * 12 : value;
}

const DAYS_PATTERN = numberPhrasePattern(
  'one|two|three|four|five|six|seven|eight|nine|ten|fourteen|fifteen|twenty|thirty|forty|fourty|sixty|ninety',
  '\\s*(day|days|week|weeks|month|months)\\b',
);

/** A duration in days, so notice periods stated in different units can be compared. */
export function parseDurationDays(text: string): number | null {
  const match = DAYS_PATTERN.exec(text);
  if (match === null) return null;

  const raw = (match[1] ?? '').replace(/\(\d+\)/, '').trim();
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : wordsToNumber(raw);
  if (value === null) return null;

  const unit = (match[2] ?? '').toLowerCase();
  if (unit.startsWith('week')) return value * 7;
  if (unit.startsWith('month')) return value * 30;
  return value;
}

const HOURS_PATTERN = numberPhrasePattern(
  'one|two|three|six|twelve|twenty[\\s-]?four|forty[\\s-]?eight|seventy[\\s-]?two',
  '\\s*(hour|hours)\\b',
);

/** A notice period in hours, for entry clauses. A day-stated period converts. */
export function parseHours(text: string): number | null {
  const match = HOURS_PATTERN.exec(text);
  if (match !== null) {
    const raw = (match[1] ?? '').replace(/\(\d+\)/, '').trim();
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : wordsToNumber(raw);
    if (value !== null) return value;
  }
  const days = parseDurationDays(text);
  return days === null ? null : days * 24;
}

const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:%|per\s?cent)/i;

export function parsePercent(text: string): number | null {
  const match = PERCENT_PATTERN.exec(text);
  if (match === null) return null;
  const value = Number.parseFloat(match[1] ?? '');
  return Number.isFinite(value) ? value : null;
}

const MULTIPLE_OF_RENT = numberPhrasePattern(
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve',
  "\\s*(?:months?|weeks?)(?:'|’)?\\s*(?:of\\s+)?(?:rent|licence fee|license fee|compensation)",
);

/**
 * A deposit expressed as a multiple of rent, e.g. "two months' rent", "three months licence fee".
 *
 * Resolved against the extracted rent in `facts.ts` rather than asked of the model, which is the
 * same rule stated once more: the model does not multiply.
 */
export function parseMultipleOfRent(text: string): { months: number; weeks: boolean } | null {
  const match = MULTIPLE_OF_RENT.exec(text);
  if (match === null) return null;

  const raw = (match[1] ?? '').replace(/\(\d+\)/, '').trim();
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : wordsToNumber(raw);
  if (value === null) return null;

  const weeks = /weeks?/i.test(match[0]);
  return { months: weeks ? value / 4.345 : value, weeks };
}
