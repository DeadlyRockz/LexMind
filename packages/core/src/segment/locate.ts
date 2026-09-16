import { findAllOccurrences, foldPunctuation, normalizeForMatch } from '../util/text.ts';

/**
 * Resolve a quote back to exact character offsets.
 *
 * This is the function the citation verifier depends on, so it is deliberately conservative:
 *
 *   1. exact match on the normalized document text
 *   2. match after whitespace, ligature and case folding — needed because PDF extraction
 *      introduces drift a model will not reproduce byte for byte
 *   3. **fail, and return nothing**
 *
 * There is no edit-distance step, and that is a design decision rather than an omission. A loose
 * similarity threshold manufactures citations that *look* verified and are not, which is strictly
 * worse than no citation: the reader sees a quotation mark and a clause number and reasonably
 * concludes the document says something it does not.
 *
 * Every occurrence is returned, never just the first. "thirty (30) days" appears many times in a
 * lease, and a citation pinned to the wrong occurrence points the reader at the wrong clause —
 * a wrong answer with a footnote.
 */

export interface LocatedQuote {
  readonly charStart: number;
  readonly charEnd: number;
  readonly matchKind: 'exact' | 'normalized';
}

/**
 * The document text in comparison form, with a character-level map back to the original offsets.
 *
 * Built once per document and reused: without the map, a normalized match tells you the quote is
 * present but not *where*, and a citation without a position cannot be highlighted or verified.
 */
export interface MatchIndex {
  readonly norm: string;
  /** `starts[i]` is the original offset of the character that produced `norm[i]`. */
  readonly starts: readonly number[];
  /** `ends[i]` is the original end offset (exclusive) of that same character. */
  readonly ends: readonly number[];
}

/**
 * A quote shorter than this, after folding, is not anchored enough to cite: "days" or "the rent"
 * occurs throughout a lease, so resolving it would be arbitrary rather than wrong-by-accident.
 */
export const MIN_QUOTE_CHARS = 12;

export function buildMatchIndex(text: string): MatchIndex {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];

  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i);
    const charLength = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const original = text.slice(i, i + charLength);
    const folded = foldPunctuation(original.normalize('NFKC')).toLowerCase();

    if (folded.trim().length === 0) {
      // Whitespace collapses to a single space, and a leading run produces nothing.
      if (norm.length > 0 && !norm.endsWith(' ')) {
        norm += ' ';
        starts.push(i);
        ends.push(i + charLength);
      }
    } else {
      for (const char of folded) {
        norm += char;
        starts.push(i);
        ends.push(i + charLength);
      }
    }
    i += charLength;
  }

  // Match the trailing trim in `normalizeForMatch`.
  while (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    starts.pop();
    ends.pop();
  }

  return { norm, starts, ends };
}

export function locateQuote(
  documentText: string,
  quote: string,
  index?: MatchIndex,
): readonly LocatedQuote[] {
  const wanted = normalizeForMatch(quote);
  if (wanted.length < MIN_QUOTE_CHARS) return [];

  const exact = findAllOccurrences(documentText, quote)
    .map(
      (charStart): LocatedQuote => ({
        charStart,
        charEnd: charStart + quote.length,
        matchKind: 'exact',
      }),
    )
    .filter((hit) => normalizeForMatch(documentText.slice(hit.charStart, hit.charEnd)) === wanted);
  if (exact.length > 0) return exact;

  const matchIndex = index ?? buildMatchIndex(documentText);
  return findAllOccurrences(matchIndex.norm, wanted)
    .map((at): LocatedQuote | null => {
      const charStart = matchIndex.starts[at];
      const charEnd = matchIndex.ends[at + wanted.length - 1];
      if (charStart === undefined || charEnd === undefined) return null;
      return { charStart, charEnd, matchKind: 'normalized' };
    })
    .filter((hit): hit is LocatedQuote => hit !== null)
    .filter((hit) => normalizeForMatch(documentText.slice(hit.charStart, hit.charEnd)) === wanted);
}

/**
 * Pin a quote to a single position, using the clause the model claimed to disambiguate.
 *
 * Returns `null` rather than guessing when the quote cannot be pinned uniquely. The verifier
 * treats that as a dropped citation, which is the intended behaviour — an ambiguous anchor is
 * indistinguishable, to the reader, from a confident wrong one.
 */
export function pinQuote(
  documentText: string,
  quote: string,
  options?: {
    readonly index?: MatchIndex;
    readonly within?: { readonly charStart: number; readonly charEnd: number };
  },
): LocatedQuote | null {
  const hits = locateQuote(documentText, quote, options?.index);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0] ?? null;

  const within = options?.within;
  if (within === undefined) return null;

  const inside = hits.filter(
    (hit) => hit.charStart >= within.charStart && hit.charEnd <= within.charEnd,
  );
  return inside.length === 1 ? (inside[0] ?? null) : null;
}
