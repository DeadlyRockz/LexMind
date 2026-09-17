/**
 * The vocabulary of the whole system. Everything downstream — highlights, citations, comparison
 * anchors — is expressed in terms of character offsets into one canonical normalized string, so
 * these types exist mainly to make that invariant hard to break by accident.
 */

/** A jurisdiction we can say something specific about. `unknown` is a first-class outcome. */
export type JurisdictionId =
  | 'IN-MTA' // an Indian State that has enacted the Model Tenancy Act 2021
  | 'IN-STATE' // India, State Rent Act / Transfer of Property Act territory
  | 'US-URLTA' // a US State following the Uniform Residential Landlord and Tenant Act
  | 'US-CA'
  | 'US-NY'
  | 'GB-ENG' // England, post Renters' Rights Act 2025
  | 'unknown';

/**
 * How a jurisdiction treats a clause. Drives severity, and `unknown` must never be rendered as
 * `permitted`: "we do not know" and "this is fine" are different statements.
 */
export type StatutoryStatus = 'void' | 'unenforceable' | 'restricted' | 'permitted' | 'unknown';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;

export type Party = 'landlord' | 'tenant' | 'both' | 'unknown';

/**
 * A legal citation. `verified` records whether a human checked this provision against a primary
 * source, and unverified rows are rendered with a visible caveat rather than presented as fact.
 */
export interface Citation {
  readonly id: string;
  /** e.g. "Model Tenancy Act 2021", "URLTA", "Cal. Civ. Code" */
  readonly authority: string;
  /** e.g. "s.11(1)", "§1.403(a)(2)" */
  readonly provision: string;
  /** What the provision actually says, in one sentence. Never a paraphrase of our conclusion. */
  readonly summary: string;
  readonly jurisdiction: JurisdictionId;
  readonly url?: string;
  readonly verified: boolean;
  readonly source: string;
  /** ISO date. Tenancy law moves; a rule with no date is a rule you cannot trust. */
  readonly retrievedOn: string;
}

/** One of the six groups the UI orders clauses by. */
export type ClauseGroup = 'formation' | 'term' | 'money' | 'condition' | 'use' | 'risk';

export interface ClauseType {
  readonly id: string;
  readonly label: string;
  readonly group: ClauseGroup;
  /** Detection leans on these far more than on the canonical label. */
  readonly synonyms: readonly string[];
  /** The ten a tenant is most exposed to. Depth here beats breadth across all 38. */
  readonly priority: boolean;
  /** Which model instrument this type is drawn from, so the taxonomy is defensible. */
  readonly derivedFrom: readonly string[];
}

/** A clause with exact offsets. `document.text.slice(charStart, charEnd) === text` always holds. */
export interface Clause {
  readonly id: string;
  /** Hierarchical numbering path, e.g. ['8', '3'] for "Section 8.3". */
  readonly path: readonly string[];
  /** Inherited heading trail, e.g. ['ARTICLE 8 — SECURITY DEPOSIT', 'Section 8.3 — Deductions']. */
  readonly headingTrail: readonly string[];
  readonly heading: string | null;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly level: number;
}

/** A quote that code has confirmed exists in the source document. */
export interface VerifiedQuote {
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly clauseId: string;
  /** 'exact' survived a byte comparison; 'normalized' matched after whitespace/case folding. */
  readonly matchKind: 'exact' | 'normalized';
}

/** What the model claims, before verification. Never rendered in this form. */
export interface ClaimedQuote {
  readonly quote: string;
  readonly clauseId?: string;
  readonly charStart?: number;
  readonly charEnd?: number;
}

export interface SeverityInputs {
  readonly statutoryStatus: StatutoryStatus;
  /** 0 = none, 1 = a few days' rent, 2 = about a month, 3 = several months or more. */
  readonly financialExposure: 0 | 1 | 2 | 3;
  /** Does the other party hold the mirror right? Jurisdiction-free, so it always works. */
  readonly asymmetric: boolean;
  /** Can the tenant undo the consequence, or is it terminal (eviction, forfeiture)? */
  readonly reversible: boolean;
}

export type FindingOrigin = 'rule' | 'model';

export interface Finding {
  readonly id: string;
  readonly patternId: string | null;
  readonly clauseTypeId: string;
  readonly clauseId: string;
  /** A statement of what the document does, never a recommendation. */
  readonly title: string;
  readonly whatItSays: string;
  readonly whyItMatters: string;
  readonly severity: Severity;
  readonly severityInputs: SeverityInputs;
  readonly citations: readonly Citation[];
  readonly anchors: readonly VerifiedQuote[];
  readonly origin: FindingOrigin;
  readonly jurisdiction: JurisdictionId;
  /** Present when the finding rests on a rule we could not verify to a primary source. */
  readonly caveat?: string;
}

export interface Obligation {
  readonly id: string;
  readonly party: Party;
  readonly what: string;
  readonly when: string | null;
  readonly consequence: string | null;
  readonly clauseId: string;
  readonly anchors: readonly VerifiedQuote[];
}

/** Numbers pulled out of the lease, normalized. The model extracts; TypeScript compares. */
export interface LeaseFacts {
  readonly currency: string | null;
  readonly rentAmount: number | null;
  readonly rentPeriod: 'month' | 'week' | 'year' | null;
  readonly depositAmount: number | null;
  readonly depositMonths: number | null;
  readonly termMonths: number | null;
  readonly lockInMonths: number | null;
  readonly noticeDaysTenant: number | null;
  readonly noticeDaysLandlord: number | null;
  readonly entryNoticeHours: number | null;
  readonly lateFeePercent: number | null;
  readonly lateFeeAmount: number | null;
  readonly renewalIncreasePercent: number | null;
}

export const EMPTY_FACTS: LeaseFacts = {
  currency: null,
  rentAmount: null,
  rentPeriod: null,
  depositAmount: null,
  depositMonths: null,
  termMonths: null,
  lockInMonths: null,
  noticeDaysTenant: null,
  noticeDaysLandlord: null,
  entryNoticeHours: null,
  lateFeePercent: null,
  lateFeeAmount: null,
  renewalIncreasePercent: null,
};
