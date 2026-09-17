import type { JurisdictionId } from '../types.ts';
import { JURISDICTIONS, type JurisdictionRules } from './rules.ts';

export type { CitedLimit, JurisdictionRules, Resource } from './rules.ts';
export { isJurisdictionId, JURISDICTIONS, jurisdictionRules } from './rules.ts';

export type Confidence = 'declared' | 'high' | 'medium' | 'none';

export interface JurisdictionResolution {
  readonly id: JurisdictionId;
  readonly confidence: Confidence;
  /** The exact phrases found in the document, so the UI can show why. */
  readonly evidence: readonly string[];
  readonly rules: JurisdictionRules;
  /** Populated when signals pointed at more than one country, which forces `unknown`. */
  readonly conflicts: readonly JurisdictionId[];
}

type Country = 'IN' | 'GB' | 'US';

const COUNTRY_MARKERS: Readonly<Record<Country, readonly string[]>> = {
  IN: [
    '₹',
    'rs.',
    'rupees',
    'lakh',
    'crore',
    'sub-registrar',
    'leave and licence',
    'leave and license',
    'transfer of property act',
    'indian contract act',
    'stamp paper',
    'registration act, 1908',
    'registration act 1908',
  ],
  GB: [
    '£',
    'assured shorthold tenancy',
    'assured tenancy',
    'landlord and tenant act 1985',
    'tenant fees act',
    'deposit protection scheme',
    'tenancy deposit scheme',
    'england and wales',
    'section 21',
    'housing act 1988',
  ],
  US: [
    'u.s.c',
    'landlord-tenant act',
    'landlord and tenant act of',
    'security deposit shall be held in',
    'county of',
    'state of ',
    'zip code',
    'apartment unit',
  ],
};

const US_STATE_MARKERS: readonly {
  readonly id: JurisdictionId;
  readonly markers: readonly string[];
}[] = [
  {
    id: 'US-CA',
    markers: ['california', 'civil code', 'los angeles', 'san francisco', 'san diego'],
  },
  {
    id: 'US-NY',
    markers: ['new york', 'general obligations law', 'brooklyn', 'manhattan', 'queens'],
  },
];

/** Country resolution needs this much evidence before it claims anything. */
const MIN_MARKERS = 2;

function countMarkers(haystack: string, markers: readonly string[]): string[] {
  return markers.filter((m) => haystack.includes(m));
}

function resolution(
  id: JurisdictionId,
  confidence: Confidence,
  evidence: readonly string[],
  conflicts: readonly JurisdictionId[] = [],
): JurisdictionResolution {
  return { id, confidence, evidence, rules: JURISDICTIONS[id], conflicts };
}

/**
 * Resolve jurisdiction before any substantive statement is made.
 *
 * Two deliberate properties:
 *
 *  - `unknown` is returned whenever the signals are absent or conflicting. It is a first-class
 *    outcome: the asymmetry findings still work with no statute at all.
 *  - `IN-MTA` is **never inferred**. The Model Tenancy Act 2021 is a model that only a few States
 *    have enacted, so it is reachable only when the reader declares it. Inferring it would mean
 *    telling most Indian tenants a deposit cap applies to them when it does not.
 */
export function resolveJurisdiction(
  text: string,
  declared?: JurisdictionId,
): JurisdictionResolution {
  if (declared !== undefined) {
    return resolution(declared, 'declared', [`declared by the reader as ${declared}`]);
  }

  const haystack = text.toLowerCase();
  const hits: { country: Country; evidence: string[] }[] = (['IN', 'GB', 'US'] as const)
    .map((country) => ({ country, evidence: countMarkers(haystack, COUNTRY_MARKERS[country]) }))
    .filter((h) => h.evidence.length >= MIN_MARKERS)
    .sort((a, b) => b.evidence.length - a.evidence.length);

  const best = hits[0];
  if (best === undefined) return resolution('unknown', 'none', []);

  const runnerUp = hits[1];
  // A tie, or near-tie, between countries is a conflict. Guessing here is how a tool ends up
  // quoting an English deposit cap at an Indian tenant.
  if (runnerUp !== undefined && best.evidence.length - runnerUp.evidence.length < MIN_MARKERS) {
    return resolution(
      'unknown',
      'none',
      [...best.evidence, ...runnerUp.evidence],
      [countryDefault(best.country), countryDefault(runnerUp.country)],
    );
  }

  const confidence: Confidence = best.evidence.length >= 3 ? 'high' : 'medium';

  if (best.country === 'US') {
    for (const state of US_STATE_MARKERS) {
      const stateHits = countMarkers(haystack, state.markers);
      if (stateHits.length >= MIN_MARKERS) {
        return resolution(state.id, confidence, [...best.evidence, ...stateHits]);
      }
    }
  }

  return resolution(countryDefault(best.country), confidence, best.evidence);
}

function countryDefault(country: Country): JurisdictionId {
  switch (country) {
    case 'IN':
      return 'IN-STATE';
    case 'GB':
      return 'GB-ENG';
    case 'US':
      return 'US-URLTA';
  }
}

/**
 * The sentence attached to any finding whose rule comes from a model act rather than enacted law
 * where the reader lives. Rendered as a visible caveat, never dropped.
 */
export function coverageCaveat(res: JurisdictionResolution): string | null {
  if (res.id === 'unknown') return null;
  if (!res.rules.modelActOnly) return null;
  return res.confidence === 'declared'
    ? 'Based on the jurisdiction you selected. LexMind cannot verify that this statute is in force where your property is.'
    : `${res.rules.label} is a model act. This is general information about what such statutes commonly prohibit, not a statement of the law where your property is.`;
}
