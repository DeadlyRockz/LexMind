/**
 * Precision, recall and F1 for multi-label clause typing.
 *
 * Pure: no I/O, no detector, no fixtures. It takes pairs of (expected types, predicted types) per
 * clause and counts. That keeps the arithmetic unit-testable on its own and lets Phase 11's
 * `scripts/eval.ts` reuse it for `reports/scorecard.md` without dragging the test runner along.
 *
 * ## What is counted
 *
 * Each (clause, type) decision is one binary judgement, because a clause may legitimately carry
 * several types ("RENT AND DEPOSIT" is both):
 *
 *  - **TP** — the type is labelled on the clause and predicted for it.
 *  - **FP** — predicted, not labelled.
 *  - **FN** — labelled, not predicted.
 *
 * ## Undefined is not zero
 *
 * Precision for a type the detector never predicted is 0/0, and recall for a type nobody labelled
 * is 0/0. Reporting either as 0 would invent a failure; reporting it as 1 would invent a success.
 * Both are `null`, rendered "n/a", and left out of the macro average — which is therefore the mean
 * over the types where the metric is defined, and says so.
 */

/** One clause, as the scorer sees it. `key` must be unique across the whole evaluated set. */
export interface LabelledPrediction {
  readonly key: string;
  readonly expected: readonly string[];
  readonly predicted: readonly string[];
}

export interface Counts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

export interface Rates {
  /** `null` when nothing was predicted: 0/0 is undefined, not a failure. */
  readonly precision: number | null;
  /** `null` when nothing was labelled. */
  readonly recall: number | null;
  /** `null` when either input is undefined; 0 when both are defined and nothing matched. */
  readonly f1: number | null;
}

export interface TypeScore extends Counts, Rates {
  readonly typeId: string;
  /** How many clauses carry this type in the labels. */
  readonly labelled: number;
  /** How many clauses the detector gave this type. */
  readonly predicted: number;
}

export interface TypingError {
  readonly key: string;
  readonly expected: readonly string[];
  readonly predicted: readonly string[];
  /** Labelled but not predicted. */
  readonly missing: readonly string[];
  /** Predicted but not labelled. */
  readonly extra: readonly string[];
}

export interface TypingScore {
  readonly clauses: number;
  /** Every type that was labelled, predicted, or named in the universe, sorted by id. */
  readonly perType: readonly TypeScore[];
  /** Pooled over every (clause, type) decision: dominated by the common types. */
  readonly micro: Counts & Rates;
  /** Unweighted mean over types where each metric is defined: every type counts equally. */
  readonly macro: Rates & { readonly typesAveraged: number };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function rates({ tp, fp, fn }: Counts): Rates {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function mean(values: readonly (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0) / defined.length;
}

function assertUniqueKeys(items: readonly LabelledPrediction[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) throw new Error(`Duplicate clause key in evaluation set: ${item.key}`);
    seen.add(item.key);
  }
}

/**
 * Score multi-label clause typing.
 *
 * @param universe type ids to report even when neither labelled nor predicted, so a scorecard can
 *   show which parts of the taxonomy the golden set does not exercise at all.
 */
export function scoreClauseTyping(
  items: readonly LabelledPrediction[],
  universe: readonly string[] = [],
): TypingScore {
  assertUniqueKeys(items);

  const tally = new Map<string, { tp: number; fp: number; fn: number }>();
  const entry = (typeId: string) => {
    let found = tally.get(typeId);
    if (found === undefined) {
      found = { tp: 0, fp: 0, fn: 0 };
      tally.set(typeId, found);
    }
    return found;
  };

  for (const typeId of universe) entry(typeId);

  for (const item of items) {
    // A type listed twice on one clause is still one decision.
    const expected = new Set(item.expected);
    const predicted = new Set(item.predicted);
    for (const typeId of expected) {
      if (predicted.has(typeId)) entry(typeId).tp += 1;
      else entry(typeId).fn += 1;
    }
    for (const typeId of predicted) {
      if (!expected.has(typeId)) entry(typeId).fp += 1;
    }
  }

  const perType: TypeScore[] = [...tally]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([typeId, counts]) => ({
      typeId,
      ...counts,
      labelled: counts.tp + counts.fn,
      predicted: counts.tp + counts.fp,
      ...rates(counts),
    }));

  const pooled: Counts = perType.reduce(
    (total, type) => ({ tp: total.tp + type.tp, fp: total.fp + type.fp, fn: total.fn + type.fn }),
    { tp: 0, fp: 0, fn: 0 },
  );

  // A type in the universe that nobody labelled and nothing predicted has every metric undefined,
  // so it cannot move the macro average; only exercised types are counted as averaged.
  const exercised = perType.filter((type) => type.labelled > 0 || type.predicted > 0);

  return {
    clauses: items.length,
    perType,
    micro: { ...pooled, ...rates(pooled) },
    macro: {
      precision: mean(exercised.map((type) => type.precision)),
      recall: mean(exercised.map((type) => type.recall)),
      f1: mean(exercised.map((type) => type.f1)),
      typesAveraged: exercised.length,
    },
  };
}

/** Every clause whose predicted types differ from its labels, with the difference spelled out. */
export function typingErrors(items: readonly LabelledPrediction[]): readonly TypingError[] {
  const errors: TypingError[] = [];
  for (const item of items) {
    const expected = new Set(item.expected);
    const predicted = new Set(item.predicted);
    const missing = [...expected].filter((typeId) => !predicted.has(typeId)).sort();
    const extra = [...predicted].filter((typeId) => !expected.has(typeId)).sort();
    if (missing.length === 0 && extra.length === 0) continue;
    errors.push({
      key: item.key,
      expected: item.expected,
      predicted: item.predicted,
      missing,
      extra,
    });
  }
  return errors;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

/**
 * The per-type table as Markdown, ready to drop into `reports/scorecard.md`.
 *
 * Types in the universe that the golden set never exercised are listed on one line under the table
 * rather than as rows of "n/a": silence about them would overstate coverage, and a row per type
 * would bury the numbers that exist.
 */
export function formatTypingTable(score: TypingScore): string {
  const exercised = score.perType.filter((type) => type.labelled > 0 || type.predicted > 0);
  const unexercised = score.perType.filter((type) => type.labelled === 0 && type.predicted === 0);

  const lines = [
    '| Clause type | Labelled | Predicted | TP | FP | FN | Precision | Recall | F1 |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|',
    ...exercised.map(
      (type) =>
        `| \`${type.typeId}\` | ${type.labelled} | ${type.predicted} | ${type.tp} | ${type.fp} | ` +
        `${type.fn} | ${formatRate(type.precision)} | ${formatRate(type.recall)} | ` +
        `${formatRate(type.f1)} |`,
    ),
    `| **micro** (${score.clauses} clauses) | ${score.micro.tp + score.micro.fn} | ` +
      `${score.micro.tp + score.micro.fp} | ${score.micro.tp} | ${score.micro.fp} | ` +
      `${score.micro.fn} | ${formatRate(score.micro.precision)} | ` +
      `${formatRate(score.micro.recall)} | ${formatRate(score.micro.f1)} |`,
    `| **macro** (${score.macro.typesAveraged} types) | | | | | | ` +
      `${formatRate(score.macro.precision)} | ${formatRate(score.macro.recall)} | ` +
      `${formatRate(score.macro.f1)} |`,
  ];

  if (unexercised.length > 0) {
    lines.push(
      '',
      `Not exercised by the golden set (${unexercised.length}): ` +
        unexercised.map((type) => `\`${type.typeId}\``).join(', '),
    );
  }
  return lines.join('\n');
}
