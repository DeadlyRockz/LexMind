import { describe, expect, it } from 'vitest';
import {
  addUsage,
  assertWithinPromptBudget,
  cacheHitRate,
  EMPTY_METER,
  estimateCostUsd,
  estimateTokens,
  PDF_TOKENS_PER_PAGE,
  readBudgetConfig,
  recordUsage,
} from './budget.ts';
import type { Usage } from './port.ts';

/**
 * The usage meter, which is a reporting surface as much as an accounting one.
 *
 * Rule 9 of this project is that nothing is claimed that the scorecard cannot evidence, and the
 * meter is where that rule is easiest to break by accident: counting an attempt as a call costs
 * nothing at runtime and quietly turns "2 model calls" into a number no request ever backed.
 */

const USAGE: Usage = {
  promptTokens: 1000,
  outputTokens: 200,
  thoughtTokens: 50,
  cachedTokens: 250,
  totalTokens: 1250,
};

describe('recordUsage counts calls, not attempts', () => {
  it('counts a completed call and its tokens', () => {
    const meter = recordUsage(EMPTY_METER, 'explain-clauses', USAGE);
    expect(meter.calls).toBe(1);
    expect(meter.total.totalTokens).toBe(1250);
    expect(meter.byTask.get('explain-clauses')?.promptTokens).toBe(1000);
  });

  it('counts nothing for a call that failed — no call, no tokens, no task entry', () => {
    const meter = recordUsage(EMPTY_METER, 'summarise-lease', USAGE, 'failed');
    expect(meter.calls).toBe(0);
    expect(meter.total.totalTokens).toBe(0);
    expect(meter.byTask.size).toBe(0);
  });

  it('counts nothing for a pass that never ran', () => {
    const meter = recordUsage(EMPTY_METER, 'summarise-lease', USAGE, 'skipped');
    expect(meter).toBe(EMPTY_METER);
  });

  it('leaves the meter it was given untouched', () => {
    const first = recordUsage(EMPTY_METER, 'extract', USAGE);
    recordUsage(first, 'extract', USAGE);
    expect(first.calls).toBe(1);
    expect(EMPTY_METER.calls).toBe(0);
    expect(EMPTY_METER.byTask.size).toBe(0);
  });

  it('accumulates across tasks', () => {
    let meter = recordUsage(EMPTY_METER, 'explain-clauses', USAGE);
    meter = recordUsage(meter, 'summarise-lease', USAGE, 'failed');
    meter = recordUsage(meter, 'summarise-lease', USAGE);
    expect(meter.calls).toBe(2);
    expect(meter.byTask.size).toBe(2);
    expect(meter.total.totalTokens).toBe(2500);
  });
});

describe('the rest of the budget arithmetic', () => {
  it('adds two usages field by field', () => {
    expect(addUsage(USAGE, USAGE).cachedTokens).toBe(500);
  });

  it('reports the cache hit rate as a measured share, and zero when nothing was sent', () => {
    expect(cacheHitRate(USAGE)).toBe(0.25);
    expect(cacheHitRate({ ...USAGE, promptTokens: 0 })).toBe(0);
  });

  it('estimates tokens with a floor, and zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });

  it('refuses a prompt over the ceiling with a message that says what still worked', () => {
    expect(() =>
      assertWithinPromptBudget('x'.repeat(4001), { maxPromptTokens: 1000, maxOutputTokens: 100 }),
    ).toThrow(/over the 1,000 ceiling/);
    expect(
      assertWithinPromptBudget('x'.repeat(40), { maxPromptTokens: 1000, maxOutputTokens: 100 }),
    ).toBe(10);
  });

  it('reads its ceilings from the environment, falling back on anything unusable', () => {
    expect(readBudgetConfig({}).maxPromptTokens).toBe(120_000);
    expect(readBudgetConfig({ LEXMIND_MAX_PROMPT_TOKENS: '5000' }).maxPromptTokens).toBe(5000);
    expect(readBudgetConfig({ LEXMIND_MAX_PROMPT_TOKENS: 'lots' }).maxPromptTokens).toBe(120_000);
    expect(readBudgetConfig({ LEXMIND_MAX_OUTPUT_TOKENS: '-4' }).maxOutputTokens).toBe(4096);
  });

  it('prices a run as an estimate, and states the PDF token rate it avoids paying', () => {
    expect(estimateCostUsd(USAGE)).toBeGreaterThan(0);
    expect(estimateCostUsd({ ...USAGE, promptTokens: 0, outputTokens: 0, thoughtTokens: 0 })).toBe(
      0,
    );
    expect(PDF_TOKENS_PER_PAGE).toBe(258);
  });
});
