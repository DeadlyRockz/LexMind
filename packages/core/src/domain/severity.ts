import type { Severity, SeverityInputs, StatutoryStatus } from './types.ts';
import { SEVERITY_ORDER } from './types.ts';

/**
 * Severity is *computed*, never chosen by a model, so the same clause always scores the same.
 *
 * The four inputs, and why each one is here:
 *
 *  - `statutoryStatus` — a clause a statute voids outranks one that is merely unusual.
 *  - `financialExposure` — what it could cost, in months of rent.
 *  - `asymmetric` — does the other party hold the mirror right? This needs no statute at all,
 *    which is what keeps the `unknown` jurisdiction path useful.
 *  - `reversible` — losing a deposit is recoverable; losing the home is not.
 */

const STATUS_WEIGHT: Readonly<Record<StatutoryStatus, number>> = {
  void: 4,
  unenforceable: 3,
  restricted: 2,
  /** "We do not know" scores above "this is fine", and must never be rendered as permitted. */
  unknown: 1,
  permitted: 0,
};

export const MAX_SEVERITY_SCORE = 10;

export function severityScore(inputs: SeverityInputs): number {
  return (
    STATUS_WEIGHT[inputs.statutoryStatus] +
    inputs.financialExposure +
    (inputs.asymmetric ? 1 : 0) +
    (inputs.reversible ? 0 : 2)
  );
}

export function computeSeverity(inputs: SeverityInputs): Severity {
  const score = severityScore(inputs);
  if (score >= 8) return 'critical';
  if (score >= 6) return 'high';
  if (score >= 4) return 'medium';
  if (score >= 2) return 'low';
  return 'info';
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Most severe first. Stable, so two runs order identical findings identically. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}

export function isAtLeast(severity: Severity, floor: Severity): boolean {
  return severityRank(severity) <= severityRank(floor);
}

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'For information',
};

/**
 * A non-colour visual cue per severity. LexMind renders in two colours only, so severity is
 * carried by a text label, a glyph, and fill density — never by hue. That satisfies WCAG SC 1.4.1
 * by construction rather than by review.
 */
export const SEVERITY_GLYPHS: Readonly<Record<Severity, string>> = {
  critical: '▰▰▰',
  high: '▰▰▱',
  medium: '▰▱▱',
  low: '▱▱▱',
  info: '▫',
};
