/**
 * Text normalization. Pure, deterministic, and effectively frozen once segmentation ships:
 * every citation, highlight and comparison anchor in LexMind is a character offset into the
 * string these functions produce, so a change here shifts every offset in the system.
 *
 * Nothing here is a dependency. `String.prototype.normalize('NFKC')` folds ligatures (ﬁ → fi)
 * and non-breaking spaces but leaves curly quotes, en/em dashes and soft hyphens alone; those are
 * a handful of replacements. Every candidate package was rejected: the smart-quote libraries
 * convert in the wrong direction, transliterators are destructive (they would mangle names and
 * currency in a legal document), and hyphenation libraries *insert* break points.
 */

/**
 * Characters that are invisible in every viewer and can carry an instruction payload: the tag
 * block, variation selectors, zero-width joiners, bidi controls, soft hyphen and BOM.
 *
 * Stripped at ingest so an injected instruction never reaches a prompt, and stripped again at
 * render so it never reaches a screen. See `safety/unicode.ts`.
 */
export const INVISIBLE_PATTERN = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]|[︀-️]|[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE_PATTERN, '');
}

/** Fold typographic variants to ASCII so a model quote can match the source byte for byte. */
export function foldPunctuation(input: string): string {
  return input
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[⁄∕]/g, '/')
    .replace(/[  -   　]/g, ' ');
}

/**
 * De-hyphenate across a line break only.
 *
 * A lease legitimately contains `co-tenant` and `month-to-month`, so the rule requires
 * lowercase-hyphen-newline-lowercase. `LEASE-\nAGREEMENT` survives intact.
 */
export function dehyphenate(input: string): string {
  return input.replace(/([a-z])-\n([a-z])/g, '$1$2');
}

/**
 * The canonical normalizer. Order matters: decompose first, then fold, then strip, then
 * de-hyphenate across the line breaks that are still present.
 */
export function normalizeText(input: string): string {
  const unified = input.replace(/\r\n?/g, '\n');
  const folded = foldPunctuation(unified.normalize('NFKC'));
  const visible = stripInvisible(folded);
  return dehyphenate(visible)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The comparison form used by the citation verifier's second pass, and nowhere else.
 *
 * PDF extraction introduces whitespace and case drift that a model will not reproduce byte for
 * byte, so an exact-only verifier would reject valid quotes. This is the *only* permitted
 * loosening — there is deliberately no edit-distance fallback, because a fuzzy threshold
 * manufactures citations that look verified and are not, which is worse than no citation.
 */
export function normalizeForMatch(input: string): string {
  return normalizeText(input).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Every occurrence of `needle` in `haystack`. Never just the first: "thirty (30) days" recurs. */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + 1;
  }
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t';
}

function isSentenceOpener(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Z("'\d]/.test(ch);
}

/** True for the dot in "1.", "5.2." or "(iv)." — a clause number, not a sentence end. */
function endsClauseNumber(input: string, dotIndex: number): boolean {
  let i = dotIndex - 1;
  let digits = 0;
  while (i >= 0 && /[0-9]/.test(input[i] ?? '')) {
    digits += 1;
    i -= 1;
  }
  if (digits === 0) return false;
  // Allow "5.2." — a preceding dot means we are inside a numbering path.
  return i < 0 || input[i] === '.' || isSpace(input[i]) || input[i] === '(' || input[i] === ')';
}

/** True for the dot in "TERM." — a heading word set in capitals, not a sentence end. */
function endsAllCapsWord(input: string, dotIndex: number): boolean {
  let i = dotIndex - 1;
  let caps = 0;
  while (i >= 0 && /[A-Z]/.test(input[i] ?? '')) {
    caps += 1;
    i -= 1;
  }
  return caps >= 2 && (i < 0 || isSpace(input[i]));
}

/**
 * Split into sentences.
 *
 * Written as a scanner rather than a regex because the interesting cases are all exceptions: a
 * lease is full of "1. ", "5.2 " and "TERM. ", and both `Intl.Segmenter` and a naive
 * `[.!?]\s+` regex treat every one of them as a sentence boundary, which shreds the document and
 * silently corrupts every readability figure computed from it.
 */
export function splitSentences(input: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    if (ch === '.' && (endsClauseNumber(input, i) || endsAllCapsWord(input, i))) continue;
    if (!isSpace(input[i + 1])) continue;

    let next = i + 1;
    while (next < input.length && isSpace(input[next])) next += 1;
    if (next >= input.length) break;
    if (!isSentenceOpener(input[next])) continue;

    out.push(input.slice(start, i + 1));
    start = next;
  }

  if (start < input.length) out.push(input.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function countWords(input: string): number {
  const matched = input.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu);
  return matched === null ? 0 : matched.length;
}

/** Truncate for display without cutting mid-word. */
export function truncateWords(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const cut = input.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
