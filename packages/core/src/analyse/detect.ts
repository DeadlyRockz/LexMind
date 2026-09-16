import { CLAUSE_TYPES } from '../domain/clause-types.ts';
import type { Clause } from '../domain/types.ts';

/**
 * Clause typing from the taxonomy's synonym lists.
 *
 * Deterministic, and first in the pipeline, because it runs in microseconds with no API call and
 * because its output is what the rule engine targets. The model is used later to *explain* a
 * clause, never to decide what kind of clause it is.
 *
 * Scoring weights longer synonyms more heavily, which is the whole trick: "deposit" appears in
 * half a lease, while "interest free security deposit" appears in exactly one clause. A flat count
 * would let a passing mention outrank the clause that actually governs the subject.
 */

export interface ClauseTyping {
  readonly clauseId: string;
  /** Best first. Empty when nothing matched, which is a normal outcome for recitals. */
  readonly typeIds: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
  /** The synonym that produced the top score, so the UI can say why. */
  readonly matchedOn: string | null;
}

/** Below this, a match is a passing mention rather than the subject of the clause. */
const SCORE_FLOOR = 6;
const MAX_TYPES = 3;
/** A synonym in the heading is far stronger evidence than one buried in the body. */
const HEADING_WEIGHT = 3;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export function detectClauseTypes(clause: Clause): ClauseTyping {
  const body = clause.text.toLowerCase();
  const heading = [clause.heading ?? '', ...clause.headingTrail].join(' ').toLowerCase();

  const scores: Record<string, number> = {};
  let best = { id: '', score: 0, synonym: '' };

  for (const type of CLAUSE_TYPES) {
    let score = 0;
    let bestSynonym = '';

    for (const synonym of type.synonyms) {
      const term = synonym.toLowerCase();
      // Weight by phrase length: specificity is what distinguishes the governing clause from a
      // passing mention of the same word.
      const weight = Math.min(term.length, 30);
      const inBody = countOccurrences(body, term);
      const inHeading = countOccurrences(heading, term);
      const contribution = inBody * weight + inHeading * weight * HEADING_WEIGHT;

      if (contribution > 0) {
        score += contribution;
        if (term.length > bestSynonym.length) bestSynonym = term;
      }
    }

    if (score > 0) {
      scores[type.id] = score;
      if (score > best.score) best = { id: type.id, score, synonym: bestSynonym };
    }
  }

  const typeIds = Object.entries(scores)
    .filter(([, score]) => score >= SCORE_FLOOR)
    .sort(([aId, a], [bId, b]) => b - a || aId.localeCompare(bId))
    .slice(0, MAX_TYPES)
    .map(([id]) => id);

  return {
    clauseId: clause.id,
    typeIds,
    scores,
    matchedOn: best.synonym.length > 0 ? best.synonym : null,
  };
}

export function detectAllClauseTypes(clauses: readonly Clause[]): readonly ClauseTyping[] {
  return clauses.map(detectClauseTypes);
}

/** Clauses whose top type is the one asked for. Used by the rule engine to target its checks. */
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
 * that is worth knowing rather than hiding.
 */
export function untypedShare(typings: readonly ClauseTyping[]): number {
  if (typings.length === 0) return 0;
  const untyped = typings.filter((typing) => typing.typeIds.length === 0).length;
  return Math.round((untyped / typings.length) * 1000) / 1000;
}
