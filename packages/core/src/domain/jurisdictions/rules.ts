import type { CitationId } from '../citations.ts';
import type { JurisdictionId } from '../types.ts';

/** A numeric limit with the provision that sets it. A limit without a citation cannot ship. */
export interface CitedLimit {
  readonly value: number;
  readonly citation: CitationId;
  readonly note?: string;
}

export interface Resource {
  readonly label: string;
  readonly url: string;
  readonly kind: 'legal-aid' | 'ombudsman' | 'tribunal' | 'guidance' | 'consumer';
}

export interface JurisdictionRules {
  readonly id: JurisdictionId;
  readonly label: string;
  /**
   * What LexMind can and cannot say here, in the words shown to the user. This is the honesty
   * surface: a jurisdiction whose rules rest on a model act says so here, in full.
   */
  readonly coverage: string;
  /**
   * True where the rules come from a *model* act rather than enacted law in the reader location.
   * Findings resolved against a model-act jurisdiction always carry a caveat.
   */
  readonly modelActOnly: boolean;
  readonly depositCapMonths: CitedLimit | null;
  /** England expresses the cap in weeks of rent, not months. */
  readonly depositCapWeeks: CitedLimit | null;
  readonly minEntryNoticeHours: CitedLimit | null;
  readonly lateFeeMaxPercentOfRent: CitedLimit | null;
  /** Above this term length, written registration is compulsory. */
  readonly registrationRequiredOverMonths: CitedLimit | null;
  readonly resources: readonly Resource[];
}

const IN_RESOURCES: readonly Resource[] = [
  {
    label: 'National Legal Services Authority (NALSA) — free legal aid',
    url: 'https://nalsa.gov.in/',
    kind: 'legal-aid',
  },
  {
    label: 'State and District Legal Services Authorities — directory',
    url: 'https://nalsa.gov.in/state-legal-services-authorities',
    kind: 'legal-aid',
  },
  {
    label: 'National Consumer Helpline',
    url: 'https://consumerhelpline.gov.in/',
    kind: 'consumer',
  },
];

const US_RESOURCES: readonly Resource[] = [
  {
    label: 'Legal Services Corporation — find legal aid',
    url: 'https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help',
    kind: 'legal-aid',
  },
  {
    label: 'LawHelp.org — free legal help by State',
    url: 'https://www.lawhelp.org/',
    kind: 'legal-aid',
  },
  {
    label: 'HUD — tenant rights by State',
    url: 'https://www.hud.gov/topics/rental_assistance/tenantrights',
    kind: 'guidance',
  },
];

const GB_RESOURCES: readonly Resource[] = [
  {
    label: 'Shelter England — housing advice',
    url: 'https://england.shelter.org.uk/housing_advice',
    kind: 'guidance',
  },
  {
    label: 'Citizens Advice — renting',
    url: 'https://www.citizensadvice.org.uk/housing/',
    kind: 'guidance',
  },
  { label: 'Housing Ombudsman', url: 'https://www.housing-ombudsman.org.uk/', kind: 'ombudsman' },
  {
    label: 'First-tier Tribunal (Property Chamber)',
    url: 'https://www.gov.uk/courts-tribunals/first-tier-tribunal-property-chamber',
    kind: 'tribunal',
  },
];

export const JURISDICTIONS: Readonly<Record<JurisdictionId, JurisdictionRules>> = {
  /**
   * Reachable only when the reader states that their State has enacted the Model Tenancy Act.
   * It is never inferred: the Act is a *model*, adopted by only a few States and Union
   * Territories, so telling a Delhi or Bengaluru tenant "your deposit is capped at two months"
   * would state something false.
   */
  'IN-MTA': {
    id: 'IN-MTA',
    label: 'India — a State that has enacted the Model Tenancy Act 2021',
    coverage:
      'You told LexMind that your State has enacted the Model Tenancy Act 2021, so its limits are applied below. LexMind cannot itself confirm adoption — check with your State housing department, because the Act is a model and most States have not enacted it.',
    modelActOnly: true,
    depositCapMonths: {
      value: 2,
      citation: 'IN-MTA-11-1',
      note: 'Residential premises. Six months for non-residential.',
    },
    depositCapWeeks: null,
    minEntryNoticeHours: {
      value: 24,
      citation: 'IN-MTA-17',
      note: 'In writing, and not before sunrise or after sunset.',
    },
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: { value: 12, citation: 'IN-REG-17-1-D' },
    resources: IN_RESOURCES,
  },

  /** The honest Indian default. */
  'IN-STATE': {
    id: 'IN-STATE',
    label: 'India — State Rent Act and Transfer of Property Act',
    coverage:
      'Tenancy is a State subject in India. Unless your State has enacted the Model Tenancy Act 2021, your tenancy is governed by your State Rent Act, the Transfer of Property Act, and your contract — so LexMind does not apply the Model Tenancy Act deposit or notice limits here. It still reports what your document says and where it is one-sided.',
    modelActOnly: false,
    depositCapMonths: null,
    depositCapWeeks: null,
    minEntryNoticeHours: null,
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: { value: 12, citation: 'IN-REG-17-1-D' },
    resources: IN_RESOURCES,
  },

  'US-URLTA': {
    id: 'US-URLTA',
    label: 'United States — URLTA (a uniform model act)',
    coverage:
      'URLTA is a uniform model act, adopted in whole or in part by about half of US States and not at all by the others. LexMind references it as general information about what such statutes commonly prohibit. It is not a statement of the law in your State unless your State enacted it.',
    modelActOnly: true,
    depositCapMonths: { value: 1, citation: 'US-URLTA-2-101-A' },
    depositCapWeeks: null,
    minEntryNoticeHours: {
      value: 48,
      citation: 'US-URLTA-3-103-C',
      note: 'At least two days, except in an emergency.',
    },
    lateFeeMaxPercentOfRent: {
      value: 5,
      citation: 'US-MD-8-208-D-3',
      note: 'Maryland and Nevada both cap at 5 per cent; most States set no numeric cap.',
    },
    registrationRequiredOverMonths: null,
    resources: US_RESOURCES,
  },

  'US-CA': {
    id: 'US-CA',
    label: 'United States — California',
    coverage:
      'California statutes are applied below. Local rent-control and just-cause ordinances may add protections that LexMind does not model.',
    modelActOnly: false,
    depositCapMonths: {
      value: 1,
      citation: 'US-CA-1950-5-C',
      note: 'Since 1 July 2024. A narrow small-landlord exception allows two months.',
    },
    depositCapWeeks: null,
    minEntryNoticeHours: {
      value: 24,
      citation: 'US-URLTA-3-103-C',
      note: 'California requires reasonable written notice, presumptively 24 hours; the cited provision is the URLTA analogue rather than the California section.',
    },
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: null,
    resources: US_RESOURCES,
  },

  'US-NY': {
    id: 'US-NY',
    label: 'United States — New York',
    coverage:
      'New York statutes are applied below. Rent-stabilised and rent-controlled units carry further rules that LexMind does not model.',
    modelActOnly: false,
    depositCapMonths: { value: 1, citation: 'US-NY-GOL-7-108' },
    depositCapWeeks: null,
    minEntryNoticeHours: null,
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: null,
    resources: US_RESOURCES,
  },

  'GB-ENG': {
    id: 'GB-ENG',
    label: "England — post Renters' Rights Act 2025",
    coverage:
      'Assured shorthold tenancies were converted to assured periodic tenancies on 1 May 2026 and Section 21 was abolished. Rules current as of the retrieval date on each citation. Wales, Scotland and Northern Ireland have separate regimes that LexMind does not model.',
    modelActOnly: false,
    depositCapMonths: null,
    depositCapWeeks: {
      value: 5,
      citation: 'GB-TFA-2019',
      note: 'Five weeks rent where annual rent is under £50,000; six weeks at or above it.',
    },
    minEntryNoticeHours: {
      value: 24,
      citation: 'GB-CRA-2015-68',
      note: 'England sets the entry standard by the tenancy agreement and quiet enjoyment rather than a single numeric statute; 24 hours is the conventional figure, not a statutory cap.',
    },
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: null,
    resources: GB_RESOURCES,
  },

  /** Not an error state. The asymmetry engine needs no statute at all. */
  unknown: {
    id: 'unknown',
    label: 'Jurisdiction not determined',
    coverage:
      'LexMind could not tell which country or State governs this tenancy, so it makes no statement about what the law requires. It still explains what your document says, and flags clauses that give one party a right the other does not have — that reading needs no statute.',
    modelActOnly: false,
    depositCapMonths: null,
    depositCapWeeks: null,
    minEntryNoticeHours: null,
    lateFeeMaxPercentOfRent: null,
    registrationRequiredOverMonths: null,
    resources: [],
  },
};

export function jurisdictionRules(id: JurisdictionId): JurisdictionRules {
  return JURISDICTIONS[id];
}
