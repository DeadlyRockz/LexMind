import type { Clause } from '../domain/types.ts';
import type { NormalizedDocument } from '../ingest/types.ts';
import { assertClauseInvariant, segmentClauses } from './clauses.ts';
import { buildRetrievalIndex, type RetrievalIndex } from './lexical.ts';
import { buildMatchIndex, type MatchIndex } from './locate.ts';
import { buildOutline, type OutlineNode } from './outline.ts';

export {
  assertClauseInvariant,
  clauseAtOffset,
  clauseById,
  clauseReference,
  segmentClauses,
} from './clauses.ts';
export { headingTitle, looksLikeHeading, type Numbering, parseNumbering } from './headings.ts';
export {
  buildRetrievalIndex,
  type RetrievalHit,
  type RetrievalIndex,
  search,
  tokenize,
} from './lexical.ts';
export {
  buildMatchIndex,
  type LocatedQuote,
  locateQuote,
  type MatchIndex,
  MIN_QUOTE_CHARS,
  pinQuote,
} from './locate.ts';
export { buildOutline, flattenOutline, type OutlineNode, outlineDepth } from './outline.ts';

/**
 * Everything derived deterministically from a document, computed once.
 *
 * All of this runs with zero network calls in well under a millisecond for a typical lease, which
 * is why the UI can show real structure and real rule-based findings before any model call
 * returns — and why the product still works when there is no model at all.
 */
export interface SegmentedDocument {
  readonly document: NormalizedDocument;
  readonly clauses: readonly Clause[];
  readonly outline: readonly OutlineNode[];
  readonly retrieval: RetrievalIndex;
  /** The document in comparison form, for the citation verifier. Built once, reused everywhere. */
  readonly matchIndex: MatchIndex;
}

export function segment(document: NormalizedDocument): SegmentedDocument {
  const clauses = segmentClauses(document);
  assertClauseInvariant(document, clauses);

  return {
    document,
    clauses,
    outline: buildOutline(clauses),
    retrieval: buildRetrievalIndex(clauses),
    matchIndex: buildMatchIndex(document.text),
  };
}
