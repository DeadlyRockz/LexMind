import { describe, expect, it } from 'vitest';
import {
  JURISDICTIONS,
  type JurisdictionResolution,
  type JurisdictionRules,
  resolveJurisdiction,
} from '../domain/jurisdictions/index.ts';
import { ALL_RISK_PATTERNS, riskPattern } from '../domain/risk-taxonomy.ts';
import { type Clause, EMPTY_FACTS, type JurisdictionId, type LeaseFacts } from '../domain/types.ts';
import { ingestPastedText } from '../ingest/index.ts';
import { segment } from '../segment/index.ts';
import { detectAllClauseTypes } from './detect.ts';
import {
  type ExtractedFacts,
  extractFacts,
  type FactConflict,
  type FactEvidence,
} from './facts.ts';
import {
  applyNumericRules,
  applyRules,
  type Candidate,
  escalationRate,
  matchesCues,
  type RuleInput,
  rulingFor,
  unreachablePatterns,
} from './rules.ts';

/**
 * Unit tests for the arithmetic half of the rule engine.
 *
 * Every finding here is a number compared against a cited limit, which is precisely the kind of
 * statement a tenant will act on — "your deposit is 1.5 times the cap" is repeated to a landlord, not
 * re-derived. So each rule is pinned on both sides of its boundary, on the jurisdiction that has no
 * limit at all, and on the input that must never produce a finding: a figure whose evidence does not
 * point at a clause the reader can be shown.
 *
 * Inputs are built by hand rather than parsed from a lease, so a failure here names the rule and not
 * the extractor in front of it. A final block runs the same rules end to end from real drafting.
 */

function clause(id: string, text: string): Clause {
  return {
    id,
    path: [],
    headingTrail: [],
    heading: null,
    text,
    charStart: 0,
    charEnd: text.length,
    pageStart: 1,
    pageEnd: 1,
    level: 1,
  };
}

interface Scenario {
  readonly clauses: readonly Clause[];
  readonly facts: Partial<LeaseFacts>;
  readonly evidence: Partial<Record<keyof LeaseFacts, FactEvidence>>;
  readonly jurisdiction: JurisdictionId | JurisdictionResolution;
  readonly conflicts?: readonly FactConflict[];
}

function input(scenario: Scenario): RuleInput {
  const extracted: ExtractedFacts = {
    facts: { ...EMPTY_FACTS, ...scenario.facts },
    evidence: scenario.evidence,
    notices: [],
    conflicts: scenario.conflicts ?? [],
    notes: [],
  };
  const jurisdiction =
    typeof scenario.jurisdiction === 'string'
      ? resolveJurisdiction('', scenario.jurisdiction)
      : scenario.jurisdiction;
  return { clauses: scenario.clauses, typings: [], extracted, jurisdiction };
}

function fired(scenario: Scenario, patternId: string): readonly Candidate[] {
  return applyNumericRules(input(scenario)).filter((c) => c.patternId === patternId);
}

/** A jurisdiction resolved as `id`, with some of its limits replaced. */
function withRules(id: JurisdictionId, rules: Partial<JurisdictionRules>): JurisdictionResolution {
  return { ...resolveJurisdiction('', id), rules: { ...JURISDICTIONS[id], ...rules } };
}

const at = (id: string, quote: string): FactEvidence => ({ clauseId: id, quote });

// ─── Deposit caps ──────────────────────────────────────────────────────────────────────────────

describe('the deposit cap, stated in weeks (England)', () => {
  const text = 'The tenant shall pay a deposit equal to one month of rent.';
  const clauses = [clause('c1', text)];
  const evidence = { depositMonths: at('c1', text) };

  it('clears a one-month deposit, which is about 4.3 weeks against a five-week cap', () => {
    expect(
      fired(
        { clauses, evidence, facts: { depositMonths: 1 }, jurisdiction: 'GB-ENG' },
        'deposit-excessive',
      ),
    ).toEqual([]);
  });

  it('reports a six-and-a-half week deposit, with the cap citation and its note', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { depositMonths: 1.5 }, jurisdiction: 'GB-ENG' },
      'deposit-excessive',
    );
    expect(finding?.detail).toMatch(/about 6\.5 weeks of rent/);
    expect(finding?.detail).toMatch(/limit that applies here is 5 weeks/);
    expect(finding?.detail).toMatch(/£50,000/);
    expect(finding?.citations).toEqual(['GB-TFA-2019']);
    expect(finding?.quote).toBe(text);
  });

  it('omits the trailing note when the limit carries none', () => {
    const jurisdiction = withRules('GB-ENG', {
      depositCapWeeks: { value: 5, citation: 'GB-TFA-2019' },
    });
    const [finding] = fired(
      { clauses, evidence, facts: { depositMonths: 2 }, jurisdiction },
      'deposit-excessive',
    );
    expect(finding?.detail).toBe(
      'The deposit is about 8.7 weeks of rent. The limit that applies here is 5 weeks.',
    );
  });

  it('cites the provision that sets a limit even where the pattern has no ruling of its own', () => {
    // The status stays `unknown` — no ruling, no legal claim about the clause — but the arithmetic
    // is against a specific provision, and a comparison with a number must name where it came from.
    const jurisdiction = withRules('unknown', {
      depositCapWeeks: { value: 5, citation: 'GB-TFA-2019' },
    });
    const [finding] = fired(
      { clauses, evidence, facts: { depositMonths: 2 }, jurisdiction },
      'deposit-excessive',
    );
    expect(finding?.citations).toEqual(['GB-TFA-2019']);
    expect(finding?.severityInputs.statutoryStatus).toBe('unknown');
  });
});

describe('the deposit cap, stated in months', () => {
  const text = 'The licensee shall pay a security deposit of Rs. 75,000.';
  const clauses = [clause('c1', text)];

  it('falls back to the deposit amount as evidence when no multiple was stated', () => {
    const [finding] = fired(
      {
        clauses,
        evidence: { depositAmount: at('c1', text) },
        facts: { depositMonths: 3 },
        jurisdiction: 'IN-MTA',
      },
      'deposit-excessive',
    );
    expect(finding?.detail).toMatch(/3 months of rent\. The limit that applies here is 2 months/);
    expect(finding?.detail).toMatch(/1\.5 times the limit/);
    expect(finding?.citations).toEqual(['IN-MTA-11-1']);
  });

  it('writes "month" for a one-month cap', () => {
    const [finding] = fired(
      {
        clauses,
        evidence: { depositAmount: at('c1', text) },
        facts: { depositMonths: 3 },
        jurisdiction: 'US-NY',
      },
      'deposit-excessive',
    );
    expect(finding?.detail).toMatch(/is 1 month, so the deposit is 3 times the limit\.$/);
  });

  it('applies no cap where the jurisdiction states none, however large the deposit', () => {
    for (const id of ['IN-STATE', 'unknown'] as const) {
      expect(
        fired(
          {
            clauses,
            evidence: { depositAmount: at('c1', text) },
            facts: { depositMonths: 6 },
            jurisdiction: id,
          },
          'deposit-excessive',
        ),
        id,
      ).toEqual([]);
    }
  });

  it('makes no finding when the evidence names a clause the reader cannot be shown', () => {
    expect(
      fired(
        {
          clauses,
          evidence: { depositAmount: at('c9', text) },
          facts: { depositMonths: 3 },
          jurisdiction: 'IN-MTA',
        },
        'deposit-excessive',
      ),
    ).toEqual([]);
  });

  it('makes no finding from a zero or negative ratio', () => {
    const evidence = { depositAmount: at('c1', text) };
    for (const months of [0, -2]) {
      expect(
        fired(
          { clauses, evidence, facts: { depositMonths: months }, jurisdiction: 'IN-MTA' },
          'deposit-excessive',
        ),
      ).toEqual([]);
    }
  });
});

// ─── Lock-in ───────────────────────────────────────────────────────────────────────────────────

describe('the lock-in rule', () => {
  const text = 'There shall be a lock-in period of nine months.';
  const clauses = [clause('c1', text)];
  const evidence = { lockInMonths: at('c1', text) };

  it('rates a lock-in covering most of the term at the highest exposure', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { lockInMonths: 9, termMonths: 11 }, jurisdiction: 'IN-STATE' },
      'lock-in-period',
    );
    expect(finding?.detail).toBe(
      'The agreement locks the tenant in for 9 of its 11 months, which is 82 per cent of the term.',
    );
    expect(finding?.severityInputs.financialExposure).toBe(3);
    expect(finding?.citations).toEqual(['IN-CONTRACT-74']);
  });

  it('rates a short lock-in lower, because the exposure is a computed share of the term', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { lockInMonths: 3, termMonths: 11 }, jurisdiction: 'IN-STATE' },
      'lock-in-period',
    );
    expect(finding?.detail).toMatch(/27 per cent of the term/);
    expect(finding?.severityInputs.financialExposure).toBe(2);
  });

  it('states the lock-in alone when the term is not known, rather than guessing a share', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { lockInMonths: 6 }, jurisdiction: 'IN-STATE' },
      'lock-in-period',
    );
    expect(finding?.detail).toBe('The agreement locks the tenant in for 6 months.');
    expect(finding?.severityInputs.financialExposure).toBe(2);
  });

  it('attaches no citation outside India, where the pattern has no ruling', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { lockInMonths: 6 }, jurisdiction: 'US-CA' },
      'lock-in-period',
    );
    expect(finding?.citations).toEqual([]);
    expect(finding?.severityInputs.statutoryStatus).toBe('unknown');
  });

  it('makes no finding when its evidence points nowhere', () => {
    expect(
      fired(
        {
          clauses,
          evidence: { lockInMonths: at('missing', text) },
          facts: { lockInMonths: 9 },
          jurisdiction: 'IN-STATE',
        },
        'lock-in-period',
      ),
    ).toEqual([]);
  });

  it('carries a disagreement about the figure into the finding', () => {
    const [finding] = fired(
      {
        clauses,
        evidence,
        facts: { lockInMonths: 9 },
        jurisdiction: 'IN-STATE',
        conflicts: [
          {
            key: 'lockInMonths',
            used: 9,
            usedClauseId: 'c1',
            alsoStated: [3],
            otherClauseIds: ['c2'],
            note: 'This document states more than one figure for the lock-in period: 9, 3.',
          },
        ],
      },
      'lock-in-period',
    );
    expect(finding?.detail).toMatch(
      /locks the tenant in for 9 months\. This document states more than one figure/,
    );
  });
});

// ─── Notice asymmetry ──────────────────────────────────────────────────────────────────────────

describe('the notice asymmetry rule', () => {
  const text =
    'The tenant shall give ninety days notice. The landlord shall give thirty days notice.';
  const clauses = [clause('c1', text)];
  const evidence = { noticeDaysTenant: at('c1', 'The tenant shall give ninety days notice.') };

  it('reports the ratio between the two periods', () => {
    const [finding] = fired(
      {
        clauses,
        evidence,
        facts: { noticeDaysTenant: 90, noticeDaysLandlord: 30 },
        jurisdiction: 'unknown',
      },
      'notice-asymmetry',
    );
    expect(finding?.detail).toBe(
      'The tenant must give 90 days notice. The landlord must give 30. That is 3 times as much warning one way as the other.',
    );
    // No statute is needed to read an imbalance off the document itself.
    expect(finding?.citations).toEqual([]);
  });

  it('ignores a gap of under a week as rounding, not a finding', () => {
    expect(
      fired(
        {
          clauses,
          evidence,
          facts: { noticeDaysTenant: 35, noticeDaysLandlord: 30 },
          jurisdiction: 'unknown',
        },
        'notice-asymmetry',
      ),
    ).toEqual([]);
  });

  it('never reports an asymmetry that favours the tenant', () => {
    expect(
      fired(
        {
          clauses,
          evidence,
          facts: { noticeDaysTenant: 30, noticeDaysLandlord: 90 },
          jurisdiction: 'unknown',
        },
        'notice-asymmetry',
      ),
    ).toEqual([]);
  });

  it('needs the tenant-side evidence to quote, and a clause to anchor it', () => {
    const facts = { noticeDaysTenant: 90, noticeDaysLandlord: 30 };
    expect(
      fired({ clauses, evidence: {}, facts, jurisdiction: 'unknown' }, 'notice-asymmetry'),
    ).toEqual([]);
    expect(
      fired(
        { clauses, evidence: { noticeDaysTenant: at('c7', text) }, facts, jurisdiction: 'unknown' },
        'notice-asymmetry',
      ),
    ).toEqual([]);
  });
});

// ─── Entry ─────────────────────────────────────────────────────────────────────────────────────

describe('the entry notice rule', () => {
  const text = 'The landlord may enter on giving twenty-four hours notice.';
  const clauses = [clause('c1', text)];
  const evidence = { entryNoticeHours: at('c1', text) };

  it('reports a notice shorter than the local standard, naming both figures', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { entryNoticeHours: 24 }, jurisdiction: 'US-URLTA' },
      'entry-without-notice',
    );
    expect(finding?.detail).toBe(
      'The clause requires 24 hours notice. The standard that applies here is 48 hours.',
    );
    expect(finding?.citations).toEqual(['US-URLTA-3-103-C']);
  });

  it('accepts a notice that meets the local standard exactly', () => {
    expect(
      fired(
        { clauses, evidence, facts: { entryNoticeHours: 48 }, jurisdiction: 'US-URLTA' },
        'entry-without-notice',
      ),
    ).toEqual([]);
  });

  it('with no local standard, reports only entry with no notice at all', () => {
    expect(
      fired(
        { clauses, evidence, facts: { entryNoticeHours: 24 }, jurisdiction: 'unknown' },
        'entry-without-notice',
      ),
    ).toEqual([]);
    const [finding] = fired(
      { clauses, evidence, facts: { entryNoticeHours: 0 }, jurisdiction: 'unknown' },
      'entry-without-notice',
    );
    expect(finding?.detail).toBe(
      'The clause lets the landlord enter with no advance notice at all.',
    );
  });

  it('makes no finding when its evidence points nowhere', () => {
    expect(
      fired(
        {
          clauses,
          evidence: { entryNoticeHours: at('gone', text) },
          facts: { entryNoticeHours: 0 },
          jurisdiction: 'US-URLTA',
        },
        'entry-without-notice',
      ),
    ).toEqual([]);
  });
});

// ─── Late fees ─────────────────────────────────────────────────────────────────────────────────

describe('the late fee rule', () => {
  const text = 'A late charge of 10% of the monthly rent is payable after the fifth day.';
  const clauses = [clause('c1', text)];
  const evidence = { lateFeePercent: at('c1', text) };

  it('reports a charge above the referenced ceiling, with both State citations', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { lateFeePercent: 10 }, jurisdiction: 'US-URLTA' },
      'late-fee-excessive',
    );
    expect(finding?.detail).toBe(
      'The late charge is 10 per cent. The ceiling referenced here is 5 per cent.',
    );
    expect(finding?.citations).toEqual(['US-MD-8-208-D-3', 'US-NV-118A-210']);
  });

  it('accepts a charge at the ceiling', () => {
    expect(
      fired(
        { clauses, evidence, facts: { lateFeePercent: 5 }, jurisdiction: 'US-URLTA' },
        'late-fee-excessive',
      ),
    ).toEqual([]);
  });

  it('makes no claim where no ceiling is referenced', () => {
    expect(
      fired(
        { clauses, evidence, facts: { lateFeePercent: 24 }, jurisdiction: 'IN-STATE' },
        'late-fee-excessive',
      ),
    ).toEqual([]);
  });

  it('makes no finding without evidence, or with evidence that points nowhere', () => {
    const facts = { lateFeePercent: 10 };
    expect(
      fired({ clauses, evidence: {}, facts, jurisdiction: 'US-URLTA' }, 'late-fee-excessive'),
    ).toEqual([]);
    expect(
      fired(
        { clauses, evidence: { lateFeePercent: at('c2', text) }, facts, jurisdiction: 'US-URLTA' },
        'late-fee-excessive',
      ),
    ).toEqual([]);
  });
});

// ─── Escalation ────────────────────────────────────────────────────────────────────────────────

describe('the rent escalation rule', () => {
  const text = 'The licence fee shall be increased by 15 per cent on each renewal.';
  const clauses = [clause('c1', text)];
  const evidence = { renewalIncreasePercent: at('c1', text) };

  it('reports a steep increase with its three-year compounding computed, not estimated', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { renewalIncreasePercent: 15 }, jurisdiction: 'IN-STATE' },
      'rent-escalation-steep',
    );
    // 1.15^3 = 1.520875, so 52 per cent above the starting rent.
    expect(finding?.detail).toBe(
      'The agreement states an increase of 15 per cent. Over a three-year stay that compounds to about 52 per cent above the starting rent.',
    );
    expect(finding?.severityInputs.statutoryStatus).toBe('unknown');
    expect(finding?.citations).toEqual(['IN-CPA-2-46']);
  });

  it('starts reporting at exactly ten per cent, and not below', () => {
    const at10 = fired(
      { clauses, evidence, facts: { renewalIncreasePercent: 10 }, jurisdiction: 'IN-STATE' },
      'rent-escalation-steep',
    );
    expect(at10[0]?.detail).toMatch(/compounds to about 33 per cent/);
    expect(
      fired(
        { clauses, evidence, facts: { renewalIncreasePercent: 9.5 }, jurisdiction: 'IN-STATE' },
        'rent-escalation-steep',
      ),
    ).toEqual([]);
  });

  it('makes no finding without evidence, or with evidence that points nowhere', () => {
    const facts = { renewalIncreasePercent: 20 };
    expect(
      fired({ clauses, evidence: {}, facts, jurisdiction: 'IN-STATE' }, 'rent-escalation-steep'),
    ).toEqual([]);
    expect(
      fired(
        {
          clauses,
          evidence: { renewalIncreasePercent: at('c3', text) },
          facts,
          jurisdiction: 'IN-STATE',
        },
        'rent-escalation-steep',
      ),
    ).toEqual([]);
  });
});

// ─── Registration ──────────────────────────────────────────────────────────────────────────────

describe('the registration rule', () => {
  const text = 'The lease is granted for a term of three years.';
  const clauses = [clause('c1', text), clause('c2', 'The rent is payable monthly in advance.')];
  const evidence = { termMonths: at('c1', text) };

  it('reports a term over twelve months with no mention of registration', () => {
    const [finding] = fired(
      { clauses, evidence, facts: { termMonths: 36 }, jurisdiction: 'IN-STATE' },
      'unregistered-tenancy-over-one-year',
    );
    expect(finding?.detail).toBe(
      'The term is 36 months, above the 12-month point at which registration becomes compulsory, and the document does not mention registration.',
    );
    expect(finding?.citations).toEqual(['IN-REG-17-1-D', 'IN-REG-49']);
  });

  it('stays silent on the eleven- and twelve-month agreements the threshold exists for', () => {
    for (const months of [11, 12]) {
      expect(
        fired(
          { clauses, evidence, facts: { termMonths: months }, jurisdiction: 'IN-STATE' },
          'unregistered-tenancy-over-one-year',
        ),
        `${months} months`,
      ).toEqual([]);
    }
  });

  it('treats the document saying it is registered, in any clause, as the answer', () => {
    for (const wording of [
      'This deed shall be registered with the Sub-Registrar.',
      'The parties shall bear the cost of registration equally.',
    ]) {
      expect(
        fired(
          {
            clauses: [...clauses, clause('c3', wording)],
            evidence,
            facts: { termMonths: 36 },
            jurisdiction: 'IN-STATE',
          },
          'unregistered-tenancy-over-one-year',
        ),
        wording,
      ).toEqual([]);
    }
  });

  it('applies only where a registration threshold exists', () => {
    expect(
      fired(
        { clauses, evidence, facts: { termMonths: 36 }, jurisdiction: 'US-URLTA' },
        'unregistered-tenancy-over-one-year',
      ),
    ).toEqual([]);
  });

  it('makes no finding when its evidence points nowhere', () => {
    expect(
      fired(
        {
          clauses,
          evidence: { termMonths: at('c8', text) },
          facts: { termMonths: 36 },
          jurisdiction: 'IN-STATE',
        },
        'unregistered-tenancy-over-one-year',
      ),
    ).toEqual([]);
  });
});

// ─── Readability ───────────────────────────────────────────────────────────────────────────────

describe('the readability rule', () => {
  const OBSCURE =
    'Notwithstanding anything hereinbefore contained. The licensee hereby irrevocably and ' +
    'unconditionally indemnifies the licensor against all consequential, incidental and ' +
    'extraordinary liabilities, notwithstanding any contemporaneous representation, ' +
    'understanding or communication whatsoever, whether contractual, quasi-contractual, ' +
    'tortious or otherwise, arising directly or indirectly from any occupation, ' +
    'utilisation or modification of the aforementioned residential accommodation ' +
    'by the licensee or authorised representatives.';

  it('quotes the longest sentence of a clause written above grade 18', () => {
    const [finding] = applyNumericRules(
      input({ clauses: [clause('c1', OBSCURE)], facts: {}, evidence: {}, jurisdiction: 'GB-ENG' }),
    ).filter((c) => c.patternId === 'unintelligible-drafting');

    expect(finding).toBeDefined();
    expect(finding?.quote.startsWith('The licensee hereby irrevocably')).toBe(true);
    expect(OBSCURE).toContain(finding?.quote ?? '');
    expect(finding?.detail).toMatch(
      /^This clause reads at about grade \d+(?:\.\d+)?, with its longest sentence running to \d+ words\.$/,
    );
    expect(finding?.citations).toEqual(['GB-CRA-2015-68', 'EU-UCTD-5']);
  });

  it('leaves plain drafting of the same length alone', () => {
    const plain = Array.from(
      { length: 6 },
      () => 'The tenant pays the rent on the first day of each month.',
    ).join(' ');
    expect(
      applyNumericRules(
        input({ clauses: [clause('c1', plain)], facts: {}, evidence: {}, jurisdiction: 'GB-ENG' }),
      ),
    ).toEqual([]);
  });

  it('does not score a fragment too short to judge', () => {
    expect(
      applyNumericRules(
        input({
          clauses: [clause('c1', 'Notwithstanding indemnification.')],
          facts: {},
          evidence: {},
          jurisdiction: 'GB-ENG',
        }),
      ),
    ).toEqual([]);
  });
});

// ─── Engine-level helpers ──────────────────────────────────────────────────────────────────────

describe('rulingFor', () => {
  it('attaches no citation where the pattern has no ruling for the jurisdiction', () => {
    expect(
      rulingFor(riskPattern('deposit-excessive'), resolveJurisdiction('', 'IN-STATE')),
    ).toEqual({
      status: 'unknown',
      citations: [],
    });
    expect(rulingFor(riskPattern('deposit-excessive'), resolveJurisdiction('', 'US-CA'))).toEqual({
      status: 'restricted',
      citations: ['US-CA-1950-5-C'],
    });
  });
});

describe('matchesCues on a numerically decided pattern', () => {
  it('never fires from text, however the clause is worded', () => {
    expect(
      matchesCues('The deposit is ten times the legal limit.', riskPattern('deposit-excessive')),
    ).toBeNull();
  });
});

describe('escalationRate', () => {
  const clauses = ['a', 'b', 'c', 'd'].map((id) => clause(id, `Clause ${id}.`));
  const candidateOn = (clauseId: string, patternId = 'notice-asymmetry'): Candidate => ({
    patternId,
    clauseId,
    quote: '',
    detail: '',
    severityInputs: {
      statutoryStatus: 'unknown',
      financialExposure: 0,
      asymmetric: false,
      reversible: true,
    },
    citations: [],
  });

  it('is zero for a document with no clauses, rather than a division by zero', () => {
    expect(escalationRate([], [])).toBe(0);
  });

  it('is the share of clauses the rule layer did not cover', () => {
    expect(escalationRate(clauses, [])).toBe(1);
    expect(escalationRate(clauses, [candidateOn('a')])).toBe(0.75);
  });

  it('counts a clause once however many findings it carries', () => {
    expect(
      escalationRate(clauses, [
        candidateOn('a'),
        candidateOn('a', 'lock-in-period'),
        candidateOn('b'),
      ]),
    ).toBe(0.5);
  });

  it('lists the patterns no candidate fired', () => {
    expect(unreachablePatterns([])).toHaveLength(ALL_RISK_PATTERNS.length);
    const remaining = unreachablePatterns([candidateOn('a')]);
    expect(remaining).not.toContain('notice-asymmetry');
    expect(remaining).toHaveLength(ALL_RISK_PATTERNS.length - 1);
  });
});

// ─── End to end, from real drafting ────────────────────────────────────────────────────────────

describe('numeric findings read from a lease', () => {
  function findingsFor(text: string, declared?: JurisdictionId) {
    const segmented = segment(ingestPastedText(text));
    const typings = detectAllClauseTypes(segmented.clauses);
    const extracted = extractFacts(segmented.clauses, typings);
    const jurisdiction = resolveJurisdiction(segmented.document.text, declared);
    return applyRules({ clauses: segmented.clauses, typings, extracted, jurisdiction });
  }

  const INDIAN_THREE_YEAR = `LEASE DEED

1. TERM. The lease is granted for a period of three years commencing 1 April 2026.

2. RENT. The lessee shall pay rent of Rs. 40,000 per month.

3. ESCALATION. The rent shall be increased by 15 per cent on each renewal.

4. LOCK-IN PERIOD. There shall be a lock-in period of twelve months.
`;

  it('reports an unregistered three-year term, a steep escalation and a lock-in together', () => {
    const ids = findingsFor(INDIAN_THREE_YEAR, 'IN-STATE').map((c) => c.patternId);
    expect(ids).toContain('unregistered-tenancy-over-one-year');
    expect(ids).toContain('rent-escalation-steep');
    expect(ids).toContain('lock-in-period');
  });

  it('computes the lock-in share of the term from the two figures the lease states', () => {
    const lockIn = findingsFor(INDIAN_THREE_YEAR, 'IN-STATE').find(
      (c) => c.patternId === 'lock-in-period',
    );
    expect(lockIn?.detail).toMatch(/12 of its 36 months, which is 33 per cent of the term/);
  });

  it('reports each pattern at most once per clause', () => {
    const keys = findingsFor(INDIAN_THREE_YEAR, 'IN-STATE').map(
      (c) => `${c.patternId}:${c.clauseId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
