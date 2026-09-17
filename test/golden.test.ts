import { describe, expect, it } from 'vitest';
import { analyse } from '../packages/core/src/analyse/index.ts';
import { ingestPastedText } from '../packages/core/src/ingest/index.ts';
import { segment } from '../packages/core/src/segment/index.ts';
import {
  type ClauseTypingEvaluation,
  evaluateClauseTyping,
  formatMisses,
} from './eval/clause-typing.ts';
import { formatTypingTable } from './eval/scoring.ts';
import {
  CLEAN_FAIR_LEASE,
  GOLDEN_LEASES,
  INDIAN_ELEVEN_MONTH_LEASE,
  NO_JURISDICTION_LEASE,
} from './fixtures/leases.ts';

/**
 * The golden set, run against the deterministic engine with **no model at all**.
 *
 * That is the point: every assertion here holds on a fresh clone with no API key and no network.
 * Anything the model adds is additive.
 */

async function run(text: string, declared?: 'IN-MTA') {
  const document = ingestPastedText(text);
  const segmented = segment(document);
  const result = await analyse(segmented, {
    ...(declared === undefined ? {} : { declaredJurisdiction: declared }),
  });
  return { segmented, result };
}

describe('the golden set', () => {
  for (const lease of GOLDEN_LEASES) {
    describe(lease.title, () => {
      it('resolves the expected jurisdiction', async () => {
        const { result } = await run(lease.text);
        expect(result.jurisdiction.id).toBe(lease.expectedJurisdiction);
      });

      it('finds every seeded defect', async () => {
        const { result } = await run(lease.text);
        const fired = new Set(result.findings.map((f) => f.patternId));
        const missing = lease.expectedPatterns.filter((id) => !fired.has(id));
        expect(missing, `missed in "${lease.id}": ${missing.join(', ')}`).toEqual([]);
      });

      it('fires no forbidden pattern — a false positive is as much a failure as a miss', async () => {
        const { result } = await run(lease.text);
        const fired = new Set(result.findings.map((f) => f.patternId));
        const wrong = lease.forbiddenPatterns.filter((id) => fired.has(id));
        expect(wrong, `false positives in "${lease.id}": ${wrong.join(', ')}`).toEqual([]);
      });

      it('anchors every finding to a quote that is really in the document', async () => {
        const { segmented, result } = await run(lease.text);
        for (const finding of result.findings) {
          expect(finding.anchors.length, `${finding.patternId} has no anchor`).toBeGreaterThan(0);
          for (const anchor of finding.anchors) {
            expect(
              segmented.document.text.slice(anchor.charStart, anchor.charEnd),
              `${finding.patternId} anchor does not slice out its own quote`,
            ).toBe(anchor.quote);
          }
        }
      });

      it('never makes a statutory claim without a citation', async () => {
        const { result } = await run(lease.text);
        for (const finding of result.findings) {
          if (finding.severityInputs.statutoryStatus === 'unknown') continue;
          expect(
            finding.citations.length,
            `${finding.patternId} claims status "${finding.severityInputs.statutoryStatus}" with no citation`,
          ).toBeGreaterThan(0);
        }
      });

      it('produces identical output on two consecutive runs', async () => {
        const first = await run(lease.text);
        const second = await run(lease.text);
        expect(JSON.stringify(second.result.findings)).toBe(JSON.stringify(first.result.findings));
      });
    });
  }
});

describe('clause typing: precision and recall per type on the golden set', () => {
  // Floors, not targets. The labels in `fixtures/leases.ts` were written from the clause text and
  // the taxonomy's definitions, never from detector output, so a drop below these is a detector
  // regression to fix — not a label to loosen.
  const MIN_MICRO_PRECISION = 0.9;
  const MIN_MICRO_RECALL = 0.9;

  // Evaluated on first use rather than at collection, so a drifted label fails these tests with its
  // own message instead of taking every other golden test in this file down with it.
  let cached: { evaluation: ClauseTypingEvaluation; report: string } | undefined;
  const evaluate = () => {
    if (cached === undefined) {
      const evaluation = evaluateClauseTyping(GOLDEN_LEASES);
      const misses = formatMisses(evaluation.misses) || '(none)';
      const report = `${formatTypingTable(evaluation.score)}\n\nMisses and false positives:\n${misses}`;
      cached = { evaluation, report };
    }
    return cached;
  };

  it('labels every clause the segmenter produces, in every golden lease', () => {
    const { evaluation } = evaluate();
    const labelled = GOLDEN_LEASES.reduce((total, lease) => total + lease.clauseTypes.length, 0);
    expect(evaluation.score.clauses).toBe(labelled);
    expect(evaluation.score.clauses).toBeGreaterThan(50);
  });

  it(`reaches micro precision >= ${MIN_MICRO_PRECISION}`, () => {
    const { evaluation, report } = evaluate();
    // Printed so the per-type table is visible in CI logs; Phase 11 renders the same table into
    // reports/scorecard.md.
    console.info(`Clause typing on the golden set (deterministic, no model):\n${report}`);
    expect(evaluation.score.micro.precision ?? 0, report).toBeGreaterThanOrEqual(
      MIN_MICRO_PRECISION,
    );
  });

  it(`reaches micro recall >= ${MIN_MICRO_RECALL}`, () => {
    const { evaluation, report } = evaluate();
    expect(evaluation.score.micro.recall ?? 0, report).toBeGreaterThanOrEqual(MIN_MICRO_RECALL);
  });

  it('finds at least one instance of every type the golden set labels', () => {
    const { evaluation, report } = evaluate();
    const neverFound = evaluation.score.perType
      .filter((type) => type.labelled > 0 && type.tp === 0)
      .map((type) => type.typeId);
    expect(neverFound, report).toEqual([]);
  });

  it('is deterministic: two runs score identically', () => {
    expect(evaluateClauseTyping(GOLDEN_LEASES)).toEqual(evaluate().evaluation);
  });
});

describe('calibration: the clean fair lease', () => {
  it('produces no critical and no high-severity finding', async () => {
    // The most valuable fixture in the set. A tool that flags everything teaches nothing, so this
    // is the assertion that proves LexMind is calibrated rather than merely sensitive.
    const { result } = await run(CLEAN_FAIR_LEASE);
    const loud = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    expect(
      loud.map((f) => `${f.patternId} (${f.severity})`),
      'a balanced tenancy must not be shouted at',
    ).toEqual([]);
  });

  it('still reads the document correctly', async () => {
    const { result } = await run(CLEAN_FAIR_LEASE);
    expect(result.facts.depositMonths).toBe(1);
    expect(result.facts.noticeDaysTenant).toBe(30);
    expect(result.facts.noticeDaysLandlord).toBe(30);
    expect(result.facts.entryNoticeHours).toBe(24);
    expect(result.clauses.length).toBeGreaterThan(8);
  });
});

describe('the Model Tenancy Act is a model, not law', () => {
  it('asserts no deposit cap for an Indian lease with no declared adoption', async () => {
    // The deposit here is three months. Telling a Delhi or Bengaluru tenant that exceeds "the
    // legal cap" would state something false, so this exact non-claim is pinned.
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.facts.depositMonths).toBe(3);
    expect(result.findings.map((f) => f.patternId)).not.toContain('deposit-excessive');
    expect(result.jurisdiction.rules.depositCapMonths).toBeNull();
  });

  it('applies the cap once the reader declares their State enacted it', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE, 'IN-MTA');
    const finding = result.findings.find((f) => f.patternId === 'deposit-excessive');
    expect(finding).toBeDefined();
    expect(finding?.whatItSays).toMatch(/3 months of rent/);
    expect(finding?.whatItSays).toMatch(/limit that applies here is 2 months/);
    expect(finding?.citations.map((c) => c.provision)).toContain('s.11(1)');
  });

  it('caveats the declared model-act jurisdiction rather than presenting it as settled', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE, 'IN-MTA');
    const finding = result.findings.find((f) => f.patternId === 'deposit-excessive');
    expect(finding?.caveat).toMatch(/cannot verify/i);
  });
});

describe('the unknown-jurisdiction path', () => {
  it('reports asymmetry with no statute anywhere in sight', async () => {
    const { result } = await run(NO_JURISDICTION_LEASE);
    expect(result.jurisdiction.id).toBe('unknown');

    const asymmetry = result.findings.find((f) => f.patternId === 'notice-asymmetry');
    expect(asymmetry).toBeDefined();
    expect(asymmetry?.whatItSays).toMatch(/tenant must give 30 days/);
    expect(asymmetry?.whatItSays).toMatch(/landlord must give 2/);
  });

  it('makes no statutory claim at all on that path', async () => {
    const { result } = await run(NO_JURISDICTION_LEASE);
    for (const finding of result.findings) {
      expect(
        finding.severityInputs.statutoryStatus,
        `${finding.patternId} claimed a statutory status with no jurisdiction`,
      ).toBe('unknown');
      expect(finding.citations, `${finding.patternId} cited law with no jurisdiction`).toEqual([]);
    }
  });

  it('still rates an asymmetric, irreversible term as worth attention', async () => {
    const { result } = await run(NO_JURISDICTION_LEASE);
    const asymmetry = result.findings.find((f) => f.patternId === 'notice-asymmetry');
    expect(['critical', 'high', 'medium']).toContain(asymmetry?.severity);
  });
});

describe('the four URLTA §1.403(a) prohibited provisions', () => {
  it('detects each one with the right provision cited', async () => {
    const lease = GOLDEN_LEASES.find((l) => l.id === 'us-prohibited');
    expect(lease).toBeDefined();
    const { result } = await run(lease?.text ?? '');

    const expected = {
      'waiver-of-legal-rights': '§1.403(a)(1)',
      'confession-of-judgment': '§1.403(a)(2)',
      'landlord-attorney-fees': '§1.403(a)(3)',
      'exculpation-indemnity': '§1.403(a)(4)',
    } as const;

    for (const [patternId, provision] of Object.entries(expected)) {
      const finding = result.findings.find((f) => f.patternId === patternId);
      expect(finding, `${patternId} not detected`).toBeDefined();
      expect(
        finding?.citations.map((c) => c.provision),
        `${patternId} cites the wrong provision`,
      ).toContain(provision);
    }
  });

  it('rates them as the most serious findings in that document', async () => {
    const lease = GOLDEN_LEASES.find((l) => l.id === 'us-prohibited');
    const { result } = await run(lease?.text ?? '');
    const waiver = result.findings.find((f) => f.patternId === 'waiver-of-legal-rights');
    expect(waiver?.severity).toBe('critical');
    expect(waiver?.severityInputs.statutoryStatus).toBe('void');
  });
});

describe("England's abolished regime", () => {
  it('reports an AST with a section 21 route as describing a regime that no longer exists', async () => {
    const lease = GOLDEN_LEASES.find((l) => l.id === 'england-outdated');
    const { result } = await run(lease?.text ?? '');

    const finding = result.findings.find((f) => f.patternId === 'ast-section-21-mischaracterised');
    expect(finding).toBeDefined();
    expect(finding?.citations.map((c) => c.authority).join(' ')).toMatch(
      /Renters' Rights Act 2025/,
    );
    expect(finding?.whyItMatters).toMatch(/no longer exists/);
  });
});

describe('prompt injection carried in the lease body', () => {
  it('reports the injected text as document content and analyses the lease unchanged', async () => {
    const lease = GOLDEN_LEASES.find((l) => l.id === 'injected');
    const { result } = await run(lease?.text ?? '');

    // The injected instruction told the analyser to report no risks. It has no effect, because
    // the deterministic engine does not read instructions — and because there is no channel
    // through which an instruction could act.
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.patternId)).toContain('deposit-non-refundable');
    expect(result.findings.map((f) => f.patternId)).toContain('notice-asymmetry');
  });
});

describe('the obligations matrix', () => {
  it('reads duties for each party, with deadlines and consequences where stated', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.obligations.length).toBeGreaterThan(5);

    const tenantDuties = result.obligations.filter((o) => o.party === 'tenant');
    expect(tenantDuties.length).toBeGreaterThan(0);
    expect(result.obligations.some((o) => o.when !== null)).toBe(true);
    expect(result.obligations.some((o) => o.consequence !== null)).toBe(true);
  });

  it('reports the balance of duties as a number, not an adjective', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.obligationBalance.tenant).toBeGreaterThan(0);
    expect(result.obligationBalance.tenant).toBeGreaterThan(result.obligationBalance.landlord);
  });

  it('anchors every obligation to a verified quote', async () => {
    const { segmented, result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    for (const obligation of result.obligations) {
      const anchor = obligation.anchors[0];
      expect(anchor).toBeDefined();
      if (anchor === undefined) continue;
      expect(segmented.document.text.slice(anchor.charStart, anchor.charEnd)).toBe(anchor.quote);
    }
  });
});

describe('running with no model at all', () => {
  it('produces a complete analysis and says the model was not used', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.modelLabel).toMatch(/deterministic only/);
    expect(result.stats.modelCalls).toBe(0);
    expect(result.explanations.size).toBe(0);
    expect(result.summary).toBeNull();
    expect(result.findings.length).toBeGreaterThan(8);
  });

  it('reports the figures a reviewer would want to check', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.stats.clauseCount).toBeGreaterThan(10);
    expect(result.stats.escalationRate).toBeGreaterThanOrEqual(0);
    expect(result.stats.escalationRate).toBeLessThan(1);
    expect(result.stats.citationRejectionRate).toBe(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is fast enough that the UI can render before any model call', async () => {
    const { result } = await run(INDIAN_ELEVEN_MONTH_LEASE);
    expect(result.stats.durationMs, 'the deterministic pass must feel instant').toBeLessThan(400);
  });
});
