import { ModelError } from './errors.ts';
import type { Usage } from './port.ts';

/**
 * Token ceilings and usage accounting.
 *
 * Every limit here is a cost control and a security control at the same time: OWASP LLM06 names
 * the failure mode "Unbounded Consumption", and the sharper phrase in that document is "Denial of
 * Wallet". An unbounded output cap on a schema-constrained call is free money for an attacker.
 *
 * The largest saving is architectural rather than a limit, and it is worth stating plainly:
 * **LexMind never sends the PDF.** Gemini bills PDF input at a flat 258 tokens per page whatever
 * the text density, so a 40-page lease costs about 10,300 tokens as a PDF, while the same lease
 * as extracted text is typically a fraction of that — and the PDF path cannot return the
 * character offsets every citation depends on. Our own parser is both cheaper and more capable.
 */

export const PDF_TOKENS_PER_PAGE = 258;

export interface BudgetConfig {
  readonly maxPromptTokens: number;
  readonly maxOutputTokens: number;
}

export function readBudgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  return {
    maxPromptTokens: readInt(env['LEXMIND_MAX_PROMPT_TOKENS'], 120_000),
    maxOutputTokens: readInt(env['LEXMIND_MAX_OUTPUT_TOKENS'], 4096),
  };
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A local token estimate, used to refuse a request *before* it is sent.
 *
 * Roughly four characters per token for English prose, with a floor. It is an estimate and is
 * labelled as one: the provider's own counter is authoritative, but calling it costs a round trip,
 * and the point of this function is to avoid the round trip when the answer is obviously "no".
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function assertWithinPromptBudget(prompt: string, config: BudgetConfig): number {
  const estimated = estimateTokens(prompt);
  if (estimated > config.maxPromptTokens) {
    throw new ModelError(
      'BUDGET_EXCEEDED',
      `The prompt is about ${estimated.toLocaleString('en')} tokens, over the ${config.maxPromptTokens.toLocaleString('en')} ceiling.`,
      {
        retryable: false,
        userMessage:
          'This document is too long to analyse with AI in one pass. LexMind has still applied its full rule-based analysis. Upload the tenancy agreement without its appendices for the AI explanations.',
      },
    );
  }
  return estimated;
}

/** Running usage across a whole analysis, for the CLI output and `reports/perf.md`. */
export interface UsageMeter {
  readonly total: Usage;
  readonly byTask: ReadonlyMap<string, Usage>;
  readonly calls: number;
}

export const EMPTY_METER: UsageMeter = {
  total: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, totalTokens: 0 },
  byTask: new Map(),
  calls: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thoughtTokens: a.thoughtTokens + b.thoughtTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function recordUsage(meter: UsageMeter, task: string, usage: Usage): UsageMeter {
  const byTask = new Map(meter.byTask);
  byTask.set(task, addUsage(byTask.get(task) ?? EMPTY_METER.total, usage));
  return { total: addUsage(meter.total, usage), byTask, calls: meter.calls + 1 };
}

/** The share of prompt tokens served from the provider's cache. Measured, never assumed. */
export function cacheHitRate(usage: Usage): number {
  if (usage.promptTokens === 0) return 0;
  return Math.round((usage.cachedTokens / usage.promptTokens) * 1000) / 1000;
}

/**
 * Published free-tier pricing for the flash tier, in US dollars per million tokens, used only to
 * print an estimate. Flagged as an estimate everywhere it is shown, because provider pricing
 * changes and a stale number presented as fact is the kind of claim this project avoids making.
 */
export const ESTIMATED_PRICE_PER_MILLION = { input: 0.3, output: 2.5 } as const;

export function estimateCostUsd(usage: Usage): number {
  const input = (usage.promptTokens / 1_000_000) * ESTIMATED_PRICE_PER_MILLION.input;
  const output =
    ((usage.outputTokens + usage.thoughtTokens) / 1_000_000) * ESTIMATED_PRICE_PER_MILLION.output;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}
