import { describe, expect, it } from 'vitest';
import { alignLabels } from './clause-typing.ts';
import {
  formatTypingTable,
  type LabelledPrediction,
  rates,
  scoreClauseTyping,
  typingErrors,
} from './scoring.ts';

function item(key: string, expected: string[], predicted: string[]): LabelledPrediction {
  return { key, expected, predicted };
}

function typeScore(score: ReturnType<typeof scoreClauseTyping>, typeId: string) {
  const found = score.perType.find((type) => type.typeId === typeId);
  if (found === undefined) throw new Error(`no row for ${typeId}`);
  return found;
}

describe('rates', () => {
  it('computes precision, recall and F1 from counts', () => {
    const result = rates({ tp: 3, fp: 1, fn: 2 });
    expect(result.precision).toBeCloseTo(0.75);
    expect(result.recall).toBeCloseTo(0.6);
    expect(result.f1).toBeCloseTo((2 * 0.75 * 0.6) / 1.35);
  });

  it('reports 0/0 as undefined rather than inventing a failure or a success', () => {
    expect(rates({ tp: 0, fp: 0, fn: 0 })).toEqual({ precision: null, recall: null, f1: null });
  });

  it('gives F1 of 0, not undefined, when both rates are defined and nothing matched', () => {
    expect(rates({ tp: 0, fp: 2, fn: 3 })).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});

describe('scoreClauseTyping', () => {
  it('counts each (clause, type) decision once, including multi-type clauses', () => {
    const score = scoreClauseTyping([
      item('a/c1', ['rent', 'security-deposit'], ['rent', 'security-deposit']),
      item('a/c2', ['rent'], ['rent', 'late-fee']),
      item('a/c3', ['late-fee'], []),
    ]);

    expect(typeScore(score, 'rent')).toMatchObject({
      tp: 2,
      fp: 0,
      fn: 0,
      labelled: 2,
      predicted: 2,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(typeScore(score, 'late-fee')).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 1,
      precision: 0,
      recall: 0,
      f1: 0,
    });
    expect(score.micro).toMatchObject({ tp: 3, fp: 1, fn: 1, precision: 0.75, recall: 0.75 });
    expect(score.clauses).toBe(3);
  });

  it('treats a type listed twice on one clause as one decision', () => {
    const score = scoreClauseTyping([item('a/c1', ['rent', 'rent'], ['rent', 'rent'])]);
    expect(typeScore(score, 'rent')).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });

  it('leaves precision undefined for a type labelled but never predicted', () => {
    const score = scoreClauseTyping([item('a/c1', ['pets'], [])]);
    expect(typeScore(score, 'pets')).toMatchObject({
      labelled: 1,
      predicted: 0,
      precision: null,
      recall: 0,
      f1: null,
    });
  });

  it('leaves recall undefined for a type predicted but never labelled', () => {
    const score = scoreClauseTyping([item('a/c1', [], ['parties'])]);
    expect(typeScore(score, 'parties')).toMatchObject({
      labelled: 0,
      predicted: 1,
      precision: 0,
      recall: null,
      f1: null,
    });
  });

  it('averages macro metrics over the types where each is defined', () => {
    const score = scoreClauseTyping(
      [
        item('a/c1', ['rent'], ['rent']), // rent: P 1, R 1
        item('a/c2', ['pets'], []), // pets: P n/a, R 0
        item('a/c3', [], ['parties']), // parties: P 0, R n/a
      ],
      ['rent', 'pets', 'parties', 'guarantor'],
    );
    expect(score.macro.typesAveraged).toBe(3);
    expect(score.macro.precision).toBeCloseTo(0.5); // (1 + 0) / 2
    expect(score.macro.recall).toBeCloseTo(0.5); // (1 + 0) / 2
    expect(score.macro.f1).toBeCloseTo(1); // only rent has a defined F1
  });

  it('reports universe types nobody labelled or predicted, without letting them move the averages', () => {
    const score = scoreClauseTyping([item('a/c1', ['rent'], ['rent'])], ['guarantor', 'rent']);
    expect(typeScore(score, 'guarantor')).toMatchObject({
      tp: 0,
      fp: 0,
      fn: 0,
      precision: null,
      recall: null,
      f1: null,
    });
    expect(score.macro).toEqual({ precision: 1, recall: 1, f1: 1, typesAveraged: 1 });
  });

  it('scores an empty document as undefined everywhere, not as perfect', () => {
    const score = scoreClauseTyping([]);
    expect(score.clauses).toBe(0);
    expect(score.perType).toEqual([]);
    expect(score.micro).toEqual({ tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null });
    expect(score.macro).toEqual({ precision: null, recall: null, f1: null, typesAveraged: 0 });
  });

  it('scores a document of untyped clauses correctly typed as nothing as undefined, not perfect', () => {
    const score = scoreClauseTyping([item('a/c1', [], []), item('a/c2', [], [])]);
    expect(score.micro.precision).toBeNull();
    expect(score.micro.recall).toBeNull();
  });

  it('sorts rows by type id so the table is stable across runs', () => {
    const score = scoreClauseTyping([item('a/c1', ['rent', 'lock-in'], ['utilities'])]);
    expect(score.perType.map((type) => type.typeId)).toEqual(['lock-in', 'rent', 'utilities']);
  });

  it('refuses duplicate clause keys, which would double-count a clause', () => {
    expect(() => scoreClauseTyping([item('a/c1', [], []), item('a/c1', [], [])])).toThrow(
      /Duplicate clause key/,
    );
  });
});

describe('typingErrors', () => {
  it('lists only the clauses that differ, with what was missed and what was extra', () => {
    const errors = typingErrors([
      item('a/c1', ['rent'], ['rent']),
      item(
        'a/c2',
        ['notice-periods', 'termination-tenant'],
        ['notice-periods', 'inspection-entry'],
      ),
    ]);
    expect(errors).toEqual([
      {
        key: 'a/c2',
        expected: ['notice-periods', 'termination-tenant'],
        predicted: ['notice-periods', 'inspection-entry'],
        missing: ['termination-tenant'],
        extra: ['inspection-entry'],
      },
    ]);
  });

  it('is empty when every clause is typed exactly as labelled', () => {
    expect(typingErrors([item('a/c1', ['rent'], ['rent']), item('a/c2', [], [])])).toEqual([]);
  });
});

describe('formatTypingTable', () => {
  it('renders exercised types as rows, averages as footer rows, and names the unexercised', () => {
    const score = scoreClauseTyping(
      [item('a/c1', ['rent'], ['rent']), item('a/c2', ['pets'], [])],
      ['guarantor', 'pets', 'rent'],
    );
    const table = formatTypingTable(score);

    expect(table).toContain('| `rent` | 1 | 1 | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |');
    expect(table).toContain('| `pets` | 1 | 0 | 0 | 0 | 1 | n/a | 0.00 | n/a |');
    expect(table).toContain('| **micro** (2 clauses) | 2 | 1 | 1 | 0 | 1 | 1.00 | 0.50 | 0.67 |');
    expect(table).toContain('| **macro** (2 types) |');
    expect(table).toContain('Not exercised by the golden set (1): `guarantor`');
    expect(table).not.toContain('| `guarantor` |');
  });

  it('omits the unexercised line when every type was exercised', () => {
    const table = formatTypingTable(scoreClauseTyping([item('a/c1', ['rent'], ['rent'])]));
    expect(table).not.toContain('Not exercised');
  });
});

describe('alignLabels', () => {
  const clauses = [
    { id: 'c1', text: 'TENANCY AGREEMENT' },
    { id: 'c2', text: '1. RENT The tenant shall pay rent of 1,000 each month.' },
  ];

  it('maps each segmenter clause id to its labelled types', () => {
    const aligned = alignLabels(
      'lease',
      [
        { clauseId: 'c1', opens: 'TENANCY AGREEMENT', types: [] },
        { clauseId: 'c2', opens: '1. RENT', types: ['rent'] },
      ],
      clauses,
    );
    expect(aligned.get('c1')).toEqual([]);
    expect(aligned.get('c2')).toEqual(['rent']);
  });

  it('fails when a clause has no label', () => {
    expect(() =>
      alignLabels('lease', [{ clauseId: 'c1', opens: 'TENANCY', types: [] }], clauses),
    ).toThrow(/lease\/c2 has no clause-type label/);
  });

  it('fails when segmentation drifts and a label now points at different text', () => {
    expect(() =>
      alignLabels(
        'lease',
        [
          { clauseId: 'c1', opens: 'TENANCY AGREEMENT', types: [] },
          { clauseId: 'c2', opens: '2. SECURITY DEPOSIT', types: ['security-deposit'] },
        ],
        clauses,
      ),
    ).toThrow(/label expects text opening "2. SECURITY DEPOSIT"/);
  });

  it('fails on a label for a clause the segmenter did not produce', () => {
    expect(() =>
      alignLabels(
        'lease',
        [
          { clauseId: 'c1', opens: 'TENANCY', types: [] },
          { clauseId: 'c2', opens: '1. RENT', types: ['rent'] },
          { clauseId: 'c3', opens: '2. NOTICE', types: ['notice-periods'] },
        ],
        clauses,
      ),
    ).toThrow(/did not produce: c3/);
  });

  it('fails on a clause id labelled twice', () => {
    expect(() =>
      alignLabels(
        'lease',
        [
          { clauseId: 'c1', opens: 'TENANCY', types: [] },
          { clauseId: 'c1', opens: 'TENANCY', types: [] },
        ],
        clauses,
      ),
    ).toThrow(/labelled more than once/);
  });

  it('fails on a type the taxonomy does not define', () => {
    // A cast is the point: the fixture file is type-checked, but a renamed taxonomy id must still
    // fail at runtime under a test runner that strips types.
    const bogus = ['not-a-type'] as unknown as readonly ['rent'];
    expect(() =>
      alignLabels(
        'lease',
        [
          { clauseId: 'c1', opens: 'TENANCY', types: [] },
          { clauseId: 'c2', opens: '1. RENT', types: bogus },
        ],
        clauses,
      ),
    ).toThrow(/unknown types: not-a-type/);
  });
});
