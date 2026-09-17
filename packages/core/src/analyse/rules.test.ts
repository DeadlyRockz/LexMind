import { describe, expect, it } from 'vitest';
import { resolveJurisdiction } from '../domain/jurisdictions/index.ts';
import { riskPattern } from '../domain/risk-taxonomy.ts';
import type { JurisdictionId } from '../domain/types.ts';
import { ingestPastedText } from '../ingest/index.ts';
import { segment } from '../segment/index.ts';
import { detectAllClauseTypes } from './detect.ts';
import { extractFacts } from './facts.ts';
import { applyCueRules, applyRules, matchesCues } from './rules.ts';

/**
 * Unit tests for the cue layer.
 *
 * A cue rule that fires on the wrong clause does not merely add noise: `unilateral-termination-
 * landlord` is reported to the reader as "the landlord can end the tenancy at will", and
 * `landlord-attorney-fees` as "the tenant pays the landlord legal costs". Fired on drafting that
 * says the opposite, each one tells a tenant something false about their own lease, at critical
 * and high severity, with a statutory citation attached. Precision is tested here as carefully as
 * recall, and both halves of every row are pinned.
 */

function analyse(text: string, declared?: JurisdictionId) {
  const segmented = segment(ingestPastedText(text));
  const typings = detectAllClauseTypes(segmented.clauses);
  const extracted = extractFacts(segmented.clauses, typings);
  const jurisdiction = resolveJurisdiction(segmented.document.text, declared);
  return {
    clauses: segmented.clauses,
    candidates: applyRules({ clauses: segmented.clauses, typings, extracted, jurisdiction }),
    cueCandidates: applyCueRules({ clauses: segmented.clauses, typings, extracted, jurisdiction }),
  };
}

// ─── Precision: the cases the conjunction must not span ────────────────────────────────────────

describe('a cue pattern is satisfied within one sentence, or not at all', () => {
  it('does not read "rent is payable immediately" as a lease with no cure period', () => {
    const clause =
      'Rent is payable immediately on the first of each month. Failure to pay is a breach. ' +
      'Either party may terminate on ninety days notice.';
    expect(matchesCues(clause, riskPattern('no-cure-period'))).toBeNull();
  });

  it('does not report a tenant break right as the landlord ending the tenancy at will', () => {
    const clause =
      'The Tenant may terminate this Agreement on thirty days notice at any time without penalty.';
    expect(matchesCues(clause, riskPattern('unilateral-termination-landlord'))).toBeNull();
  });

  it('does not report the landlord paying the tenant costs as the tenant paying the landlord', () => {
    const clause =
      'In any dispute the Landlord shall pay the reasonable legal costs of the Tenant. ' +
      'The Tenant shall keep the premises clean.';
    expect(matchesCues(clause, riskPattern('landlord-attorney-fees'))).toBeNull();
  });

  it('does not fire on a balanced clause that happens to contain both halves separately', () => {
    const clause =
      'The landlord shall keep the structure in repair. The tenant shall keep the interior in ' +
      'reasonable decorative order and shall report any disrepair promptly.';
    expect(matchesCues(clause, riskPattern('maintenance-shifted-to-tenant'))).toBeNull();
  });
});

// ─── Recall: the true positives those rows exist for ───────────────────────────────────────────

describe('the drafting each row exists to catch still fires', () => {
  const rows: readonly [Parameters<typeof riskPattern>[0], string][] = [
    [
      'unilateral-termination-landlord',
      'The Licensor may terminate this agreement at any time without assigning any reason by giving seven days notice.',
    ],
    [
      'unilateral-termination-landlord',
      'The landlord may recover possession by serving a section 21 notice at any time after the fixed term, without assigning any reason.',
    ],
    [
      'landlord-attorney-fees',
      'In any action arising under this lease, tenant agrees to pay the attorney fees and costs of litigation incurred by the landlord.',
    ],
    [
      'landlord-attorney-fees',
      'In the event of any dispute, the licensee shall pay the advocate fee and all legal costs incurred by the licensor.',
    ],
    [
      'no-cure-period',
      'On any breach by the licensee, the licensor may terminate this agreement with immediate effect, re-enter and lock the premises.',
    ],
    [
      'maintenance-shifted-to-tenant',
      'The licensee shall be responsible for all repairs to the scheduled premises, including structural repairs.',
    ],
    ['deposit-non-refundable', 'An administration fee of £300 is payable and is non-refundable.'],
  ];

  for (const [patternId, clause] of rows) {
    it(`${patternId}: ${clause.slice(0, 48)}…`, () => {
      expect(matchesCues(clause, riskPattern(patternId))).not.toBeNull();
    });
  }
});

// ─── The exclusion list, and the phrase that switched off its own rule ─────────────────────────

describe('no-cure-period and its exclusions', () => {
  const pattern = riskPattern('no-cure-period');

  const fires = [
    'On any default the Landlord may terminate this Agreement with immediate effect and no opportunity to cure shall be given.',
    'There shall be no cure period; on any default this Agreement stands terminated forthwith.',
    'On any breach the Landlord may terminate immediately, without any opportunity to remedy the breach.',
    'Upon any default the Landlord may terminate this Agreement forthwith.',
  ];

  for (const clause of fires) {
    it(`fires on "${clause.slice(0, 52)}…"`, () => {
      // Three of these four were dropped in silence: the cue "no opportunity to" and the exclusion
      // "opportunity to cure" match the same characters, and the exclusion won — so the rule named
      // no-cure-period was disabled by the literal phrase "no cure period".
      expect(matchesCues(clause, pattern)).not.toBeNull();
    });
  }

  const suppressed = [
    'On any breach the Landlord may terminate the tenancy immediately, provided the Tenant is first given a fourteen day cure period.',
    'On any breach the Landlord may terminate the tenancy immediately after giving the Tenant an opportunity to remedy it.',
    'The Landlord may terminate immediately if the breach is not put right within the notice to remedy period.',
  ];

  for (const clause of suppressed) {
    it(`stays silent on "${clause.slice(0, 52)}…"`, () => {
      // A stated chance to put the breach right is the answer to this check, and still is.
      expect(matchesCues(clause, pattern)).toBeNull();
    });
  }

  it('leaves other patterns their exclusions', () => {
    expect(
      matchesCues(
        'No waiver of any breach of this agreement shall be a waiver of any right or remedy under it.',
        riskPattern('waiver-of-legal-rights'),
      ),
    ).toBeNull();
  });
});

// ─── Word boundaries ───────────────────────────────────────────────────────────────────────────

describe('cue matching respects word boundaries', () => {
  it('does not match a cue inside a longer word', () => {
    // 'fail' inside "unfailingly", 'bond' inside "abscond", 'violat' inside nothing at all.
    expect(
      matchesCues(
        'The tenant shall unfailingly observe the rules and shall not abscond with the fittings.',
        riskPattern('no-cure-period'),
      ),
    ).toBeNull();
  });

  it('still matches a deliberate stem', () => {
    expect(
      matchesCues(
        'On any default the Licensor may terminate this agreement forthwith.',
        riskPattern('no-cure-period'),
      ),
    ).not.toBeNull();
  });
});

// ─── What a finding quotes ─────────────────────────────────────────────────────────────────────

describe('applyCueRules', () => {
  const LEASE = `LEAVE AND LICENCE AGREEMENT

1. LEGAL COSTS
The premises shall be kept clean at all times. In the event of any dispute, the licensee shall pay
the advocate fee and all legal costs incurred by the licensor.
`;

  it('quotes the sentence in which the pattern was actually satisfied', () => {
    const { cueCandidates, clauses } = analyse(LEASE);
    const fees = cueCandidates.find((c) => c.patternId === 'landlord-attorney-fees');
    expect(fees).toBeDefined();
    expect(fees?.quote).toMatch(/advocate fee/);
    expect(fees?.quote).not.toMatch(/kept clean/);

    const clause = clauses.find((c) => c.id === fees?.clauseId);
    expect(clause?.text).toContain(fees?.quote ?? '');
  });

  it('reports the phrase it matched on, verbatim from the document', () => {
    const { cueCandidates } = analyse(LEASE);
    const fees = cueCandidates.find((c) => c.patternId === 'landlord-attorney-fees');
    expect(fees?.detail).toMatch(/The clause says "/);
  });
});

// ─── Calibration ───────────────────────────────────────────────────────────────────────────────

describe('a balanced tenancy', () => {
  const FAIR = `RESIDENTIAL TENANCY AGREEMENT

1. TERM
The tenancy runs for twelve months from 1 April 2026.

2. RENT
The tenant shall pay rent of 1,200 each month, in advance, on the first day of the month.

3. SECURITY DEPOSIT
The tenant shall pay a security deposit equal to one month of rent. The landlord shall return the
deposit within fourteen days after the tenancy ends, less any amount properly owed.

4. REPAIRS
The landlord shall keep in repair the structure and exterior of the property. The tenant shall
keep the interior in reasonable decorative order.

5. ENTRY
The landlord may enter after giving the tenant at least twenty-four hours written notice, except
in an emergency.

6. NOTICE
Either party may end this tenancy by giving the other one month written notice.

7. DISPUTES
Either party may take a dispute to a court or tribunal. Each party bears their own legal costs.
`;

  it('produces no finding of any kind', () => {
    // The most valuable assertion in the file: a tool that flags everything teaches nothing.
    const { candidates } = analyse(FAIR);
    expect(candidates.map((c) => c.patternId)).toEqual([]);
  });

  it('produces none under a declared jurisdiction either', () => {
    const { candidates } = analyse(FAIR, 'IN-MTA');
    expect(candidates.map((c) => c.patternId)).toEqual([]);
  });
});
