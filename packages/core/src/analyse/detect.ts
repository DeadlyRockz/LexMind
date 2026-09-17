import { CLAUSE_TYPES, type ClauseTypeRow, type Cue, ROLE_WORDS } from '../domain/clause-types.ts';
import type { Clause } from '../domain/types.ts';
import { parseNumbering } from '../segment/headings.ts';
import { splitSentences } from '../util/text.ts';

/**
 * Clause typing from the taxonomy's evidence table.
 *
 * Deterministic, and first in the pipeline, because it runs with no API call and because its
 * output is what the rule engine targets. The model is used later to *explain* a clause, never to
 * decide what kind of clause it is.
 *
 * ## The scoring model, and why it is not a synonym count
 *
 * The previous detector summed length-weighted hits over one flat synonym list per type. Three
 * properties of that model made it wrong rather than merely imprecise:
 *
 *  1. **Any phrase could type a clause.** `'at any time'` was a synonym of `inspection-entry`, so
 *     every termination clause containing it was typed as an entry clause. A tenant was then shown
 *     a medium-severity "the landlord may enter without advance notice" card quoting a *possession*
 *     clause on a lease with no right of entry in it.
 *  2. **Length stood in for specificity.** `'at any time'` (11 characters) outscored the genuine
 *     evidence in the clause, and `'landlord'` (8) attached `parties` to almost every clause in
 *     every lease — 1 true positive against 45 false positives on the golden set.
 *  3. **Matching was by substring.** `'term'` matched inside *terminate*, `'cat'` inside *vacates*,
 *     `'assign'` inside *assigning*, `'forfeit'` inside *forfeited*. Several scores were noise.
 *
 * What replaces it:
 *
 *  - **A distinctive cue is required.** A type scores nothing until one of its `cues` matches, or
 *    one of its `caption` words appears in the clause's own caption. `support` phrases add weight
 *    to a type that already matched and can never type a clause on their own. This is the single
 *    change that fixes both halves of the entry bug: `'at any time'` became support, and "shall
 *    give twenty-four hours written notice **before entering**" became a cue.
 *  - **Where the phrase sits is the strongest signal.** A drafter announces the subject of a clause
 *    in its caption. `'ENTRY'` in the caption is worth three times the same word in the body, and
 *    a caption match that is contained inside a longer one loses — so "LATE RENT" scores `late-fee`
 *    and not `rent`, and "CONDITION OF PREMISES" scores `habitability` and not `premises`.
 *  - **Word boundaries, always.** Matching is by compiled regex with Unicode-aware boundaries, so
 *    *terminate* is no longer evidence of a `term` clause.
 *  - **Order carries meaning.** A sequence cue such as `['{tenant}', 'give', 'notice']` requires
 *    its phrases in one sentence in that order, which is how "Tenant must give sixty days written
 *    notice" is recognised as the tenant's exit right while "The landlord shall give the tenant a
 *    written account" is not.
 *
 * Everything above is data in `domain/clause-types.ts`. There is no per-document branch and no
 * fixture text anywhere in this file: a new drafting style is a row, not a code change.
 */

export interface ClauseTyping {
  readonly clauseId: string;
  /** Best first. Empty when nothing matched, which is a normal outcome for a bare document title. */
  readonly typeIds: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
  /** The cue that produced the top score, so the UI can say why. */
  readonly matchedOn: string | null;
}

// ─── The weights ───────────────────────────────────────────────────────────────────────────────
// Tuned on the golden set and reported in the Phase 06 scorecard. They are ordinary numbers rather
// than probabilities because the evidence is ordinal: a caption beats a cue, a cue beats support,
// and nothing here pretends to be calibrated beyond that.

/** One distinctive cue, found in the clause body. */
const CUE_POINTS = 10;
/** The same cue found in the clause's caption: the drafter naming the subject of the clause. */
const CAPTION_POINTS = 30;
/** Each further distinct cue. Corroboration is real but worth much less than the first hit. */
const EXTRA_CUE_POINTS = 4;
const EXTRA_CUE_CAP = 12;
/** Each repeat occurrence of a cue already counted. Repetition is the weakest signal there is. */
const REPEAT_POINTS = 1;
const REPEAT_CAP = 4;
/** Each distinct support phrase — but only for a type that already has a cue. */
const SUPPORT_POINTS = 2;
const SUPPORT_CAP = 6;
/** Per word beyond the first in the best cue: "enter the premises" is more specific than "entry". */
const SPECIFICITY_POINTS = 2;
const SPECIFICITY_CAP = 6;

/**
 * Below this, the evidence is a passing mention rather than the subject of the clause.
 *
 * At 12, a single one-word cue in the body (10) is *not* enough on its own — it needs a second cue,
 * a repeat, or a support phrase. A two-word cue (12) or any caption match (30) clears it.
 */
const SCORE_FLOOR = 12;

/** Three types is what a real clause covers at most; beyond that the list is noise. */
const MAX_TYPES = 3;

/** A caption longer than this is a paragraph in capitals, not a heading. */
const MAX_CAPTION_WORDS = 8;

// ─── Compilation ───────────────────────────────────────────────────────────────────────────────

interface CompiledCue {
  /** The authored phrase, for `matchedOn` and for explaining a match. */
  readonly text: string;
  readonly words: number;
  /** One regex per phrase. A single-element list is a plain phrase. */
  readonly parts: readonly RegExp[];
}

interface CompiledType {
  readonly id: string;
  readonly caption: readonly CompiledCue[];
  readonly cues: readonly CompiledCue[];
  readonly support: readonly CompiledCue[];
  readonly exclude: readonly CompiledCue[];
  /**
   * One alternation over the opening phrase of every cue.
   *
   * A necessary condition, not a sufficient one: if nothing here appears, no cue of this type can
   * match, so the type's own dozen regexes never run. It turns thirty-eight × a dozen scans per
   * clause into thirty-eight, and the answer is identical either way.
   */
  readonly probe: RegExp;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const APOSTROPHE = /['’]/g;

/**
 * A literal word or phrase as a regex body.
 *
 * An apostrophe is optional and matches either glyph. The same notice reaches LexMind as "one
 * month's notice" (straight quote), "one month’s notice" (a word processor's curly quote) and "one
 * months notice" (no apostrophe at all), and a cue should not care which.
 */
function literalPattern(text: string): string {
  return escapeRegExp(text).replace(APOSTROPHE, "['’]?").replace(/\s+/g, '\\s+');
}

/** A phrase token, or a role placeholder expanded to every word a lease uses for that role. */
function tokenPattern(token: string): string {
  const role = ROLE_WORDS[token];
  if (role === undefined) return literalPattern(token);
  return `(?:${role.map(literalPattern).join('|')})`;
}

/**
 * A phrase as a regex with Unicode-aware boundaries.
 *
 * Lookarounds rather than `\b` because half the vocabulary is hyphenated — `lock-in`, `as-is`,
 * `non-refundable`, `sub-registrar` — and `\b` fires in the middle of every one of them.
 */
function phraseRegex(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(tokenPattern).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

function wordCount(phrase: string): number {
  return phrase
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

function compileCue(cue: Cue): CompiledCue {
  const phrases = typeof cue === 'string' ? [cue] : cue;
  return {
    text: phrases.join(' '),
    words: phrases.reduce((total, phrase) => total + wordCount(phrase), 0),
    parts: phrases.map(phraseRegex),
  };
}

/** The union of the opening phrases of a set of cues, as one regex. Never matches when empty. */
function compileProbe(cues: readonly Cue[]): RegExp {
  const leads = cues.map((cue) => (typeof cue === 'string' ? cue : (cue[0] ?? '')));
  const bodies = leads
    .filter((lead) => lead.length > 0)
    .map((lead) => lead.trim().split(/\s+/).map(tokenPattern).join('\\s+'));
  if (bodies.length === 0) return /(?!)/u;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${bodies.join('|')})`, 'iu');
}

/**
 * Compiled once at module load.
 *
 * Roughly five hundred regexes across thirty-eight types, built a single time and reused for every
 * clause of every document in the process. Building them per call would turn a microsecond pass
 * into a millisecond one for no benefit.
 */
const COMPILED: readonly CompiledType[] = CLAUSE_TYPES.map((type: ClauseTypeRow) => ({
  id: type.id,
  caption: type.caption.map(compileCue),
  cues: type.cues.map(compileCue),
  support: type.support.map(compileCue),
  exclude: type.exclude.map(compileCue),
  probe: compileProbe([...type.caption, ...type.cues]),
}));

/**
 * Every single-phrase caption word and cue in the taxonomy, as one regex.
 *
 * These are the phrases `captionCredit` scores in a caption. A title-case caption is only accepted
 * when it contains one of them, so it is accepted exactly when it could name a clause's subject.
 */
const CAPTION_VOCABULARY = new RegExp(
  COMPILED.flatMap((type) => [...type.caption, ...type.cues])
    .flatMap((cue) => (cue.parts.length === 1 ? cue.parts.map((part) => part.source) : []))
    .join('|'),
  'iu',
);

// ─── Matching ──────────────────────────────────────────────────────────────────────────────────

interface Hit {
  readonly cue: CompiledCue;
  readonly count: number;
  /** Where the match sits, for the caption containment rule. Only set for caption matches. */
  readonly span: readonly [number, number] | null;
}

function countMatches(haystack: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  for (;;) {
    const match = pattern.exec(haystack);
    if (match === null) return count;
    count += 1;
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }
}

/** The widest span a single-phrase cue occupies, for the caption containment rule. */
function firstSpan(haystack: string, pattern: RegExp): readonly [number, number] | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(haystack);
  return match === null ? null : [match.index, match.index + match[0].length];
}

/**
 * A sequence cue: every phrase present in one sentence, in the order written.
 *
 * "The tenant shall give ninety days notice" matches `['{tenant}', 'give', 'notice']`. "The
 * landlord shall give the tenant a written account" does not, because `give` comes first.
 */
function matchesSequence(sentences: readonly string[], cue: CompiledCue): boolean {
  return sentences.some((sentence) => {
    let from = 0;
    for (const part of cue.parts) {
      part.lastIndex = from;
      const match = part.exec(sentence);
      if (match === null) return false;
      from = match.index + match[0].length;
    }
    return true;
  });
}

function matchCue(body: string, sentences: readonly string[], cue: CompiledCue): number {
  const first = cue.parts[0];
  if (first === undefined) return 0;
  if (cue.parts.length === 1) return countMatches(body, first);
  return matchesSequence(sentences, cue) ? 1 : 0;
}

function collectHits(
  body: string,
  sentences: readonly string[],
  cues: readonly CompiledCue[],
): readonly Hit[] {
  const hits: Hit[] = [];
  for (const cue of cues) {
    const count = matchCue(body, sentences, cue);
    if (count > 0) hits.push({ cue, count, span: null });
  }
  return hits;
}

// ─── The clause caption ────────────────────────────────────────────────────────────────────────

const CAPTION_TOKEN = /^[\p{Lu}\p{N}][\p{Lu}\p{N}'&/.,-]*$/u;

/** A capitalised word in a title-case caption: "Deposit", "Lock-in", "Landlord's", "Taxes,". */
const TITLE_WORD = /^\p{Lu}[\p{L}\p{N}'’&/-]*[.,:]?$/u;

/** The short words title case leaves in lower case: "Right of Entry", "Use of the Premises". */
const TITLE_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  '&',
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'upon',
  'with',
]);

/** The full stop or colon that ends a title-case caption. */
const TITLE_END = /[.:]$/;

const LOWER_CASE_START = /^\p{Ll}/u;

const PARTY_ROLES: ReadonlySet<string> = new Set(['{tenant}', '{landlord}']);

function capitalised(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/**
 * Capitalised words that start the body's first sentence rather than end the caption: "The",
 * "Either", "Licensee".
 *
 * Pasted text often loses the line break after a caption, giving "3. Security Deposit The licensee
 * shall…". Nothing marks where the caption stops except these words, followed by a lower-case one.
 */
const SENTENCE_OPENERS: ReadonlySet<string> = new Set(
  [
    'the',
    'this',
    'a',
    'an',
    'each',
    'either',
    'neither',
    'both',
    'all',
    'any',
    'if',
    'where',
    'upon',
    'nothing',
    'notwithstanding',
    // "Tenant shall…", "Licensor may…": the parties, under every name a lease gives them.
    ...Object.entries(ROLE_WORDS).flatMap(([role, words]) => (PARTY_ROLES.has(role) ? words : [])),
  ].map(capitalised),
);

/**
 * The clause's own title.
 *
 * A structured document gives one directly on `clause.heading`. A pasted or PDF-extracted lease
 * usually does not: it runs the caption into the body as `"5. MAINTENANCE. The licensee shall…"`,
 * and the segmenter leaves it there because it is one paragraph. So the leading run of capitalised
 * words after any numbering token is read as the caption — which is exactly the convention every
 * one of the four model instruments this taxonomy is drawn from follows. A caption in title case,
 * `"5. Security Deposit. The licensee shall…"`, is read too, under stricter conditions (see
 * `titleCaseCaption`).
 *
 * Deliberately conservative: a run longer than `MAX_CAPTION_WORDS` is a paragraph set in capitals,
 * not a heading, and a lower-case opening yields no caption at all rather than a guess.
 */
export function clauseCaption(clause: Clause): string {
  if (clause.heading !== null && clause.heading.trim().length > 0) {
    return stripNumbering(clause.heading);
  }
  return runInCaption(clause.text);
}

function stripNumbering(line: string): string {
  const numbering = parseNumbering(line);
  const rest = numbering === null ? line : line.slice(numbering.length);
  return rest.replace(/^[\s—:-]+/, '').trim();
}

function runInCaption(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const rest = stripNumbering(firstLine);
  if (rest.length === 0) return '';
  return capitalsCaption(rest) || titleCaseCaption(rest);
}

/** "SECURITY DEPOSIT The tenant…": the run of words in capitals is the caption. */
function capitalsCaption(rest: string): string {
  const taken: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (taken.length >= MAX_CAPTION_WORDS) return '';
    if (!CAPTION_TOKEN.test(token)) break;
    taken.push(token);
  }

  const caption = taken
    .join(' ')
    .replace(/[.,:;-]+$/, '')
    .trim();
  // A single short token ("A", "I", "PART") is a label, not a subject.
  return /\p{Lu}{3}/u.test(caption) ? caption : '';
}

/**
 * "Security Deposit. The tenant…": a caption in title case.
 *
 * Harder to read than capitals, because a title-case caption and the sentence after it both start
 * with a capital letter. So every one of these must hold:
 *
 *  - every word is capitalised, apart from short words like "of" and "the" after the first;
 *  - the caption ends at a full stop or colon, or else just before a sentence opener ("The", "The
 *    Licensee") that is followed by a lower-case word;
 *  - it is at most `MAX_CAPTION_WORDS` words long;
 *  - it contains a caption word or cue from the taxonomy.
 *
 * "The Landlord shall keep the Premises in repair." has no caption: the words before "shall" are
 * only the sentence's own opening. "Security Deposit shall be paid monthly." has none either,
 * because nothing opens a second sentence. "Tenant: Asha Rao." ends in a colon but names no subject.
 */
function titleCaseCaption(rest: string): string {
  const words: string[] = [];
  for (const token of rest.split(/\s+/)) {
    const minor = words.length > 0 && TITLE_FUNCTION_WORDS.has(token);
    if (!minor && !TITLE_WORD.test(token)) {
      return LOWER_CASE_START.test(token) ? withoutOpeners(words) : '';
    }
    words.push(token);
    if (!minor && TITLE_END.test(token)) return namedCaption(words);
    if (words.length > MAX_CAPTION_WORDS + 1) return '';
  }
  return '';
}

/** The caption before the body's opening words, when the capitalised run ends with them. */
function withoutOpeners(words: readonly string[]): string {
  const end = words.findLastIndex((word) => !SENTENCE_OPENERS.has(word)) + 1;
  return end === words.length ? '' : namedCaption(words.slice(0, end));
}

/** A caption, kept only when it is short and names a subject the taxonomy knows. */
function namedCaption(words: readonly string[]): string {
  if (words.length === 0 || words.length > MAX_CAPTION_WORDS) return '';
  const caption = words.join(' ').replace(TITLE_END, '');
  return CAPTION_VOCABULARY.test(caption) ? caption : '';
}

/**
 * Drop a caption match that sits strictly inside another type's caption match.
 *
 * "LATE RENT" contains `rent`, but the drafter wrote a late-payment heading, not a rent heading;
 * "CONDITION OF PREMISES" contains `premises`, but the clause is about condition. Taking the widest
 * reading of the caption is what stops the short generic word riding along on the long specific one.
 */
function captionCredit(
  caption: string,
  types: readonly CompiledType[],
): ReadonlyMap<string, CompiledCue> {
  const best = new Map<string, { cue: CompiledCue; span: readonly [number, number] }>();

  for (const type of types) {
    let widest: { cue: CompiledCue; span: readonly [number, number] } | null = null;
    for (const cue of [...type.caption, ...type.cues]) {
      if (cue.parts.length !== 1) continue;
      const part = cue.parts[0];
      if (part === undefined) continue;
      const span = firstSpan(caption, part);
      if (span === null) continue;
      if (widest === null || span[1] - span[0] > widest.span[1] - widest.span[0]) {
        widest = { cue, span };
      }
    }
    if (widest !== null) best.set(type.id, widest);
  }

  const kept = new Map<string, CompiledCue>();
  for (const [id, entry] of best) {
    const swallowed = [...best].some(
      ([otherId, other]) =>
        otherId !== id &&
        other.span[0] <= entry.span[0] &&
        other.span[1] >= entry.span[1] &&
        other.span[1] - other.span[0] > entry.span[1] - entry.span[0],
    );
    if (!swallowed) kept.set(id, entry.cue);
  }
  return kept;
}

// ─── Scoring ───────────────────────────────────────────────────────────────────────────────────

function capped(value: number, cap: number): number {
  return Math.min(value, cap);
}

export function detectClauseTypes(clause: Clause): ClauseTyping {
  const caption = clauseCaption(clause);
  // The outermost heading is the document's own title, repeated on every clause, so it is dropped:
  // it is context, not evidence about this clause. Deeper ancestors are real subject context.
  const context = clause.headingTrail.slice(1).join(' ');
  const body = `${clause.text}\n${context}`;
  const haystack = `${caption}\n${body}`;
  const sentences = splitSentences(clause.text);

  const captionCues = captionCredit(caption, COMPILED);

  const scores: Record<string, number> = {};
  const matchedBy: Record<string, string> = {};

  for (const type of COMPILED) {
    // Cheap necessary condition first: no opening phrase, no possible cue, no work.
    if (!type.probe.test(haystack)) continue;
    if (type.exclude.some((cue) => matchCue(body, sentences, cue) > 0)) continue;

    const captionCue = captionCues.get(type.id);
    const bodyHits = collectHits(body, sentences, type.cues);
    if (captionCue === undefined && bodyHits.length === 0) continue;

    const anchor = captionCue ?? bestOf(bodyHits);
    if (anchor === null) continue;

    const base = captionCue === undefined ? CUE_POINTS : CAPTION_POINTS;
    const specificity = capped((anchor.words - 1) * SPECIFICITY_POINTS, SPECIFICITY_CAP);

    const distinct = new Set(bodyHits.map((hit) => hit.cue.text));
    distinct.delete(anchor.text);
    const extra = capped(distinct.size * EXTRA_CUE_POINTS, EXTRA_CUE_CAP);

    const repeats = bodyHits.reduce((total, hit) => total + (hit.count - 1), 0);
    const repeat = capped(repeats * REPEAT_POINTS, REPEAT_CAP);

    const supportHits = collectHits(body, sentences, type.support);
    const support = capped(supportHits.length * SUPPORT_POINTS, SUPPORT_CAP);

    scores[type.id] = base + specificity + extra + repeat + support;
    matchedBy[type.id] = anchor.text;
  }

  const ranked = Object.entries(scores)
    .filter(([, score]) => score >= SCORE_FLOOR)
    .sort(([aId, a], [bId, b]) => b - a || aId.localeCompare(bId));

  const typeIds = ranked.slice(0, MAX_TYPES).map(([id]) => id);
  const top = typeIds[0];

  return {
    clauseId: clause.id,
    typeIds,
    scores,
    matchedOn: top === undefined ? null : (matchedBy[top] ?? null),
  };
}

/** The longest cue among the hits: the most specific thing the clause actually said. */
function bestOf(hits: readonly Hit[]): CompiledCue | null {
  let best: CompiledCue | null = null;
  for (const hit of hits) {
    if (best === null || hit.cue.words > best.words || hit.cue.text.length > best.text.length) {
      best = hit.cue;
    }
  }
  return best;
}

export function detectAllClauseTypes(clauses: readonly Clause[]): readonly ClauseTyping[] {
  return clauses.map(detectClauseTypes);
}

/** Clauses carrying the type asked for. Used by the rule engine to target its checks. */
export function clausesOfType(
  clauses: readonly Clause[],
  typings: readonly ClauseTyping[],
  typeId: string,
): readonly Clause[] {
  const matching = new Set(
    typings.filter((typing) => typing.typeIds.includes(typeId)).map((t) => t.clauseId),
  );
  return clauses.filter((clause) => matching.has(clause.id));
}

/**
 * The share of clauses that needed no type at all.
 *
 * Reported as a coverage figure: a high number means the taxonomy is missing drafting styles, and
 * that is worth knowing rather than hiding. It rose deliberately when the distinctive-cue gate went
 * in — a bare document title now types as nothing, which is the honest answer, where before it
 * collected `parties` on the strength of the word "landlord".
 */
export function untypedShare(typings: readonly ClauseTyping[]): number {
  if (typings.length === 0) return 0;
  const untyped = typings.filter((typing) => typing.typeIds.length === 0).length;
  return Math.round((untyped / typings.length) * 1000) / 1000;
}
