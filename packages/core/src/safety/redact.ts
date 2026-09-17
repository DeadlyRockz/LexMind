import {
  isValidIfscFormat,
  isValidLuhn,
  isValidNino,
  isValidNric,
  isValidPanFormat,
  isValidVerhoeff,
} from './checksums.ts';
import { boundedSource, type PartyRole, type PiiKind, SurrogateMap } from './surrogates.ts';

/**
 * PII redaction before transmission.
 *
 * This is not a feature bolted on at the end; it is the boundary condition the pipeline is built
 * around, and the reason is documented rather than assumed. Google's Gemini API Additional Terms
 * state, verbatim, for the unpaid tier: **"Do not submit sensitive, confidential, or personal
 * information to the Unpaid Services"**, that Google uses submitted content "to provide, improve,
 * and develop Google products and services and machine learning technologies", and that
 * **"human reviewers may read, annotate, and process your API input and output"**.
 *
 * A free key receiving raw tenancy agreements — names, addresses, ID numbers, bank details —
 * therefore violates the provider's own terms of use. So the model never sees raw PII.
 *
 * **Precision matters as much as recall.** A false "name" is not a harmless over-redaction: the
 * surrogate replaces that word everywhere it occurs, so the model reads a different lease and every
 * quote it copies fails verification. Name detection once ran case-insensitively, where `\p{Lu}`
 * matches lowercase letters too; a lease with no names in it had "and", "to" and "fourteen"
 * replaced with people, and "made between the landlord and the tenant" reached the model as "made
 * between the landlord Nina the tenant". So names are matched case-sensitively, the words beside
 * them in any case, and every candidate must survive a data-driven stop list.
 *
 * **What this is not.** Automated PII detection is a strong mitigation and never a guarantee.
 * Even a vendor's own favourable figures put name-detection F1 at roughly 87 to 90 per cent —
 * about one name in eight missed — and location recall drops to around 0.46 on out-of-distribution
 * text. Presidio's own documentation states there is "no guarantee that Presidio will find all
 * sensitive information". LexMind says the same in its UI and its README, and discloses
 * transmission regardless of how well redaction performed.
 */

export interface RedactionResult {
  /** The text safe to transmit. */
  readonly text: string;
  /** In-process only. See `SurrogateMap`. */
  readonly map: SurrogateMap;
  /** Counts by kind. Safe to log and to display; holds no values. */
  readonly summary: Readonly<Record<string, number>>;
}

interface PatternDetector {
  readonly kind: Exclude<PiiKind, 'person' | 'address'>;
  /** The whole match is the identifier; any context it needs sits in a lookbehind. */
  readonly pattern: RegExp;
  /** Validate a shape match, so "any twelve digits" does not redact half the document. */
  readonly validate?: (value: string) => boolean;
}

const DETECTORS: readonly PatternDetector[] = [
  {
    // The lookbehind starts a match only where a local part can start. Without it, every position
    // inside a long token began a fresh scan to its end, and 50,000 characters took over a second.
    kind: 'email',
    pattern: /(?<![\p{L}0-9._%+-])[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu,
  },
  {
    kind: 'card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: isValidLuhn,
  },
  {
    kind: 'aadhaar',
    pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
    validate: isValidVerhoeff,
  },
  { kind: 'pan', pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, validate: isValidPanFormat },
  { kind: 'ifsc', pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, validate: isValidIfscFormat },
  { kind: 'nric', pattern: /\b[STFGM]\d{7}[A-Z]\b/g, validate: isValidNric },
  { kind: 'nino', pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, validate: isValidNino },
  {
    // Context-anchored: a bare run of digits is a rent figure far more often than an account.
    // The `i` flag is safe here — nothing in this pattern depends on letter case.
    kind: 'account',
    pattern: /(?<=\b(?:a\/c|account)(?:\s+(?:no\.?|number))?\s*[:.]?\s*)\d{9,18}\b/gi,
  },
  {
    kind: 'phone',
    pattern: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{4,5}[\s-]?\d{4,6}\b/g,
    validate: (value) => {
      const digits = value.replace(/[^0-9]/g, '');
      // A phone number is 8 to 15 digits and, in practice here, written with a separator or a
      // country code — which is what keeps it from eating "50100234567890" or a rent figure.
      return digits.length >= 8 && digits.length <= 15 && /[+\s()-]/.test(value);
    },
  },
];

/** Roles a lease assigns, and the canonical role each maps to. */
const ROLE_WORDS: Readonly<Record<string, PartyRole>> = {
  landlord: 'landlord',
  lessor: 'landlord',
  licensor: 'landlord',
  owner: 'landlord',
  tenant: 'tenant',
  lessee: 'tenant',
  licensee: 'tenant',
};

// ── Name patterns ────────────────────────────────────────────────────────────────────────────────

/**
 * `the landlord` → `[tT][hH][eE]\s+[lL][aA]…`: a phrase in any letter case, without the `i` flag.
 *
 * The flag is not an option in a pattern that also captures a name: under `iu`, `\p{Lu}` matches
 * every lowercase letter as well, so the capitalisation that marks a name stops meaning anything.
 * Role words and titles match in any case; names never do.
 */
function anyCase(phrase: string): string {
  return phrase
    .split(' ')
    .map((word) => [...word].map((ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`).join(''))
    .join('\\s+');
}

const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** One capitalised name word — "Sharma", "D'Souza", "Ann-Marie" — without a trailing possessive. */
const NAME_WORD = "\\p{Lu}\\p{L}+(?:['’-](?!s(?!\\p{L}))\\p{L}+)*";

/** Space between name words. A name may wrap onto the next line, never into a new paragraph. */
const NAME_GAP = '(?:[^\\S\\n]+|[^\\S\\n]*\\n[^\\S\\n]*)';

/** One to four capitalised words on word boundaries, captured as group 1. */
const NAME = `(?<![\\p{L}\\p{N}_'’-])(${NAME_WORD}(?:${NAME_GAP}${NAME_WORD}){0,3})(?!${WORD_CHAR})`;

const TITLE_WORDS: readonly string[] = [
  'Mr',
  'Mrs',
  'Ms',
  'Miss',
  'Dr',
  'Shri',
  'Smt',
  'Sri',
  'Prof',
];

/** A title as usually written, or in capitals: "MR." heads many signature blocks. */
const TITLE = `(?:${TITLE_WORDS.flatMap((title) => [title, title.toUpperCase()]).join('|')})(?:\\.\\s*|\\s+)`;

/**
 * A titled name: "Mr. Rajesh Kumar Sharma", "Ms Priya Ann Fernandes".
 *
 * Titles are the highest-precision name signal in a legal document, which is why they count as
 * strong evidence.
 */
const TITLED_NAME = new RegExp(`(?<!${WORD_CHAR})${TITLE}${NAME}`, 'gu');

/** "son of", "W/o": how Indian agreements introduce a relative. */
const KINSHIP = [
  ...['son of', 'daughter of', 'wife of', 'husband of'].map(anyCase),
  '[SsDdWwCc]\\/[Oo]\\.?',
].join('|');

/** A relative named the way Indian agreements do: "son of Mahesh Sharma", "S/o Late Shri Ram Rao". */
const KIN_NAME = new RegExp(
  `(?<!${WORD_CHAR})(?:${KINSHIP})\\s*(?:${anyCase('late')}\\s+)?(?:${TITLE})?${NAME}`,
  'gu',
);

const QUOTE = `["'“‘]`;
const QUOTES = `(?:${QUOTE}\\s*)*`;
const HEREINAFTER = `${anyCase('hereinafter')}\\s+(?:${['called', 'referred to as', 'known as'].map(anyCase).join('|')})`;

/** What sits between a name and its role word: `, the `, ` ("the `, `, hereinafter called the "`. */
const ROLE_LABEL = `\\s*(?:[,(]\\s*)?${QUOTES}(?:${HEREINAFTER}\\s*${QUOTES})?(?:${anyCase('the')}\\s+${QUOTE}?|${QUOTE})`;

const ROLE_WORD = `(?:${Object.keys(ROLE_WORDS).map(anyCase).join('|')})(?!${WORD_CHAR}|['’]s(?!\\p{L}))`;

/**
 * A name immediately before the role it is given:
 * `Rajesh Kumar Sharma ("the Landlord")`, `Priya Menon, the tenant`,
 * `Mahesh Rao, hereinafter called the "LESSOR"`.
 *
 * Group 1 is the name, group 2 the label between it and the role word, group 3 the role word.
 * Without "the", the role word must be quoted — `("Landlord")` — because a bare capitalised word
 * before "Landlord" is a heading far more often than a person.
 */
const ROLE_LABELLED_NAME = new RegExp(`${NAME}(${ROLE_LABEL})(${ROLE_WORD})`, 'gu');

/** An address introduced by a residence phrase, up to the sentence end. */
const CONTEXTUAL_ADDRESS =
  /\b(?:residing at|resident of|r\/o|address(?:ed)? at|situated at|located at|premises at)\s+([^.;\n]{8,160})/gi;

// ── Name plausibility ────────────────────────────────────────────────────────────────────────────

/**
 * Words that are never a name part, whatever the evidence: grammar, numbers, titles, and the party
 * words a lease is built from. Replacing "Landlord" with "Alan Pryce" would be worse than no
 * redaction at all, and replacing "and" with "Nina" is how a nameless lease once reached the model
 * as nonsense.
 */
const NEVER_A_NAME: ReadonlySet<string> = new Set([
  // articles, determiners, pronouns
  ...['a', 'an', 'the', 'this', 'that', 'these', 'those', 'such', 'said', 'same', 'each', 'every'],
  ...['either', 'neither', 'both', 'all', 'any', 'some', 'no', 'none', 'other', 'another', 'its'],
  ...['his', 'her', 'their', 'our', 'your', 'my', 'he', 'she', 'it', 'they', 'we', 'you', 'him'],
  ...['them', 'us', 'me', 'who', 'whom', 'whose', 'which', 'what'],
  // prepositions
  ...['of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'within', 'into'],
  ...['onto', 'upon', 'over', 'under', 'above', 'below', 'after', 'before', 'between', 'among'],
  ...['against', 'during', 'until', 'till', 'through', 'throughout', 'per', 'via', 'about'],
  ...['across', 'towards', 'toward', 'beyond', 'except', 'including', 'excluding', 'regarding'],
  ...['notwithstanding', 'pursuant', 'subject', 'save'],
  // conjunctions and sentence adverbs
  ...['and', 'or', 'nor', 'but', 'if', 'unless', 'whether', 'while', 'whilst', 'where', 'whereas'],
  ...['whereby', 'wherein', 'when', 'whenever', 'because', 'since', 'so', 'than', 'then', 'though'],
  ...['although', 'provided', 'as', 'also', 'not', 'only', 'thus', 'hence', 'however', 'therefore'],
  ...['accordingly', 'thereafter', 'further', 'furthermore', 'moreover', 'additionally'],
  ...['otherwise', 'finally', 'similarly', 'likewise', 'consequently', 'subsequently', 'meanwhile'],
  ...['nevertheless', 'instead', 'again'],
  // verbs that carry obligations
  ...['shall', 'must', 'can', 'could', 'should', 'would', 'might', 'is', 'are', 'was', 'were'],
  ...['be', 'been', 'being', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'agrees', 'agree'],
  // drafting words
  ...['hereby', 'herein', 'hereinafter', 'hereto', 'hereof', 'hereunder', 'thereof', 'therein'],
  ...['thereto', 'thereunder', 'witnesseth', 'now', 'aforesaid', 'undersigned'],
  // numbers
  ...['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
  ...['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen'],
  ...['nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'],
  ...['hundred', 'thousand', 'lakh', 'lakhs', 'crore', 'crores', 'million', 'first', 'second'],
  ...['third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh'],
  ...['twelfth', 'half', 'once', 'twice'],
  // titles, roles and parties
  ...['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'smt', 'sri', 'prof', 'sir', 'madam', 'messrs'],
  ...['landlord', 'landlords', 'lessor', 'lessors', 'licensor', 'licensors', 'owner', 'owners'],
  ...['tenant', 'tenants', 'lessee', 'lessees', 'licensee', 'licensees', 'occupant', 'occupier'],
  ...['guarantor', 'agent', 'broker', 'witness', 'witnesses', 'party', 'parties'],
  // the document and its headings
  ...['agreement', 'agreements', 'lease', 'deed', 'contract', 'licence', 'license', 'tenancy'],
  ...['schedule', 'annexure', 'appendix', 'exhibit', 'article', 'section', 'clause', 'paragraph'],
  ...['act', 'rules', 'premises', 'property', 'rent', 'deposit', 'security', 'residential'],
  ...['commercial', 'leave', 'important', 'system', 'note', 'general', 'definitions', 'recitals'],
  ...['term', 'renewal', 'termination', 'notice', 'entry', 'inspection', 'access', 'possession'],
  ...['occupancy', 'quiet', 'enjoyment', 'default', 'breach', 'remedies', 'indemnity', 'liability'],
  ...['damages', 'dispute', 'disputes', 'resolution', 'arbitration', 'jurisdiction', 'governing'],
  ...['maintenance', 'repairs', 'repair', 'utilities', 'insurance', 'payment', 'fee', 'fees'],
  ...['charges', 'interest', 'late', 'conditions', 'covenants', 'obligations', 'rights', 'pets'],
  ...['parking', 'lock-in', 'escalation', 'signed', 'sealed', 'delivered', 'total', 'amount'],
  ...['balance', 'expiry', 'vacating', 'refund'],
  // places, time and money
  ...['tribunal', 'state', 'county', 'district', 'city', 'road', 'avenue', 'nagar', 'colony'],
  ...['sector', 'floor', 'flat', 'apartment', 'building', 'tower', 'society', 'date', 'dated'],
  ...['days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'annum', 'time', 'january'],
  ...['february', 'july', 'september', 'october', 'november', 'december', 'monday', 'tuesday'],
  ...['wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'rs', 'inr', 'usd', 'gbp', 'eur'],
  ...['rupees', 'dollars', 'pounds'],
]);

/**
 * Lease words that are also somebody's name — "Ms. April Lane", "Mr. Will Law", "Margaret Court".
 * Accepted only where a title, a kinship phrase or a quoted role label vouches for a name on the
 * same line: "May 2026" on the line after "Mr. Sharma" is a date, not his surname.
 */
const ALSO_A_NAME: ReadonlySet<string> = new Set([
  ...['will', 'may', 'march', 'april', 'june', 'august', 'day', 'law', 'court', 'lane', 'street'],
  ...['bank', 'block', 'india', 'england', 'wales'],
]);

/** Strong: a title, a kinship phrase or a quoted role label. Weak: a bare "…, the tenant". */
type Evidence = 'strong' | 'weak';

function isNameWord(word: string, evidence: Evidence): boolean {
  const key = word.toLowerCase();
  return !NEVER_A_NAME.has(key) && (evidence === 'strong' || !ALSO_A_NAME.has(key));
}

function isShouted(word: string): boolean {
  return word === word.toUpperCase();
}

/**
 * Whether `word` continues a name whose nearest accepted word is `previous`.
 *
 * Across a line break the evidence no longer vouches for the word — "Mr. Sharma" at the end of one
 * line and "May 2026" at the start of the next is not a person called Sharma May — so the word
 * must pass the weak test and be written in the same case as the name so far.
 */
function continuesName(
  candidate: string,
  previous: RegExpExecArray | undefined,
  word: RegExpExecArray,
  evidence: Evidence,
): boolean {
  if (previous === undefined) return isNameWord(word[0], evidence);
  const [left, right] = previous.index < word.index ? [previous, word] : [word, previous];
  if (!candidate.slice(left.index + left[0].length, right.index).includes('\n')) {
    return isNameWord(word[0], evidence);
  }
  return isNameWord(word[0], 'weak') && isShouted(word[0]) === isShouted(previous[0]);
}

interface NameRun {
  readonly value: string;
  /** Where the run starts inside the candidate. */
  readonly offset: number;
}

/**
 * The part of a capitalised run that is plausibly a name, read outward from the side the evidence
 * is on: after a title, from the start; before a role label, from the end. "Between Rajesh Kumar
 * Sharma" before `("the Landlord")` keeps "Rajesh Kumar Sharma".
 *
 * On weak evidence a name needs at least two words and cannot be all capitals, which is what
 * separates `Priya Menon, the tenant` from `QUIET ENJOYMENT` followed by "The tenant may live…".
 */
function nameRun(candidate: string, fromEnd: boolean, evidence: Evidence): NameRun | undefined {
  const words = [...candidate.matchAll(/\S+/g)];
  if (fromEnd) words.reverse();

  const kept: RegExpExecArray[] = [];
  for (const word of words) {
    if (!continuesName(candidate, kept.at(-1), word, evidence)) break;
    kept.push(word);
  }
  if (kept.length === 0) return undefined;
  if (evidence === 'weak' && (kept.length < 2 || kept.every((word) => isShouted(word[0])))) {
    return undefined;
  }

  const start = Math.min(...kept.map((word) => word.index));
  const end = Math.max(...kept.map((word) => word.index + word[0].length));
  return { value: candidate.slice(start, end), offset: start };
}

/**
 * How much a role label vouches for the name before it, or `undefined` when it vouches for none.
 *
 * Brackets, quotes and "hereinafter" are how drafters define a party, so they are strong evidence.
 * Otherwise a name is set off by a comma (`Priya Menon, the tenant`) or runs into a lowercase "the"
 * mid-sentence. A heading does neither: it runs straight into a new sentence, "Rubbish Removal The
 * tenant shall…" — on the next line, or on the same one once ingest has joined the paragraph.
 */
function labelEvidence(label: string): Evidence | undefined {
  if (/[("'“‘]/.test(label) || /hereinafter/i.test(label)) return 'strong';
  return label.includes(',') || label.includes('the') ? 'weak' : undefined;
}

// ── Detection ────────────────────────────────────────────────────────────────────────────────────

/** A stretch of the input to replace, and what was detected there. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: PiiKind;
  readonly role: PartyRole | undefined;
}

function spanOf(start: number, value: string, kind: PiiKind, role: PartyRole | undefined): Span {
  return { start, end: start + value.length, kind, role };
}

interface NameHit {
  readonly value: string;
  readonly start: number;
  readonly role: PartyRole | undefined;
}

function roleLabelledNames(text: string): NameHit[] {
  const hits: NameHit[] = [];
  for (const match of text.matchAll(ROLE_LABELLED_NAME)) {
    const [, candidate = '', label = '', roleWord = ''] = match;
    const evidence = labelEvidence(label);
    const run = evidence === undefined ? undefined : nameRun(candidate, true, evidence);
    if (run === undefined) continue;
    // The name opens the match: the lookbehind before it is zero-width.
    hits.push({
      value: run.value,
      start: match.index + run.offset,
      role: ROLE_WORDS[roleWord.toLowerCase()],
    });
  }
  return hits;
}

/** Names that follow their evidence — a title or a kinship phrase — and so close the match. */
function namesAfter(text: string, pattern: RegExp): NameHit[] {
  const hits: NameHit[] = [];
  for (const match of text.matchAll(pattern)) {
    const [whole, candidate = ''] = match;
    const run = nameRun(candidate, false, 'strong');
    if (run === undefined) continue;
    const start = match.index + whole.length - candidate.length + run.offset;
    hits.push({ value: run.value, start, role: undefined });
  }
  return hits;
}

/** Find the people, resolving who is the landlord and who is the tenant so they never collide. */
function registerNames(text: string, map: SurrogateMap): Span[] {
  const labelled = roleLabelledNames(text);
  const roles = new Map(labelled.map((hit) => [hit.value, hit.role]));
  const hits = [...labelled, ...namesAfter(text, TITLED_NAME), ...namesAfter(text, KIN_NAME)];

  // The parties first, so the landlord and the tenant draw from their own lists before a witness
  // can; then longest first, so "Rajesh Kumar Sharma" is registered before a bare "Sharma" and the
  // surname keeps one stand-in.
  const byLength = (a: NameHit, b: NameHit): number => b.value.length - a.value.length;
  const others = hits.filter((hit) => !roles.has(hit.value));
  for (const hit of [...[...labelled].sort(byLength), ...others.sort(byLength)]) {
    map.assign('person', hit.value, roles.get(hit.value));
  }
  return hits.map((hit) => spanOf(hit.start, hit.value, 'person', roles.get(hit.value)));
}

/**
 * A residence phrase introduces an address only when something address-shaped follows: a number,
 * or a proper noun. "The landlord may enter the premises at any time without notice" does not —
 * and replacing "any time without notice" with a street address erased the very words that make
 * the clause a risk.
 */
function looksLikeAddress(candidate: string): boolean {
  return (
    /\d/.test(candidate) ||
    [...candidate.matchAll(/\p{Lu}\p{L}+/gu)].some(([word]) => isNameWord(word, 'weak'))
  );
}

function registerAddresses(text: string, map: SurrogateMap): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(CONTEXTUAL_ADDRESS)) {
    const [whole, raw = ''] = match;
    const address = raw.trimEnd();
    if (address.length < 8 || !looksLikeAddress(address)) continue;
    map.assign('address', address);
    spans.push(spanOf(match.index + whole.length - raw.length, address, 'address', undefined));
  }
  return spans;
}

function registerIdentifiers(text: string, map: SurrogateMap, skip: ReadonlySet<PiiKind>): Span[] {
  const spans: Span[] = [];
  for (const detector of DETECTORS) {
    if (skip.has(detector.kind)) continue;
    for (const match of text.matchAll(detector.pattern)) {
      const [value] = match;
      if (detector.validate !== undefined && !detector.validate(value)) continue;
      map.assign(detector.kind, value);
      spans.push(spanOf(match.index, value, detector.kind, undefined));
    }
  }
  return spans;
}

// ── Replacement ──────────────────────────────────────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}_]/u;

/** Whether position `at` falls between two characters of the same word. */
function insideWord(text: string, at: number): boolean {
  return WORD.test(text.charAt(at - 1)) && WORD.test(text.charAt(at));
}

/**
 * Widen a span to whole words, so a stand-in is never glued to half of the token around it — which
 * would leave the rest of that token in the prompt and make the stand-in impossible to reverse.
 */
function snapToWords(text: string, span: Span): Span {
  let { start, end } = span;
  while (insideWord(text, start)) start -= 1;
  while (insideWord(text, end)) end += 1;
  return { ...span, start, end };
}

/** Every place a detected value appears: "Sharma" in "Mr. Sharma shall refund", a PAN quoted twice. */
function occurrences(text: string, map: SurrogateMap): Span[] {
  return map
    .replacements()
    .flatMap((replacement) =>
      [...text.matchAll(new RegExp(boundedSource(replacement.original), 'gu'))].map((match) =>
        spanOf(match.index, replacement.original, replacement.kind, replacement.role),
      ),
    );
}

/**
 * Join overlapping spans, so a character inside any detection is replaced even where two detectors
 * disagree about where a value ends. Contained spans disappear into the span containing them.
 */
function mergeOverlaps(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start >= previous.end) {
      merged.push(span);
    } else if (span.end > previous.end) {
      const larger = span.end - span.start > previous.end - previous.start ? span : previous;
      merged[merged.length - 1] = { ...larger, start: previous.start, end: span.end };
    }
  }
  return merged;
}

/**
 * Replace every span in one pass over the original text.
 *
 * One pass is the point. Replacing value by value rewrote text that earlier replacements had
 * inserted — "fourteen" became "Leng", then "Leng" matched again — so the output could not be
 * reversed. Here a surrogate, once written, is never read again.
 */
function substitute(input: string, map: SurrogateMap, detected: readonly Span[]): string {
  const spans = mergeOverlaps(
    [...detected, ...occurrences(input, map)].map((span) => snapToWords(input, span)),
  );
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    const value = input.slice(span.start, span.end);
    const surrogate = map.surrogateFor(value) ?? map.assignOverlap(span.kind, value, span.role);
    output += input.slice(cursor, span.start) + surrogate;
    cursor = span.end;
  }
  return output + input.slice(cursor);
}

export interface RedactOptions {
  /** Kinds to leave alone. Used by the evaluation harness to measure the redaction delta. */
  readonly skip?: readonly PiiKind[];
}

export function redact(input: string, options: RedactOptions = {}): RedactionResult {
  const skip = new Set(options.skip ?? []);
  const map = new SurrogateMap(input);

  // Names first, with roles resolved, because coreference is what must survive.
  const detected = [
    ...(skip.has('person') ? [] : registerNames(input, map)),
    ...(skip.has('address') ? [] : registerAddresses(input, map)),
    ...registerIdentifiers(input, map, skip),
  ];

  return { text: substitute(input, map, detected), map, summary: map.summary() };
}

/**
 * Redact a fragment of a document that has already been through `redact` — a clause excerpt, a
 * heading — with the same stand-ins, so every piece of text sent to a model agrees on who is who.
 *
 * Only for text taken from that same document: detection ran on the whole of it, which is where
 * the evidence for a name (a title, a role label) lives. Redact before truncating, so a name is
 * never cut in half and left half-visible.
 */
export function applyRedaction(fragment: string, map: SurrogateMap): string {
  return substitute(fragment, map, []);
}

/**
 * Put the real values back, immediately before rendering to the reader.
 *
 * One pass, longest surrogate first where two start at the same place. Because a person's
 * surrogate is built word by word, a quote the model re-spaced, or a name it shortened to "Mr.
 * Pryce", still reverses word by word to text that is really in the document.
 */
export function restore(text: string, map: SurrogateMap): string {
  const pattern = map.surrogatePattern();
  if (pattern === undefined) return text;
  return text.replace(pattern, (surrogate) => map.originalFor(surrogate) ?? surrogate);
}

/**
 * Assert that no original value survives in text about to be transmitted.
 *
 * Used by the adversarial suite to scan the serialised outbound request, which is the only check
 * that actually proves the property rather than describing it.
 */
export function findLeaks(outbound: string, map: SurrogateMap): readonly string[] {
  return map
    .replacements()
    .filter((replacement) => outbound.includes(replacement.original))
    .map((replacement) => `${replacement.kind}: ${replacement.original.slice(0, 8)}...`);
}
