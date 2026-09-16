import type { Citation } from './types.ts';

/**
 * Every legal citation LexMind can render, in one place.
 *
 * The architectural rule this file exists to enforce: **a legal assertion is a row in this table
 * with a citation, never a sentence inside a prompt.** A model that "knows" deposit caps is a
 * model that will invent one; a row that says `{ provision: 's.11(1)', cap: 2 }` cannot.
 *
 * `verified: true` means the provision text was checked against the primary source named in
 * `source` on `retrievedOn`. `verified: false` rows still render, but with a visible caveat —
 * see `docs/LEGAL-SOURCES.md`.
 */

const RETRIEVED = '2026-09-16';

export const CITATIONS = {
  // ─── India ────────────────────────────────────────────────────────────────────────────────
  'IN-MTA-11-1': {
    id: 'IN-MTA-11-1',
    authority: 'Model Tenancy Act 2021 (India)',
    provision: 's.11(1)',
    summary:
      'Security deposit is capped at two months rent for residential premises (six months for non-residential).',
    jurisdiction: 'IN-MTA',
    url: 'https://mohua.gov.in/upload/uploadfiles/files/Model%20Tenancy%20Act%20English%20(1).pdf',
    verified: true,
    source: 'Ministry of Housing and Urban Affairs, published text of the Model Tenancy Act 2021',
    retrievedOn: RETRIEVED,
  },
  'IN-MTA-11-2': {
    id: 'IN-MTA-11-2',
    authority: 'Model Tenancy Act 2021 (India)',
    provision: 's.11(2)',
    summary: 'The security deposit is refundable to the tenant on vacating, subject to lawful deductions.',
    jurisdiction: 'IN-MTA',
    verified: true,
    source: 'Ministry of Housing and Urban Affairs, published text of the Model Tenancy Act 2021',
    retrievedOn: RETRIEVED,
  },
  'IN-MTA-15-1': {
    id: 'IN-MTA-15-1',
    authority: 'Model Tenancy Act 2021 (India)',
    provision: 's.15(1)',
    summary:
      'Structural repairs and specified maintenance remain the landlord duty "notwithstanding any agreement to the contrary", so a clause shifting them to the tenant does not displace the duty.',
    jurisdiction: 'IN-MTA',
    verified: true,
    source: 'Ministry of Housing and Urban Affairs, published text of the Model Tenancy Act 2021',
    retrievedOn: RETRIEVED,
  },
  'IN-MTA-17': {
    id: 'IN-MTA-17',
    authority: 'Model Tenancy Act 2021 (India)',
    provision: 's.17',
    summary:
      'Entry requires at least 24 hours written notice, and no entry before sunrise or after sunset.',
    jurisdiction: 'IN-MTA',
    verified: true,
    source: 'Ministry of Housing and Urban Affairs, published text of the Model Tenancy Act 2021',
    retrievedOn: RETRIEVED,
  },
  'IN-MTA-20': {
    id: 'IN-MTA-20',
    authority: 'Model Tenancy Act 2021 (India)',
    provision: 's.20',
    summary:
      'A tenant may not be evicted except in accordance with the Act, through the Rent Court, and not by the landlord acting alone.',
    jurisdiction: 'IN-MTA',
    verified: true,
    source: 'Ministry of Housing and Urban Affairs, published text of the Model Tenancy Act 2021',
    retrievedOn: RETRIEVED,
  },
  'IN-CONTRACT-74': {
    id: 'IN-CONTRACT-74',
    authority: 'Indian Contract Act 1872',
    provision: 's.74',
    summary:
      'Where a contract stipulates a sum to be paid on breach, the party is entitled to reasonable compensation not exceeding that sum — a penalty is not recoverable in full merely because it was agreed.',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'India Code, Indian Contract Act 1872',
    retrievedOn: RETRIEVED,
  },
  'IN-REG-17-1-D': {
    id: 'IN-REG-17-1-D',
    authority: 'Registration Act 1908 (India)',
    provision: 's.17(1)(d)',
    summary:
      'Registration is compulsory for leases of immovable property from year to year, for any term exceeding one year, or reserving a yearly rent.',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'India Code, Registration Act 1908',
    retrievedOn: RETRIEVED,
  },
  'IN-REG-49': {
    id: 'IN-REG-49',
    authority: 'Registration Act 1908 (India)',
    provision: 's.49',
    summary:
      'A document required to be registered but left unregistered cannot be received as evidence of the transaction it records.',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'India Code, Registration Act 1908',
    retrievedOn: RETRIEVED,
  },
  'IN-DELHI-RCA-3-C': {
    id: 'IN-DELHI-RCA-3-C',
    authority: 'Delhi Rent Control Act 1958',
    provision: 's.3(c)',
    summary:
      'The Act does not apply to premises whose monthly rent exceeds Rs 3,500, so most modern Delhi tenancies fall outside rent control entirely.',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'Delhi Rent Control Act 1958 as amended',
    retrievedOn: RETRIEVED,
  },
  'IN-MH-RENT-55': {
    id: 'IN-MH-RENT-55',
    authority: 'Maharashtra Rent Control Act 1999',
    provision: 's.55',
    summary:
      'A tenancy or leave-and-licence agreement must be in writing and registered, with no exemption for short durations — the common eleven-month workaround does not avoid it.',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'Maharashtra Rent Control Act 1999',
    retrievedOn: RETRIEVED,
  },
  'IN-CPA-2-46': {
    id: 'IN-CPA-2-46',
    authority: 'Consumer Protection Act 2019 (India)',
    provision: 's.2(46)',
    summary:
      'Defines an unfair contract: including a term permitting unilateral termination without reasonable cause (clause (iv)) and one imposing an unreasonable charge or obligation putting the consumer at a disadvantage (clause (vi)).',
    jurisdiction: 'IN-STATE',
    verified: true,
    source: 'India Code, Consumer Protection Act 2019',
    retrievedOn: RETRIEVED,
  },

  // ─── United States ────────────────────────────────────────────────────────────────────────
  'US-URLTA-1-403-A-1': {
    id: 'US-URLTA-1-403-A-1',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§1.403(a)(1)',
    summary:
      'A rental agreement may not provide that the tenant agrees to waive or forgo rights or remedies under the Act.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article I',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-1-403-A-2': {
    id: 'US-URLTA-1-403-A-2',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§1.403(a)(2)',
    summary: 'A rental agreement may not provide that the tenant authorizes a confession of judgment.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article I',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-1-403-A-3': {
    id: 'US-URLTA-1-403-A-3',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§1.403(a)(3)',
    summary:
      'A rental agreement may not provide that the tenant agrees to pay the landlord attorney fees.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article I',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-1-403-A-4': {
    id: 'US-URLTA-1-403-A-4',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§1.403(a)(4)',
    summary:
      'A rental agreement may not provide that the tenant agrees to the exculpation or limitation of the landlord liability, or to indemnify the landlord for that liability.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article I',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-1-403-B': {
    id: 'US-URLTA-1-403-B',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§1.403(b)',
    summary:
      'A prohibited provision is unenforceable, and a landlord who knowingly uses one may be liable for actual damages plus up to three months periodic rent and reasonable attorney fees.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article I',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-2-101-A': {
    id: 'US-URLTA-2-101-A',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§2.101(a)',
    summary: 'A landlord may not demand or receive a security deposit exceeding one month periodic rent.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article II',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-2-104': {
    id: 'US-URLTA-2-104',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§2.104(c)-(d)',
    summary:
      'The landlord duty to maintain fit premises may be shifted to the tenant only in narrow, separately agreed circumstances, and not for the purpose of evading the duty.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article II',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-3-103-C': {
    id: 'US-URLTA-3-103-C',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§3.103(c)',
    summary:
      'Except in an emergency, the landlord must give at least two days notice and enter only at reasonable times.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article III',
    retrievedOn: RETRIEVED,
  },
  'US-URLTA-4-207': {
    id: 'US-URLTA-4-207',
    authority: 'Uniform Residential Landlord and Tenant Act',
    provision: '§4.207',
    summary:
      'A landlord may not recover possession by self-help — by lockout, or by wilfully cutting off heat, water or electricity.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Uniform Law Commission, URLTA (1972) Article IV',
    retrievedOn: RETRIEVED,
  },
  'US-CA-1950-5-C': {
    id: 'US-CA-1950-5-C',
    authority: 'California Civil Code',
    provision: '§1950.5(c)',
    summary:
      'Since 1 July 2024 the security deposit is capped at one month rent for most residential tenancies, whether or not furnished, with a narrow small-landlord exception at two months.',
    jurisdiction: 'US-CA',
    verified: true,
    source: 'California Civil Code §1950.5 as amended by AB 12 (2023)',
    retrievedOn: RETRIEVED,
  },
  'US-CA-1953-A': {
    id: 'US-CA-1953-A',
    authority: 'California Civil Code',
    provision: '§1953(a)(1)-(5)',
    summary:
      'Any lease provision by which the tenant waives specified statutory rights — including the implied warranty of habitability, the right to notice, and the right to a jury trial — is void as contrary to public policy.',
    jurisdiction: 'US-CA',
    verified: true,
    source: 'California Civil Code §1953',
    retrievedOn: RETRIEVED,
  },
  'US-NY-GOL-7-108': {
    id: 'US-NY-GOL-7-108',
    authority: 'New York General Obligations Law',
    provision: '§7-108',
    summary:
      'A residential security deposit may not exceed one month rent, and must be returned within 14 days of the tenant vacating.',
    jurisdiction: 'US-NY',
    verified: true,
    source: 'New York General Obligations Law §7-108 (Housing Stability and Tenant Protection Act 2019)',
    retrievedOn: RETRIEVED,
  },
  'US-MD-8-208-D-3': {
    id: 'US-MD-8-208-D-3',
    authority: 'Maryland Real Property Code',
    provision: '§8-208(d)(3)',
    summary: 'A late fee may not exceed 5 per cent of the monthly rent.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Maryland Code, Real Property §8-208',
    retrievedOn: RETRIEVED,
  },
  'US-NV-118A-210': {
    id: 'US-NV-118A-210',
    authority: 'Nevada Revised Statutes',
    provision: '§118A.210',
    summary:
      'A late fee may not exceed 5 per cent of the periodic rent, and may not be charged until the rent has been unpaid for three days after it was due.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: 'Nevada Revised Statutes Chapter 118A',
    retrievedOn: RETRIEVED,
  },
  'US-FHA-3604': {
    id: 'US-FHA-3604',
    authority: 'Fair Housing Act, 42 U.S.C.',
    provision: '§3604',
    summary:
      'Discrimination in the terms of a rental is prohibited on seven statutory grounds: race, colour, religion, sex, national origin, familial status, and disability. Many State and local laws add further protected classes.',
    jurisdiction: 'US-URLTA',
    verified: true,
    source: '42 U.S.C. §3604',
    retrievedOn: RETRIEVED,
  },

  // ─── England ──────────────────────────────────────────────────────────────────────────────
  'GB-RRA-2025': {
    id: 'GB-RRA-2025',
    authority: "Renters' Rights Act 2025 (c.26)",
    provision: 'Part 1',
    summary:
      'Assured shorthold tenancies were converted to assured periodic tenancies on 1 May 2026 and Section 21 "no fault" eviction was abolished. A tenancy described as an AST with a Section 21 route is describing a regime that no longer exists.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: "Renters' Rights Act 2025, legislation.gov.uk",
    retrievedOn: RETRIEVED,
  },
  'GB-TFA-2019': {
    id: 'GB-TFA-2019',
    authority: 'Tenant Fees Act 2019',
    provision: 'ss.1-3, Sch.1',
    summary:
      'Only payments listed in Schedule 1 may be required of a tenant; anything else is a prohibited payment. The tenancy deposit is capped at five weeks rent where annual rent is under £50,000, and six weeks at or above it.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Tenant Fees Act 2019, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-TFA-2019-LATE': {
    id: 'GB-TFA-2019-LATE',
    authority: 'Tenant Fees Act 2019',
    provision: 'Sch.1 para 4',
    summary:
      'Default interest on late rent is permitted only up to 3 per cent above the Bank of England base rate, and only once the rent has been outstanding for 14 days.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Tenant Fees Act 2019, Schedule 1, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-LTA-1985-11': {
    id: 'GB-LTA-1985-11',
    authority: 'Landlord and Tenant Act 1985',
    provision: 's.11',
    summary:
      'The landlord must keep in repair the structure and exterior and the installations for water, gas, electricity, sanitation, space heating and water heating.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Landlord and Tenant Act 1985, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-LTA-1985-12': {
    id: 'GB-LTA-1985-12',
    authority: 'Landlord and Tenant Act 1985',
    provision: 's.12',
    summary:
      'A covenant purporting to relieve the landlord of the s.11 repairing obligation, or to impose it on the tenant, is void unless authorised by a court.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Landlord and Tenant Act 1985, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-PEA-1977-2': {
    id: 'GB-PEA-1977-2',
    authority: 'Protection from Eviction Act 1977',
    provision: 's.2',
    summary:
      'Where premises are let as a dwelling, forfeiture may not be enforced other than by court proceedings while anyone is lawfully residing there.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Protection from Eviction Act 1977, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-CRA-2015-68': {
    id: 'GB-CRA-2015-68',
    authority: 'Consumer Rights Act 2015',
    provision: 's.68',
    summary:
      'A written term of a consumer contract must be transparent: expressed in plain and intelligible language and, if written, legible.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Consumer Rights Act 2015, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-CRA-2015-SCH2-20': {
    id: 'GB-CRA-2015-SCH2-20',
    authority: 'Consumer Rights Act 2015',
    provision: 'Sch.2 para 20(a)',
    summary:
      'A term excluding or hindering the consumer right to take legal action, in particular by requiring disputes to go exclusively to arbitration not covered by legal provisions, is on the indicative list of unfair terms.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Consumer Rights Act 2015, Schedule 2, legislation.gov.uk',
    retrievedOn: RETRIEVED,
  },
  'GB-AA-1996-91': {
    id: 'GB-AA-1996-91',
    authority: 'Arbitration Act 1996',
    provision: 's.91',
    summary:
      'An arbitration agreement is automatically unfair, so far as it relates to a claim for a modest amount, where that amount does not exceed the prescribed limit of £5,000.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source:
      'Arbitration Act 1996 s.91 with the Unfair Arbitration Agreements (Specified Amount) Order 1999',
    retrievedOn: RETRIEVED,
  },
  'EU-UCTD-5': {
    id: 'EU-UCTD-5',
    authority: 'Unfair Contract Terms Directive 93/13/EEC',
    provision: 'Art.5',
    summary:
      'Written terms must be drafted in plain, intelligible language; where there is doubt, the interpretation most favourable to the consumer prevails.',
    jurisdiction: 'GB-ENG',
    verified: true,
    source: 'Council Directive 93/13/EEC, EUR-Lex',
    retrievedOn: RETRIEVED,
  },
} as const satisfies Record<string, Citation>;

export type CitationId = keyof typeof CITATIONS;

/** Resolve a citation id. Throws on an unknown id so a typo cannot silently drop a citation. */
export function citation(id: CitationId): Citation {
  return CITATIONS[id];
}

export function citations(...ids: readonly CitationId[]): readonly Citation[] {
  return ids.map(citation);
}

export const ALL_CITATIONS: readonly Citation[] = Object.values(CITATIONS);
