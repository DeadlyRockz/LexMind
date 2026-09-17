import { describe, expect, it } from 'vitest';
import { ANSWERABLE_OVERRIDES, CROSSING_RULES } from './advice-boundary.ts';
import { ALL_CITATIONS, CITATIONS } from './citations.ts';
import { CLAUSE_TYPES, clauseType, PRIORITY_CLAUSE_TYPES } from './clause-types.ts';
import { coverageCaveat, resolveJurisdiction } from './jurisdictions/index.ts';
import { ALL_RISK_PATTERNS, CUE_PATTERNS, NUMERIC_PATTERNS } from './risk-taxonomy.ts';
import { computeSeverity, isAtLeast, severityScore } from './severity.ts';

describe('clause taxonomy', () => {
  it('encodes 38 canonical clause types', () => {
    expect(CLAUSE_TYPES).toHaveLength(38);
  });

  it('has no duplicate ids', () => {
    const ids = CLAUSE_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every type synonyms, because detection reads synonyms not labels', () => {
    for (const t of CLAUSE_TYPES) {
      expect(t.synonyms.length, `${t.id} has no synonyms`).toBeGreaterThan(0);
      expect(t.derivedFrom.length, `${t.id} cites no model instrument`).toBeGreaterThan(0);
    }
  });

  it('marks a priority set covering the clauses a tenant is most exposed to', () => {
    const ids = PRIORITY_CLAUSE_TYPES.map((t) => t.id);
    for (const required of [
      'security-deposit',
      'lock-in',
      'notice-periods',
      'inspection-entry',
      'tenant-repairs',
      'termination-landlord',
      'late-fee',
      'waiver-of-rights',
      'dispute-resolution',
      'renewal',
    ]) {
      expect(ids, `${required} must be in the priority set`).toContain(required);
    }
  });

  it('throws on an unknown clause type rather than returning a silent default', () => {
    // @ts-expect-error deliberately outside the union
    expect(() => clauseType('not-a-type')).toThrow(/Unknown clause type/);
  });
});

describe('risk taxonomy', () => {
  it('encodes 31 tenant-adverse patterns', () => {
    expect(ALL_RISK_PATTERNS).toHaveLength(31);
  });

  it('never ships a pattern with no citation — the core architectural rule', () => {
    for (const p of ALL_RISK_PATTERNS) {
      const cited = p.rulings.flatMap((r) => r.citations);
      expect(cited.length, `pattern ${p.id} has no citation`).toBeGreaterThan(0);
      for (const id of cited) {
        expect(CITATIONS[id], `pattern ${p.id} cites unknown ${id}`).toBeDefined();
      }
    }
  });

  it('gives every cue-driven pattern something to match on', () => {
    for (const p of CUE_PATTERNS) {
      expect(p.cues.length, `cue pattern ${p.id} has no cues`).toBeGreaterThan(0);
      for (const group of p.cues) expect(group.length).toBeGreaterThan(0);
    }
  });

  it('leaves every numeric judgement to TypeScript rather than to a model', () => {
    expect(NUMERIC_PATTERNS.length).toBeGreaterThan(0);
    // A pattern may be a hybrid — `entry-without-notice` fires either on the phrase "at any time"
    // or on an hours figure below the statutory minimum. What must never happen is a pattern with
    // neither a cue nor a computation, because that is a pattern nothing can ever detect.
    for (const p of ALL_RISK_PATTERNS) {
      const detectable = p.cues.length > 0 || p.numeric !== undefined;
      expect(detectable, `pattern ${p.id} is undetectable`).toBe(true);
    }
    for (const p of CUE_PATTERNS) {
      expect(p.numeric, `${p.id} is in CUE_PATTERNS so must have no numeric kind`).toBeUndefined();
    }
  });

  it('states what a clause does, never what the reader should do', () => {
    const advice =
      /\byou should\b|\bwe recommend\b|\bdemand that\b|\brefuse to\b|\byou must (?:not )?sign\b/i;
    for (const p of ALL_RISK_PATTERNS) {
      expect(p.title, `${p.id} title gives advice`).not.toMatch(advice);
      expect(p.whyItMatters, `${p.id} rationale gives advice`).not.toMatch(advice);
    }
  });

  it('covers all four URLTA §1.403(a) prohibited clause types', () => {
    const expected = {
      'waiver-of-legal-rights': 'US-URLTA-1-403-A-1',
      'confession-of-judgment': 'US-URLTA-1-403-A-2',
      'landlord-attorney-fees': 'US-URLTA-1-403-A-3',
      'exculpation-indemnity': 'US-URLTA-1-403-A-4',
    } as const;
    for (const [patternId, citationId] of Object.entries(expected)) {
      const pattern = ALL_RISK_PATTERNS.find((p) => p.id === patternId);
      expect(pattern, `${patternId} missing`).toBeDefined();
      const cited = pattern?.rulings.flatMap((r) => r.citations) ?? [];
      expect(cited).toContain(citationId);
    }
  });

  it('does NOT cite 16 C.F.R. §444.2 for confession of judgment', () => {
    // The FTC Credit Practices Rule reaches consumer credit, not residential leases. Citing it
    // here would be exactly the confidently-wrong legal claim this product exists to avoid.
    const all = JSON.stringify(ALL_RISK_PATTERNS) + JSON.stringify(ALL_CITATIONS);
    expect(all).not.toMatch(/444\.2/);
    expect(all).not.toMatch(/Credit Practices Rule/i);
  });
});

describe('citations', () => {
  it('gives every citation a source and an ISO retrieval date', () => {
    for (const c of ALL_CITATIONS) {
      expect(c.source.length, `${c.id} has no source`).toBeGreaterThan(0);
      expect(c.summary.length, `${c.id} has no summary`).toBeGreaterThan(0);
      expect(c.retrievedOn, `${c.id} retrievedOn is not ISO`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keys every row by its own id', () => {
    for (const [key, value] of Object.entries(CITATIONS)) expect(value.id).toBe(key);
  });

  it("reflects that England's ASTs were replaced, not merely amended", () => {
    expect(CITATIONS['GB-RRA-2025'].summary).toMatch(/no longer exists|abolished/i);
  });
});

describe('jurisdiction resolution', () => {
  const indianLease =
    'This Leave and Licence agreement is made on stamp paper. The licensee shall pay Rs. 25,000 ' +
    'per month. A security deposit of ₹ 2,00,000 (Rupees Two Lakh only) shall be paid.';

  it('resolves an Indian lease to the State/TPA default, never to the Model Tenancy Act', () => {
    const res = resolveJurisdiction(indianLease);
    expect(res.id).toBe('IN-STATE');
    expect(res.rules.depositCapMonths).toBeNull();
  });

  it('does not assert the two-month cap for an Indian lease with no adoption marker', () => {
    // The MTA is a model, not law. Asserting its cap to a Delhi or Bengaluru tenant states
    // something false, so this exact non-claim is pinned by a test.
    const res = resolveJurisdiction(indianLease);
    expect(res.rules.coverage).toMatch(/unless your State has enacted/i);
    expect(res.rules.depositCapMonths).toBeNull();
  });

  it('reaches IN-MTA only when the reader declares it, and then caveats it', () => {
    const res = resolveJurisdiction(indianLease, 'IN-MTA');
    expect(res.id).toBe('IN-MTA');
    expect(res.confidence).toBe('declared');
    expect(res.rules.depositCapMonths?.value).toBe(2);
    expect(coverageCaveat(res)).toMatch(/cannot verify/i);
  });

  it('resolves an English tenancy and carries no model-act caveat', () => {
    const res = resolveJurisdiction(
      'This assured shorthold tenancy is governed by the Housing Act 1988. Rent of £1,200 per ' +
        'month. The deposit is held in a tenancy deposit scheme under the Tenant Fees Act.',
    );
    expect(res.id).toBe('GB-ENG');
    expect(res.rules.depositCapWeeks?.value).toBe(5);
    expect(coverageCaveat(res)).toBeNull();
  });

  it('resolves California by State markers', () => {
    const res = resolveJurisdiction(
      'State of California, County of Los Angeles. Security deposit held under Civil Code. ' +
        'Tenant occupies the apartment unit.',
    );
    expect(res.id).toBe('US-CA');
    expect(res.rules.depositCapMonths?.value).toBe(1);
  });

  it('flags a US lease resolved via the model act as general information only', () => {
    const res = resolveJurisdiction(
      'State of Texas, County of Travis. This landlord-tenant act governs the apartment unit. ' +
        'See 42 u.s.c for fair housing.',
    );
    expect(res.id).toBe('US-URLTA');
    expect(coverageCaveat(res)).toMatch(/model act/i);
  });

  it('returns unknown — not a guess — when country signals conflict', () => {
    const res = resolveJurisdiction(
      'Rent of £1,200 under the Housing Act 1988 and an assured shorthold tenancy, with a ' +
        'deposit of Rs. 50,000 on stamp paper before the sub-registrar in rupees.',
    );
    expect(res.id).toBe('unknown');
    expect(res.conflicts.length).toBeGreaterThan(1);
  });

  it('returns unknown for a lease with no jurisdiction markers at all', () => {
    const res = resolveJurisdiction('The tenant shall pay rent monthly and keep the flat clean.');
    expect(res.id).toBe('unknown');
    expect(res.confidence).toBe('none');
    expect(res.rules.coverage).toMatch(/still explains what your document says/i);
  });

  it('treats unknown as an outcome, not an error: no statutory limits are offered', () => {
    const res = resolveJurisdiction('no markers here');
    expect(res.rules.depositCapMonths).toBeNull();
    expect(res.rules.minEntryNoticeHours).toBeNull();
    expect(res.rules.resources).toHaveLength(0);
  });
});

describe('severity', () => {
  it('scores a statutorily void, expensive, irreversible, one-sided clause as critical', () => {
    expect(
      computeSeverity({
        statutoryStatus: 'void',
        financialExposure: 3,
        asymmetric: true,
        reversible: false,
      }),
    ).toBe('critical');
  });

  it('scores a permitted, costless, symmetric, reversible clause as information', () => {
    expect(
      computeSeverity({
        statutoryStatus: 'permitted',
        financialExposure: 0,
        asymmetric: false,
        reversible: true,
      }),
    ).toBe('info');
  });

  it('ranks unknown status above permitted, so abstention never reads as approval', () => {
    const base = { financialExposure: 1, asymmetric: false, reversible: true } as const;
    expect(severityScore({ ...base, statutoryStatus: 'unknown' })).toBeGreaterThan(
      severityScore({ ...base, statutoryStatus: 'permitted' }),
    );
  });

  it('rises monotonically with every input', () => {
    const base = {
      statutoryStatus: 'restricted',
      financialExposure: 1,
      asymmetric: false,
      reversible: true,
    } as const;
    expect(severityScore({ ...base, financialExposure: 3 })).toBeGreaterThan(severityScore(base));
    expect(severityScore({ ...base, asymmetric: true })).toBeGreaterThan(severityScore(base));
    expect(severityScore({ ...base, reversible: false })).toBeGreaterThan(severityScore(base));
  });

  it('finds asymmetry alone enough to matter with no statute at all', () => {
    const severity = computeSeverity({
      statutoryStatus: 'unknown',
      financialExposure: 2,
      asymmetric: true,
      reversible: false,
    });
    expect(isAtLeast(severity, 'medium')).toBe(true);
  });
});

describe('advice boundary data', () => {
  it('encodes the four behaviours that cross the line, each with cues and a reason', () => {
    expect(CROSSING_RULES).toHaveLength(4);
    const kinds = CROSSING_RULES.map((r) => r.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'apply-law-to-facts',
        'recommend-course-of-action',
        'draft-or-select-document',
        'predict-outcome',
      ]),
    );
    for (const rule of CROSSING_RULES) {
      expect(rule.cues.length).toBeGreaterThan(0);
      expect(rule.because.length).toBeGreaterThan(0);
    }
  });

  it("keeps the Judicial Council's 'should I' heuristic as a literal cue", () => {
    const recommend = CROSSING_RULES.find((r) => r.kind === 'recommend-course-of-action');
    expect(recommend?.cues).toContain('should i');
  });

  it("keeps 'how do i' and 'what does' answerable", () => {
    expect(ANSWERABLE_OVERRIDES).toContain('how do i');
    expect(ANSWERABLE_OVERRIDES).toContain('what does');
  });
});
