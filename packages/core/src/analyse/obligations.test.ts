import { describe, expect, it } from 'vitest';
import type { Party } from '../domain/types.ts';
import { ingestPastedText } from '../ingest/index.ts';
import { segment } from '../segment/index.ts';
import {
  datedObligations,
  extractObligations,
  type ObligationDraft,
  obligationBalance,
  obligationsByParty,
} from './obligations.ts';

/**
 * The who-owes-what matrix.
 *
 * A tenant reads this to learn what they must do, by when, and what happens if they do not — so
 * every draft is checked for the party it is attributed to, the deadline and consequence it carries,
 * and a quote that is really in its clause. It runs with no model, which is what lets it survive a
 * dead provider.
 */

const LICENCE = `LEAVE AND LICENCE AGREEMENT

1. LICENCE FEE. The licensee shall pay the licence fee on or before the fifth day of each month, failing which interest at 18 per cent shall be charged.

2. DEPOSIT. The licensor shall refund the deposit within thirty (30) days upon vacating.

3. ENTRY. The licensor may enter the premises at least twenty-four hours after giving notice.

4. REPAIRS. The licensee is responsible for minor repairs. If the licensee fails to repair, the licensor may deduct the cost.

5. NOTICE. Either party may terminate this agreement by giving one month notice in advance.

6. GENERAL. This agreement shall be governed by the laws of India.
`;

function read(text: string) {
  const { clauses } = segment(ingestPastedText(text));
  return { clauses, drafts: extractObligations(clauses) };
}

function draftFor(
  drafts: readonly ObligationDraft[],
  fragment: string,
): ObligationDraft | undefined {
  return drafts.find((draft) => draft.quote.includes(fragment));
}

describe('extractObligations', () => {
  const { clauses, drafts } = read(LICENCE);

  it('attributes each duty to the party that owes it', () => {
    const parties: readonly [string, Party][] = [
      ['licensee shall pay', 'tenant'],
      ['licensor shall refund', 'landlord'],
      ['licensor may enter', 'landlord'],
      ['licensee is responsible', 'tenant'],
      ['Either party may terminate', 'both'],
    ];
    for (const [fragment, party] of parties) {
      expect(draftFor(drafts, fragment)?.party, fragment).toBe(party);
    }
  });

  it('attaches the deadline the sentence states', () => {
    expect(draftFor(drafts, 'licensee shall pay')?.when).toBe(
      'on or before the fifth day of each month',
    );
    expect(draftFor(drafts, 'licensor shall refund')?.when).toBe('within thirty (30) days');
    expect(draftFor(drafts, 'Either party may terminate')?.when).toBe('in advance');
  });

  it('reads a deadline written with a hyphenated number', () => {
    // Regression: `\w+` stopped at the hyphen, so "at least twenty-four hours" produced no deadline
    // and the entry right dropped out of the dated obligations entirely.
    expect(draftFor(drafts, 'licensor may enter')?.when).toBe('at least twenty-four hours');
  });

  it('attaches the consequence in the same sentence, or in the one that follows', () => {
    expect(draftFor(drafts, 'licensee shall pay')?.consequence).toBe(
      'failing which interest at 18 per cent shall be charged',
    );
    // The duty and its consequence are in different sentences, which is exactly why a lease is
    // hard to read by eye.
    expect(draftFor(drafts, 'licensee is responsible')?.consequence).toBe(
      'If the licensee fails to repair, the licensor may deduct the cost',
    );
    expect(draftFor(drafts, 'licensor shall refund')?.consequence).toBeNull();
  });

  it('skips a duty that names no party, rather than guessing whose it is', () => {
    expect(draftFor(drafts, 'governed by the laws of India')).toBeUndefined();
  });

  it('quotes every draft verbatim from the clause it cites', () => {
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      const clause = clauses.find((c) => c.id === draft.clauseId);
      expect(clause?.text, draft.quote).toContain(draft.quote);
    }
  });

  it('shortens a very long duty for display without losing the full quote', () => {
    const long = `1. USE. The tenant shall ${'keep the premises clean and tidy and '.repeat(10)}comply with the rules.`;
    const [draft] = read(long).drafts;
    expect(draft?.what.length).toBeLessThanOrEqual(221);
    expect(draft?.what.endsWith('…')).toBe(true);
    expect(draft?.quote.length).toBeGreaterThan(220);
  });
});

describe('obligationsByParty', () => {
  it('gives each party its own column and loses nothing', () => {
    const { drafts } = read(LICENCE);
    const columns = obligationsByParty(drafts);
    expect(columns.tenant.every((d) => d.party === 'tenant')).toBe(true);
    expect(columns.landlord.every((d) => d.party === 'landlord')).toBe(true);
    expect(columns.both.map((d) => d.party)).toEqual(['both']);
    expect(columns.unknown).toEqual([]);
    expect(
      columns.tenant.length +
        columns.landlord.length +
        columns.both.length +
        columns.unknown.length,
    ).toBe(drafts.length);
  });
});

describe('datedObligations', () => {
  it('keeps only the obligations that can go on a calendar', () => {
    const { drafts } = read(LICENCE);
    const dated = datedObligations(drafts);
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((d) => d.when !== null)).toBe(true);
    expect(dated.length).toBe(drafts.filter((d) => d.when !== null).length);
  });
});

describe('obligationBalance', () => {
  function drafts(parties: readonly Party[]): readonly ObligationDraft[] {
    return parties.map((party, i) => ({
      party,
      what: `duty ${i}`,
      when: null,
      consequence: null,
      clauseId: `c${i}`,
      quote: `duty ${i}`,
    }));
  }

  it('states the imbalance as a number rather than an adjective', () => {
    expect(obligationBalance(drafts(['tenant', 'tenant', 'tenant', 'landlord', 'both']))).toEqual({
      tenant: 3,
      landlord: 1,
      ratio: 3,
    });
  });

  it('rounds the ratio to one decimal place', () => {
    expect(
      obligationBalance(drafts(['tenant', 'tenant', 'landlord', 'landlord', 'landlord'])).ratio,
    ).toBe(0.7);
  });

  it('reports no ratio, not infinity, when the landlord owes nothing', () => {
    expect(obligationBalance(drafts(['tenant', 'tenant']))).toEqual({
      tenant: 2,
      landlord: 0,
      ratio: null,
    });
    expect(obligationBalance([])).toEqual({ tenant: 0, landlord: 0, ratio: null });
  });
});
