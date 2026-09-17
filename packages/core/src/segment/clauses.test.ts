import { describe, expect, it } from 'vitest';
import type { Clause } from '../domain/types.ts';
import { buildDocument } from '../ingest/offsets.ts';
import type { Block } from '../ingest/types.ts';
import {
  assertClauseInvariant,
  clauseAtOffset,
  clauseById,
  clauseReference,
  segmentClauses,
} from './clauses.ts';

/**
 * Clause segmentation, driven from blocks so each item's heading level is chosen by the test rather
 * than inferred by a parser. Every citation LexMind shows is a clause reference plus offsets, so the
 * reference text and the offset invariant are the parts a reader actually sees.
 */

function documentOf(blocks: readonly (string | Block)[]) {
  return buildDocument(
    blocks.map((block) => (typeof block === 'string' ? { text: block, page: 1 } : block)),
    { sourceKind: 'docx', pageCount: 1 },
  );
}

function clause(overrides: Partial<Clause>): Clause {
  return {
    id: 'c1',
    path: [],
    headingTrail: [],
    heading: null,
    text: 'The tenant shall keep the premises clean.',
    charStart: 0,
    charEnd: 41,
    pageStart: 3,
    pageEnd: 3,
    level: 1,
    ...overrides,
  };
}

describe('segmentClauses', () => {
  it('gives an unnumbered opening paragraph a clause of its own, one level below the trail', () => {
    const document = documentOf([
      'This agreement is made on 1 April 2026 between the parties named below.',
      '1. The tenant shall pay rent monthly.',
    ]);
    const [recital, rent] = segmentClauses(document);
    expect(recital?.path).toEqual([]);
    expect(recital?.heading).toBeNull();
    expect(recital?.level).toBe(1);
    expect(rent?.path).toEqual(['1']);
  });

  it('starts a clause at an unstyled capitalised heading, and nests below the styled one above it', () => {
    const document = documentOf([
      { text: 'TENANCY AGREEMENT', page: 1, headingLevel: 1 },
      'SECURITY DEPOSIT',
      'The deposit is refundable within fourteen days.',
    ]);
    const clauses = segmentClauses(document);
    const deposit = clauses.find((c) => c.heading === 'SECURITY DEPOSIT');
    expect(deposit).toBeDefined();
    expect(deposit?.headingTrail).toEqual(['TENANCY AGREEMENT']);
    expect(deposit?.level).toBe(2);
    expect(deposit?.text).toBe(
      'SECURITY DEPOSIT\n\nThe deposit is refundable within fourteen days.',
    );
  });

  it('resumes collecting at a schedule after the signatures, because schedules carry real terms', () => {
    const document = documentOf([
      '1. The tenant shall pay rent monthly.',
      'IN WITNESS WHEREOF the parties have signed.',
      'Signed by the Landlord',
      'Schedule A - Inventory',
      'One refrigerator and two beds.',
    ]);
    const joined = segmentClauses(document)
      .map((c) => c.text)
      .join('\n');
    expect(joined).not.toMatch(/IN WITNESS WHEREOF|Signed by the Landlord/);
    expect(joined).toMatch(/Schedule A - Inventory\n\nOne refrigerator and two beds\./);
  });

  it('holds the offset invariant on every clause it produces', () => {
    const document = documentOf(['PREAMBLE', 'Text.', '1. One.', '2. Two.']);
    expect(() => assertClauseInvariant(document, segmentClauses(document))).not.toThrow();
  });
});

describe('assertClauseInvariant', () => {
  it('names the clause whose offsets have drifted from its text', () => {
    const document = documentOf(['1. The tenant shall pay rent monthly.']);
    const [first] = segmentClauses(document);
    if (first === undefined) throw new Error('expected a clause');
    const drifted = { ...first, charStart: first.charStart + 1 };
    expect(() => assertClauseInvariant(document, [drifted])).toThrow(
      /Clause c1 offsets do not match its text/,
    );
  });
});

describe('clause lookup', () => {
  const document = documentOf(['1. Rent is due monthly.', '2. The deposit is refundable.']);
  const clauses = segmentClauses(document);

  it('finds a clause by id, and nothing for an unknown id', () => {
    expect(clauseById(clauses, 'c2')?.path).toEqual(['2']);
    expect(clauseById(clauses, 'c9')).toBeUndefined();
  });

  it('finds the clause containing an offset, with an exclusive end', () => {
    const second = clauses[1];
    if (second === undefined) throw new Error('expected two clauses');
    expect(clauseAtOffset(clauses, second.charStart)?.id).toBe('c2');
    expect(clauseAtOffset(clauses, second.charEnd)).toBeUndefined();
    // The paragraph separator between clauses belongs to neither.
    expect(clauseAtOffset(clauses, second.charStart - 1)).toBeUndefined();
  });
});

describe('clauseReference', () => {
  it('uses the nearest heading and the clause number', () => {
    expect(
      clauseReference(clause({ headingTrail: ['LEASE', 'ARTICLE 8 - DEPOSIT'], path: ['8', '3'] })),
    ).toBe('ARTICLE 8 - DEPOSIT › Clause 8.3');
  });

  it('falls back to the clause heading when it has no number', () => {
    expect(clauseReference(clause({ heading: 'SECURITY DEPOSIT' }))).toBe('SECURITY DEPOSIT');
  });

  it('falls back to the page when there is nothing else to name it by', () => {
    expect(clauseReference(clause({}))).toBe('Page 3');
  });
});
