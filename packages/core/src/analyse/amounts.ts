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

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90,
};

const SCALES: Readonly<Record<string, number>> = {
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
};

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
    const numeric = /^\d+(?:\.\d+)?$/.test(token) ? Number.parseFloat(token) : undefined;
    if (numeric !== undefined) {
      current += numeric;
      sawAnything = true;
      continue;
    }

    const unit = UNITS[token];
    if (unit !== undefined) {
      current += unit;
      sawAnything = true;
      continue;
    }

    const ten = TENS[token];
    if (ten !== undefined) {
      current += ten;
      sawAnything = true;
      continue;
    }

    const scale = SCALES[token];
    if (scale !== undefined) {
      if (!sawAnything) return null;
      if (scale === 100) {
        current = (current === 0 ? 1 : current) * 100;
      } else {
        total += (current === 0 ? 1 : current) * scale;
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
    const from = Math.max(0, (match.index ?? 0) - 12);
    const context = text.slice(from, (match.index ?? 0) + source.length + 20);

    found.push({ value, currency: detectCurrency(context), source, at: match.index ?? 0 });
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
 * How far after the word naming a figure that figure may still sit and be the one it names.
 *
 * Wide enough for "LICENCE FEE. The licensee shall pay Rs. 25,000", narrow enough that the next
 * sentence's figure does not drift in.
 */
const SUBJECT_WINDOW = 80;

/** Every position at which `needle` finishes inside `haystack`. */
function occurrenceEnds(haystack: string, needle: string): readonly number[] {
  if (needle.length === 0) return [];
  const ends: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return ends;
    ends.push(at + needle.length);
    from = at + needle.length;
  }
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
 * The rule applied here is the one a reader uses: a figure belongs to the nearest naming word
 * **before** it. `cues` are the clause-type synonyms from the taxonomy, so covering a new drafting
 * word stays a data change.
 */
export function amountForSubject(
  text: string,
  cues: readonly string[],
  window: number = SUBJECT_WINDOW,
): ParsedAmount | null {
  const lower = text.toLowerCase();
  const labelEnds = cues.flatMap((cue) => occurrenceEnds(lower, cue.toLowerCase()));
  if (labelEnds.length === 0) return null;

  let best: ParsedAmount | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const amount of parseAmounts(text)) {
    let gap = Number.POSITIVE_INFINITY;
    for (const end of labelEnds) {
      if (end > amount.at) continue;
      gap = Math.min(gap, amount.at - end);
    }
    if (gap > window) continue;
    // A tie goes to the larger figure: "£500 of the £7,200 deposit" names the deposit twice, and
    // the deposit is the larger of the two.
    if (gap < bestGap || (gap === bestGap && best !== null && amount.value > best.value)) {
      best = amount;
      bestGap = gap;
    }
  }

  return best;
}

const MONTHS_PATTERN =
  /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[\s-]?four|thirty[\s-]?six)(?:\s*\(\d+\))?)\s*(month|months|year|years)\b/i;

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

const DAYS_PATTERN =
  /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|fifteen|twenty|thirty|forty|fourty|sixty|ninety)(?:\s*\(\d+\))?)\s*(day|days|week|weeks|month|months)\b/i;

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

const HOURS_PATTERN =
  /\b((?:\d+|one|two|three|six|twelve|twenty[\s-]?four|forty[\s-]?eight|seventy[\s-]?two)(?:\s*\(\d+\))?)\s*(hour|hours)\b/i;

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

const MULTIPLE_OF_RENT =
  /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*\(\d+\))?)\s*(?:months?|weeks?)(?:'|’)?\s*(?:of\s+)?(?:rent|licence fee|license fee|compensation)/i;

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
