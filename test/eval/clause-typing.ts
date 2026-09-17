import { detectAllClauseTypes } from '../../packages/core/src/analyse/index.ts';
import { CLAUSE_TYPES } from '../../packages/core/src/domain/clause-types.ts';
import type { Clause } from '../../packages/core/src/domain/types.ts';
import { ingestPastedText } from '../../packages/core/src/ingest/index.ts';
import { segment } from '../../packages/core/src/segment/index.ts';
import type { ClauseTypeLabel, LeaseAnnotation } from '../fixtures/leases.ts';
import {
  type LabelledPrediction,
  scoreClauseTyping,
  type TypingError,
  type TypingScore,
  typingErrors,
} from './scoring.ts';

/**
 * Deterministic clause typing, measured against the hand-written labels on the golden set.
 *
 * The same path the product takes — paste ingest, `segment()`, `detectAllClauseTypes()` — with no
 * model anywhere, so the numbers are reproducible offline. Phase 11's `scripts/eval.ts` calls
 * `evaluateClauseTyping` and renders `formatTypingTable` into `reports/scorecard.md`.
 */

export interface ClauseTypingMiss extends TypingError {
  /** The clause text, so a miss can be read and routed without re-running anything. */
  readonly text: string;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(CLAUSE_TYPES.map((type) => type.id));

export interface ClauseTypingEvaluation {
  readonly score: TypingScore;
  readonly items: readonly LabelledPrediction[];
  readonly misses: readonly ClauseTypingMiss[];
}

/**
 * Join one lease's labels to the clauses the segmenter produced.
 *
 * Strict on purpose. A label for a clause that does not exist, a clause with no label, a label
 * whose opening text no longer matches its clause, or a type the taxonomy no longer has all mean the
 * ground truth has drifted — and scoring drifted labels would report a number that measures nothing.
 */
export function alignLabels(
  leaseId: string,
  labels: readonly ClauseTypeLabel[],
  clauses: readonly Pick<Clause, 'id' | 'text'>[],
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(labels.map((label) => [label.clauseId, label]));
  if (byId.size !== labels.length) {
    throw new Error(`${leaseId}: a clause id is labelled more than once`);
  }

  const aligned = new Map<string, readonly string[]>();
  for (const clause of clauses) {
    const label = byId.get(clause.id);
    if (label === undefined) {
      throw new Error(
        `${leaseId}/${clause.id} has no clause-type label: ${JSON.stringify(clause.text.slice(0, 60))}`,
      );
    }
    if (!clause.text.startsWith(label.opens)) {
      throw new Error(
        `${leaseId}/${clause.id} label expects text opening ${JSON.stringify(label.opens)}, ` +
          `segmenter produced ${JSON.stringify(clause.text.slice(0, 60))}`,
      );
    }
    const unknown = label.types.filter((typeId) => !KNOWN_TYPES.has(typeId));
    if (unknown.length > 0) {
      throw new Error(
        `${leaseId}/${clause.id} is labelled with unknown types: ${unknown.join(', ')}`,
      );
    }
    aligned.set(clause.id, label.types);
  }

  const produced = new Set(clauses.map((clause) => clause.id));
  const orphans = labels.filter((label) => !produced.has(label.clauseId));
  if (orphans.length > 0) {
    throw new Error(
      `${leaseId}: labels for clauses the segmenter did not produce: ` +
        orphans.map((label) => label.clauseId).join(', '),
    );
  }
  return aligned;
}

export function evaluateClauseTyping(leases: readonly LeaseAnnotation[]): ClauseTypingEvaluation {
  const items: LabelledPrediction[] = [];
  const textByKey = new Map<string, string>();

  for (const lease of leases) {
    const { clauses } = segment(ingestPastedText(lease.text));
    const expected = alignLabels(lease.id, lease.clauseTypes, clauses);
    const predicted = new Map(
      detectAllClauseTypes(clauses).map((typing) => [typing.clauseId, typing.typeIds]),
    );

    for (const clause of clauses) {
      const key = `${lease.id}/${clause.id}`;
      items.push({
        key,
        expected: expected.get(clause.id) ?? [],
        predicted: predicted.get(clause.id) ?? [],
      });
      textByKey.set(key, clause.text);
    }
  }

  const score = scoreClauseTyping(items, [...KNOWN_TYPES]);
  const misses = typingErrors(items).map((error) => ({
    ...error,
    text: textByKey.get(error.key) ?? '',
  }));
  return { score, items, misses };
}

/** Misses as plain lines, for a failing assertion message or a scorecard appendix. */
export function formatMisses(misses: readonly ClauseTypingMiss[]): string {
  return misses
    .map(
      (miss) =>
        `${miss.key}: expected [${miss.expected.join(', ')}], predicted [${miss.predicted.join(', ')}]` +
        (miss.missing.length > 0 ? ` — missed ${miss.missing.join(', ')}` : '') +
        (miss.extra.length > 0 ? ` — extra ${miss.extra.join(', ')}` : '') +
        `\n    ${JSON.stringify(miss.text)}`,
    )
    .join('\n');
}
