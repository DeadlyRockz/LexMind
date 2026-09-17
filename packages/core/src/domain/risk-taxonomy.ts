import type { CitationId } from './citations.ts';
import type { ClauseTypeId } from './clause-types.ts';
import type { JurisdictionId, Severity, StatutoryStatus } from './types.ts';

/**
 * The 31 tenant-adverse patterns.
 *
 * Two hard rules hold across this file:
 *
 *  1. Every pattern carries at least one citation, or it does not ship. A test asserts it.
 *  2. `whyItMatters` states what the clause *does*. It never tells the reader what to do —
 *     that is the line between legal information and legal advice, and `safety/boundary.ts`
 *     enforces the same line on the way out.
 *
 * Patterns with a `numeric` kind are *not* decided by text cues: `analyse/rules.ts` computes them
 * in TypeScript against extracted numbers and a cited statutory limit. The model never compares a
 * number to a statute.
 */

export interface Ruling {
  readonly jurisdiction: JurisdictionId;
  readonly status: StatutoryStatus;
  readonly citations: readonly CitationId[];
}

export type NumericKind =
  | 'deposit-cap'
  | 'late-fee'
  | 'entry-notice'
  | 'notice-asymmetry'
  | 'lock-in'
  | 'rent-escalation'
  | 'term-registration'
  | 'readability';

export interface RiskPattern {
  readonly id: string;
  readonly clauseTypeId: ClauseTypeId;
  /** A statement about the document. */
  readonly title: string;
  /** Information about what such a clause does. Never a recommendation. */
  readonly whyItMatters: string;
  readonly baseSeverity: Severity;
  readonly financialExposure: 0 | 1 | 2 | 3;
  readonly reversible: boolean;
  /** True when the clause gives one party a right the other does not hold. */
  readonly asymmetric: boolean;
  readonly rulings: readonly Ruling[];
  /**
   * Deterministic cues, as AND-of-ORs: the pattern fires when *every* group has at least one
   * phrase present in the clause. Kept as data so adding a drafting variant is a data change.
   */
  readonly cues: readonly (readonly string[])[];
  /** Any of these present suppresses the match — the cheapest false-positive control we have. */
  readonly exclude?: readonly string[];
  readonly numeric?: NumericKind;
}

export const RISK_PATTERNS = [
  // ─── Deposit ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'deposit-excessive',
    clauseTypeId: 'security-deposit',
    title: 'The security deposit is larger than the local limit',
    whyItMatters:
      'Several jurisdictions cap how much deposit a landlord may take. Where a cap applies, the amount above it is generally recoverable, and the cap applies whatever the agreement says.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: false,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-MTA-11-1'] },
      { jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-URLTA-2-101-A'] },
      { jurisdiction: 'US-CA', status: 'restricted', citations: ['US-CA-1950-5-C'] },
      { jurisdiction: 'US-NY', status: 'restricted', citations: ['US-NY-GOL-7-108'] },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-TFA-2019'] },
    ],
    cues: [],
    numeric: 'deposit-cap',
  },
  {
    id: 'deposit-non-refundable',
    clauseTypeId: 'deposit-deductions',
    title: 'Part or all of the deposit is described as non-refundable',
    whyItMatters:
      'A deposit is security against damage or unpaid rent, so it is normally refundable minus lawful deductions. Describing it as non-refundable changes it into a fee, and in some places only listed fees may be charged at all.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-MTA-11-2'] },
      { jurisdiction: 'GB-ENG', status: 'unenforceable', citations: ['GB-TFA-2019'] },
      { jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-URLTA-2-101-A'] },
    ],
    cues: [
      // The sum that is not refunded is as often called a fee as a deposit — and a non-refundable
      // administration or holding fee is precisely the prohibited payment the Tenant Fees Act 2019
      // cited below is about, so the vocabulary belongs in the same row rather than a second one.
      [
        'deposit',
        'caution money',
        'bond',
        'administration fee',
        'administrative fee',
        'admin fee',
        'holding fee',
        'booking fee',
        'joining fee',
      ],
      [
        'non-refundable',
        'non refundable',
        'shall not be refunded',
        'not be returned',
        'forfeited absolutely',
        'stands forfeited',
      ],
    ],
  },
  {
    id: 'deposit-forfeiture-on-early-exit',
    clauseTypeId: 'deposit-deductions',
    title: 'The whole deposit is forfeited if the tenancy ends early',
    whyItMatters:
      'This makes the deposit a penalty for leaving rather than security against loss. Where a stipulated sum on breach exceeds the actual loss, the law in several jurisdictions limits recovery to reasonable compensation.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CONTRACT-74'] },
      {
        jurisdiction: 'IN-MTA',
        status: 'restricted',
        citations: ['IN-CONTRACT-74', 'IN-MTA-11-2'],
      },
      { jurisdiction: 'GB-ENG', status: 'unenforceable', citations: ['GB-TFA-2019'] },
    ],
    cues: [
      ['deposit', 'caution money'],
      ['forfeit', 'forfeited', 'shall stand forfeited', 'shall not be refunded'],
      [
        'vacate before',
        'vacates before',
        'early termination',
        'terminates before',
        'prior to the expiry',
        'before the expiry',
        'lock-in',
        'lock in',
      ],
    ],
  },
  {
    id: 'deposit-no-interest',
    clauseTypeId: 'security-deposit',
    title: 'The deposit is held without interest',
    whyItMatters:
      'Holding a deposit interest-free is common and lawful in many places, but some jurisdictions require interest or a protection scheme. Worth checking against the local rule for the property.',
    baseSeverity: 'info',
    financialExposure: 1,
    reversible: true,
    asymmetric: false,
    rulings: [{ jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-TFA-2019'] }],
    cues: [
      ['deposit'],
      [
        'interest free',
        'interest-free',
        'without interest',
        'no interest shall be',
        'shall not carry interest',
      ],
    ],
  },

  // ─── Term ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'lock-in-period',
    clauseTypeId: 'lock-in',
    title: 'A lock-in period prevents the tenant leaving early',
    whyItMatters:
      'A lock-in binds the tenant to keep paying for a fixed window. India has no statute setting lock-in limits; the question is treated as whether the sum demanded on breach is a penalty rather than reasonable compensation.',
    baseSeverity: 'medium',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'unknown', citations: ['IN-CONTRACT-74'] },
      { jurisdiction: 'IN-MTA', status: 'unknown', citations: ['IN-CONTRACT-74'] },
    ],
    cues: [],
    numeric: 'lock-in',
  },
  {
    id: 'auto-renewal-silent',
    clauseTypeId: 'renewal',
    title: 'The tenancy renews automatically unless the tenant acts',
    whyItMatters:
      'Silence becomes consent: if the tenant misses the notice window the term extends, often with an increase. The obligation to act sits entirely with the tenant.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: true,
    asymmetric: true,
    rulings: [{ jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] }],
    cues: [
      [
        'automatically renew',
        'automatically be renewed',
        'shall stand renewed',
        'deemed renewed',
        'deemed to be renewed',
        'auto-renew',
        'shall be extended automatically',
      ],
    ],
  },
  {
    id: 'holdover-double-rent',
    clauseTypeId: 'holdover',
    title: 'Staying past the end date triggers a multiple of the rent',
    whyItMatters:
      'Holdover charges at two or three times the rent operate as a penalty rather than a measure of the landlord actual loss, which is the test applied to stipulated sums on breach.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: true,
    asymmetric: true,
    rulings: [{ jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CONTRACT-74'] }],
    cues: [
      [
        'double the rent',
        'double rent',
        'twice the rent',
        'thrice the rent',
        'three times the rent',
        'two times the rent',
        '2 times the rent',
        '200% of the rent',
      ],
    ],
  },
  {
    id: 'unregistered-tenancy-over-one-year',
    clauseTypeId: 'registration',
    title: 'The term runs over a year with no registration clause',
    whyItMatters:
      'In India registration is compulsory for a lease exceeding one year or reserving a yearly rent. An unregistered document that required registration cannot be used as evidence of the transaction — which is why eleven-month agreements are the norm.',
    baseSeverity: 'medium',
    financialExposure: 1,
    reversible: true,
    asymmetric: false,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-REG-17-1-D', 'IN-REG-49'] },
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-REG-17-1-D', 'IN-REG-49'] },
    ],
    cues: [],
    numeric: 'term-registration',
  },

  // ─── Termination & notice ─────────────────────────────────────────────────────────────────
  {
    id: 'unilateral-termination-landlord',
    clauseTypeId: 'termination-landlord',
    title: 'The landlord can end the tenancy at will, without giving a reason',
    whyItMatters:
      'A right to terminate at sole discretion and without cause is one-sided by construction. It is listed as a characteristic of an unfair contract term in Indian consumer law, and in England the no-fault route was abolished in 2026.',
    baseSeverity: 'critical',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-CPA-2-46', 'IN-MTA-20'] },
      { jurisdiction: 'GB-ENG', status: 'unenforceable', citations: ['GB-RRA-2025'] },
    ],
    cues: [
      // Ending a tenancy is drafted as recovering possession at least as often as it is drafted as
      // terminating: England's model instruments say "recover possession", India's say "terminate",
      // and a detector that knows only one word reads only half the world's leases.
      [
        'terminat',
        'revoke this',
        'cancel this agreement',
        'bring this agreement to an end',
        'recover possession',
        'obtain possession',
        'take possession',
        'repossess',
        'evict',
        'end this tenancy',
        'end the tenancy',
        'determine this tenancy',
        'determine the tenancy',
      ],
      [
        'sole discretion',
        'absolute discretion',
        'without assigning any reason',
        'without assigning reason',
        'without cause',
        'for any reason whatsoever',
        'at will',
        'at any time without',
      ],
      // Whose right it is, under every name the instruments use. Without this group the row reads
      // "The Tenant may terminate this Agreement at any time without penalty" — a right the tenant
      // holds and the landlord does not — as the landlord ending the tenancy at will, which
      // inverts the clause and reports the fairest drafting in the document as its most serious
      // defect.
      ['landlord', 'lessor', 'licensor', 'owner', 'management'],
    ],
  },
  {
    id: 'notice-asymmetry',
    clauseTypeId: 'notice-periods',
    title: 'The notice period is longer for the tenant than for the landlord',
    whyItMatters:
      'One party must give weeks of warning and the other days. This is a structural imbalance that can be read off the document itself, with no reference to any statute.',
    baseSeverity: 'high',
    financialExposure: 2,
    reversible: false,
    asymmetric: true,
    rulings: [{ jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] }],
    cues: [],
    numeric: 'notice-asymmetry',
  },
  {
    id: 'no-cure-period',
    clauseTypeId: 'default-remedies',
    title: 'A breach ends the tenancy immediately, with no chance to put it right',
    whyItMatters:
      'Most tenancy regimes expect a notice and an opportunity to remedy before possession is lost. Immediate termination on any breach removes that step.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-MTA-20'] },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-PEA-1977-2'] },
      { jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-URLTA-4-207'] },
    ],
    cues: [
      // Three groups rather than one glued phrase: real drafting puts the object between the verb
      // and its adverb — "terminate *this agreement* with immediate effect" — so a contiguous
      // "terminate with immediate effect" cue matches a sentence nobody writes.
      [
        'terminat',
        'cancel this agreement',
        'stand cancelled',
        'bring this agreement to an end',
        'evict',
        'recover possession',
        're-enter',
        'reenter',
        'forfeit the tenancy',
      ],
      [
        'immediate effect',
        'immediately',
        'forthwith',
        'without notice',
        'without any notice',
        'without prior notice',
        'at once',
        'no opportunity to',
        'without any opportunity',
      ],
      ['breach', 'default', 'violat', 'fail'],
    ],
    // A stated chance to put the breach right is the answer to this check.
    exclude: [
      'opportunity to remedy',
      'opportunity to cure',
      'opportunity to rectify',
      'time to remedy',
      'notice to remedy',
      'notice to rectify',
      'cure period',
      'days to remedy',
      'days to rectify',
    ],
  },
  {
    id: 'forfeiture-lockout-self-help',
    clauseTypeId: 'default-remedies',
    title: 'The landlord may re-take the property or cut off services directly',
    whyItMatters:
      'Locking a tenant out, removing belongings, or cutting off water or power to force an exit is prohibited in the tenancy regimes surveyed here — possession is recovered through a court or tribunal, not by the landlord acting alone.',
    baseSeverity: 'critical',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'US-URLTA', status: 'void', citations: ['US-URLTA-4-207'] },
      { jurisdiction: 'GB-ENG', status: 'void', citations: ['GB-PEA-1977-2'] },
      { jurisdiction: 'IN-MTA', status: 'void', citations: ['IN-MTA-20'] },
    ],
    cues: [
      [
        'lock the premises',
        'lock out',
        'change the locks',
        're-enter',
        'reenter',
        're-take possession',
        'take forcible possession',
        'forcibly evict',
        'disconnect',
        'cut off',
        'discontinue the supply',
        'remove the belongings',
        'remove the articles',
      ],
    ],
    exclude: ['through a court', 'by due process of law', 'order of the competent court'],
  },

  // ─── Entry ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'entry-without-notice',
    clauseTypeId: 'inspection-entry',
    title: 'The landlord may enter without advance notice',
    whyItMatters:
      'The regimes surveyed here set a minimum warning before entry — 24 hours in writing under the Model Tenancy Act, at least two days under URLTA — with emergencies excepted.',
    baseSeverity: 'high',
    financialExposure: 0,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-MTA-17'] },
      { jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-URLTA-3-103-C'] },
    ],
    cues: [
      ['enter', 'entry', 'access to the premises', 'inspect'],
      [
        'at any time',
        'without notice',
        'without prior notice',
        'without any notice',
        'without intimation',
        'unannounced',
      ],
    ],
    exclude: ['emergency only', 'in case of emergency'],
    numeric: 'entry-notice',
  },

  // ─── Repairs & condition ──────────────────────────────────────────────────────────────────
  {
    id: 'maintenance-shifted-to-tenant',
    clauseTypeId: 'tenant-repairs',
    title: 'Structural or major repairs are made the tenant responsibility',
    whyItMatters:
      'Structural repair duties are non-displaceable in each regime surveyed: the Model Tenancy Act applies them "notwithstanding any agreement to the contrary", and in England a covenant shifting the section 11 duty to the tenant is void.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'void', citations: ['IN-MTA-15-1'] },
      { jurisdiction: 'GB-ENG', status: 'void', citations: ['GB-LTA-1985-11', 'GB-LTA-1985-12'] },
      { jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-URLTA-2-104'] },
    ],
    cues: [
      [
        'tenant shall',
        'lessee shall',
        'licensee shall',
        'tenant is responsible',
        'tenant agrees to',
        'at the cost of the tenant',
        'at the tenant own cost',
      ],
      [
        'structural',
        'major repairs',
        'all repairs',
        'any and all repairs',
        'entire maintenance',
        'whole of the maintenance',
        'roof',
        'plumbing and wiring',
        'all repairs whatsoever',
      ],
    ],
  },
  {
    id: 'as-is-habitability-waiver',
    clauseTypeId: 'habitability',
    title: 'The property is taken "as is", with fitness disclaimed',
    whyItMatters:
      'An as-is acceptance can read as giving up a habitability protection. In California a lease term waiving the implied warranty of habitability is void as against public policy.',
    baseSeverity: 'high',
    financialExposure: 2,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'US-CA', status: 'void', citations: ['US-CA-1953-A'] },
      {
        jurisdiction: 'US-URLTA',
        status: 'restricted',
        citations: ['US-URLTA-2-104', 'US-URLTA-1-403-A-1'],
      },
      { jurisdiction: 'GB-ENG', status: 'void', citations: ['GB-LTA-1985-12'] },
    ],
    cues: [
      ['as is', 'as-is', 'present condition', 'existing condition'],
      [
        'no warranty',
        'without any warranty',
        'waives',
        'waive',
        'disclaim',
        'accepts the premises',
        'satisfied himself',
      ],
    ],
  },

  // ─── URLTA §1.403(a): the four clause types a lease may not contain ───────────────────────
  {
    id: 'waiver-of-legal-rights',
    clauseTypeId: 'waiver-of-rights',
    title: 'The tenant gives up rights the law provides',
    whyItMatters:
      'URLTA §1.403(a)(1) lists a waiver of statutory rights or remedies as a provision a rental agreement may not contain, and California voids specified waivers outright. A prohibited provision is unenforceable however clearly it is written.',
    baseSeverity: 'critical',
    financialExposure: 2,
    reversible: false,
    asymmetric: true,
    rulings: [
      {
        jurisdiction: 'US-URLTA',
        status: 'void',
        citations: ['US-URLTA-1-403-A-1', 'US-URLTA-1-403-B'],
      },
      { jurisdiction: 'US-CA', status: 'void', citations: ['US-CA-1953-A'] },
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
    ],
    cues: [
      ['waive', 'waives', 'waiver of', 'gives up', 'relinquish', 'forgo', 'forego'],
      ['right', 'rights', 'remedy', 'remedies', 'statutory', 'protection of', 'benefit of any law'],
    ],
    exclude: ['no waiver of any breach', 'failure to enforce'],
  },
  {
    id: 'confession-of-judgment',
    clauseTypeId: 'waiver-of-rights',
    title: 'The tenant agrees in advance to a judgment against them',
    whyItMatters:
      'A confession of judgment lets a claim be entered without the tenant being heard. URLTA §1.403(a)(2) lists it as a provision a rental agreement may not contain.',
    baseSeverity: 'critical',
    financialExposure: 3,
    reversible: false,
    asymmetric: true,
    rulings: [
      {
        jurisdiction: 'US-URLTA',
        status: 'void',
        citations: ['US-URLTA-1-403-A-2', 'US-URLTA-1-403-B'],
      },
    ],
    cues: [
      [
        'confession of judgment',
        'confess judgment',
        'consent to judgment',
        'cognovit',
        'warrant of attorney to confess',
      ],
    ],
  },
  {
    id: 'landlord-attorney-fees',
    clauseTypeId: 'dispute-resolution',
    title: 'The tenant pays the landlord legal costs',
    whyItMatters:
      'One-way fee shifting makes it expensive for a tenant to defend even a claim they would win. URLTA §1.403(a)(3) lists an agreement to pay the landlord attorney fees as a provision a rental agreement may not contain.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: true,
    rulings: [
      {
        jurisdiction: 'US-URLTA',
        status: 'void',
        citations: ['US-URLTA-1-403-A-3', 'US-URLTA-1-403-B'],
      },
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
    ],
    cues: [
      [
        'attorney fee',
        "attorney's fee",
        'attorneys fees',
        'advocate fee',
        'legal fees',
        'legal costs',
        'cost of litigation',
        'solicitor',
      ],
      // The paying party is the tenant under every name the instruments use for them: an Indian
      // leave-and-licence agreement says "the licensee shall pay", a lease says "the lessee".
      // Requiring the word "tenant" would read one-way fee shifting as balanced wherever the
      // drafter happened to use a different word for the same person.
      [
        'tenant shall',
        'tenant agrees',
        'lessee shall',
        'lessee agrees',
        'licensee shall',
        'licensee agrees',
        'borne by the tenant',
        'borne by the lessee',
        'borne by the licensee',
        'payable by the tenant',
        'payable by the lessee',
        'payable by the licensee',
        'reimburse the landlord',
        'reimburse the lessor',
        'reimburse the licensor',
        'indemnify the landlord',
        'indemnify the lessor',
        'indemnify the licensor',
      ],
    ],
  },
  {
    id: 'exculpation-indemnity',
    clauseTypeId: 'indemnity-exculpation',
    title: 'The landlord liability is excluded, or the tenant indemnifies it',
    whyItMatters:
      'This moves the cost of the landlord own failures onto the tenant. URLTA §1.403(a)(4) lists exculpation of the landlord liability, and indemnification of it, as provisions a rental agreement may not contain.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: true,
    rulings: [
      {
        jurisdiction: 'US-URLTA',
        status: 'void',
        citations: ['US-URLTA-1-403-A-4', 'US-URLTA-1-403-B'],
      },
      { jurisdiction: 'US-CA', status: 'void', citations: ['US-CA-1953-A'] },
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
    ],
    cues: [
      [
        'indemnify',
        'indemnity',
        'hold harmless',
        'shall not be liable',
        'shall not be responsible',
        'not be responsible for any loss',
        'at the tenant own risk',
        'entirely at the risk of the tenant',
      ],
    ],
  },

  // ─── Disputes ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'arbitration-mandatory',
    clauseTypeId: 'dispute-resolution',
    title: 'Disputes must go to arbitration rather than a court',
    whyItMatters:
      'Arbitration can cost more than the amount in dispute and removes the tribunal route. In England an arbitration agreement is automatically unfair for claims up to the prescribed £5,000 limit, and a term hindering the right to take legal action is on the indicative list of unfair terms.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: false,
    asymmetric: false,
    rulings: [
      {
        jurisdiction: 'GB-ENG',
        status: 'unenforceable',
        citations: ['GB-AA-1996-91', 'GB-CRA-2015-SCH2-20'],
      },
      { jurisdiction: 'US-CA', status: 'restricted', citations: ['US-CA-1953-A'] },
    ],
    cues: [
      ['arbitration', 'arbitrator', 'arbitral'],
      [
        'shall be referred',
        'exclusively',
        'sole',
        'binding',
        'final and binding',
        'must be resolved',
      ],
    ],
  },
  {
    id: 'class-action-waiver',
    clauseTypeId: 'dispute-resolution',
    title: 'The tenant gives up the right to join a collective claim',
    whyItMatters:
      'Small individual losses are often only worth pursuing collectively. A term that excludes or hinders the consumer right to take legal action appears on the indicative list of unfair terms in England.',
    baseSeverity: 'medium',
    financialExposure: 1,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'GB-ENG', status: 'unenforceable', citations: ['GB-CRA-2015-SCH2-20'] },
      { jurisdiction: 'US-CA', status: 'restricted', citations: ['US-CA-1953-A'] },
    ],
    cues: [
      ['class action', 'class-action', 'class-wide', 'collective action', 'representative action'],
    ],
  },
  {
    id: 'jury-trial-waiver',
    clauseTypeId: 'dispute-resolution',
    title: 'The tenant gives up the right to a jury trial',
    whyItMatters:
      'California voids a lease term by which the tenant waives the right to a jury trial, and URLTA lists a waiver of rights or remedies as a provision a rental agreement may not contain.',
    baseSeverity: 'high',
    financialExposure: 1,
    reversible: false,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'US-CA', status: 'void', citations: ['US-CA-1953-A'] },
      { jurisdiction: 'US-URLTA', status: 'void', citations: ['US-URLTA-1-403-A-1'] },
    ],
    cues: [['jury trial', 'trial by jury', 'right to a jury']],
  },

  // ─── Charges ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'late-fee-excessive',
    clauseTypeId: 'late-fee',
    title: 'The late payment charge is above the local ceiling',
    whyItMatters:
      'Late fee ceilings exist where surveyed: 5 per cent of monthly rent in Maryland and Nevada, and in England default interest is limited to 3 per cent over base rate and only after 14 days.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: true,
    asymmetric: false,
    rulings: [
      {
        jurisdiction: 'US-URLTA',
        status: 'restricted',
        citations: ['US-MD-8-208-D-3', 'US-NV-118A-210'],
      },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-TFA-2019-LATE'] },
    ],
    cues: [],
    numeric: 'late-fee',
  },
  {
    id: 'late-fee-daily-compounding',
    clauseTypeId: 'late-fee',
    title: 'The late charge accrues every day, or compounds',
    whyItMatters:
      'A per-day charge grows without a stated ceiling, so a short delay can cost a large multiple of the sum owed. Stipulated sums on breach are tested against actual loss rather than enforced as written.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CONTRACT-74'] },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-TFA-2019-LATE'] },
    ],
    cues: [
      ['per day', 'per diem', 'each day of delay', 'for every day', 'compounded', 'compounding'],
      ['late', 'delay', 'default', 'arrears', 'overdue', 'penalty', 'interest'],
    ],
  },
  {
    id: 'rent-escalation-discretionary',
    clauseTypeId: 'rent-escalation',
    title: 'The landlord sets rent increases at their own discretion',
    whyItMatters:
      'An increase with no stated ceiling or method leaves the price of staying open-ended. A term imposing an unreasonable charge that puts the consumer at a disadvantage is a listed characteristic of an unfair contract in India.',
    baseSeverity: 'high',
    financialExposure: 3,
    reversible: true,
    asymmetric: true,
    rulings: [{ jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] }],
    cues: [
      ['increase', 'increas', 'escalat', 'revis', 'enhanc'],
      [
        'sole discretion',
        'absolute discretion',
        'as may be decided by the landlord',
        'as determined by the landlord',
        'at the discretion of the landlord',
        'such amount as the landlord',
      ],
    ],
  },
  {
    id: 'rent-escalation-steep',
    clauseTypeId: 'rent-escalation',
    title: 'The stated rent increase is steep',
    whyItMatters:
      'A fixed uplift well above typical local practice compounds over a multi-year term. The figure is reported here as the document states it, with no claim about whether it is lawful where the property is.',
    baseSeverity: 'medium',
    financialExposure: 2,
    reversible: true,
    asymmetric: false,
    rulings: [{ jurisdiction: 'IN-STATE', status: 'unknown', citations: ['IN-CPA-2-46'] }],
    cues: [],
    numeric: 'rent-escalation',
  },

  // ─── Use & control ────────────────────────────────────────────────────────────────────────
  {
    id: 'unilateral-variation-of-rules',
    clauseTypeId: 'rules-and-regulations',
    title: 'The landlord can change the rules after signing',
    whyItMatters:
      'Terms incorporated "as amended from time to time" can change the deal after it is agreed, without the tenant consenting to the new version.',
    baseSeverity: 'medium',
    financialExposure: 1,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-CRA-2015-68'] },
    ],
    cues: [
      [
        'as amended from time to time',
        'may amend',
        'may modify',
        'may revise',
        'may frame such rules',
        'as may be notified',
      ],
      ['rules', 'regulations', 'terms', 'bye-laws', 'byelaws', 'conditions'],
    ],
  },
  {
    id: 'subletting-and-guest-overreach',
    clauseTypeId: 'occupancy-limits',
    title: 'Visitors or overnight guests need the landlord permission',
    whyItMatters:
      'Restrictions reaching past subletting into ordinary visitors affect the right to occupy the home peacefully, which the tenancy regimes surveyed here treat as protected.',
    baseSeverity: 'medium',
    financialExposure: 0,
    reversible: true,
    asymmetric: true,
    rulings: [
      { jurisdiction: 'IN-MTA', status: 'restricted', citations: ['IN-MTA-17'] },
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-CRA-2015-68'] },
    ],
    cues: [
      ['guest', 'guests', 'visitor', 'visitors', 'overnight'],
      [
        'prior written permission',
        'prior permission',
        'prior consent',
        'shall not be permitted',
        'not be allowed',
        'prohibited',
      ],
    ],
  },
  {
    id: 'occupancy-discrimination',
    clauseTypeId: 'occupancy-limits',
    title: 'Occupancy is restricted by a personal characteristic',
    whyItMatters:
      'Restrictions written around diet, marital status, religion, caste or family status touch protected characteristics. The seven federal grounds in the United States are race, colour, religion, sex, national origin, familial status and disability; many State and local laws add more, so this is jurisdiction-specific.',
    baseSeverity: 'high',
    financialExposure: 0,
    reversible: false,
    asymmetric: true,
    rulings: [{ jurisdiction: 'US-URLTA', status: 'restricted', citations: ['US-FHA-3604'] }],
    cues: [
      ['only', 'shall not', 'not be permitted', 'restricted to', 'prohibited'],
      [
        'vegetarian',
        'non-vegetarian',
        'bachelor',
        'bachelors',
        'spinster',
        'marital status',
        'religion',
        'caste',
        'community',
        'unmarried couple',
        'children shall not',
      ],
    ],
  },

  // ─── Drafting & mischaracterisation ───────────────────────────────────────────────────────
  {
    id: 'unintelligible-drafting',
    clauseTypeId: 'definitions',
    title: 'A clause is written at a reading level that obscures it',
    whyItMatters:
      'Transparency is a legal requirement in consumer contracts in England and under the Unfair Contract Terms Directive: a written term must be in plain and intelligible language, and doubt is resolved in the consumer favour.',
    baseSeverity: 'low',
    financialExposure: 0,
    reversible: true,
    asymmetric: false,
    rulings: [
      { jurisdiction: 'GB-ENG', status: 'restricted', citations: ['GB-CRA-2015-68', 'EU-UCTD-5'] },
      { jurisdiction: 'IN-STATE', status: 'restricted', citations: ['IN-CPA-2-46'] },
    ],
    cues: [],
    numeric: 'readability',
  },
  {
    id: 'ast-section-21-mischaracterised',
    clauseTypeId: 'termination-landlord',
    title: 'The document describes an English tenancy regime that has been replaced',
    whyItMatters:
      "The Renters' Rights Act 2025 converted assured shorthold tenancies to assured periodic tenancies on 1 May 2026 and abolished the Section 21 no-fault route. A document still describing an AST with a Section 21 notice is describing a regime that no longer exists.",
    baseSeverity: 'high',
    financialExposure: 1,
    reversible: true,
    asymmetric: false,
    rulings: [{ jurisdiction: 'GB-ENG', status: 'unenforceable', citations: ['GB-RRA-2025'] }],
    cues: [['assured shorthold tenancy', 'section 21', 's.21 notice', 'shorthold']],
  },
] as const satisfies readonly RiskPattern[];

export type RiskPatternId = (typeof RISK_PATTERNS)[number]['id'];

const BY_ID = new Map<string, RiskPattern>(RISK_PATTERNS.map((p) => [p.id, p]));

export function riskPattern(id: RiskPatternId): RiskPattern {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown risk pattern: ${id}`);
  return found;
}

export function findRiskPattern(id: string): RiskPattern | undefined {
  return BY_ID.get(id);
}

/** The whole set, widened: the `as const` literal type is for ids, not for iteration. */
export const ALL_RISK_PATTERNS: readonly RiskPattern[] = RISK_PATTERNS;

/** Patterns decided by text cues. The rest are computed numerically in `analyse/rules.ts`. */
export const CUE_PATTERNS: readonly RiskPattern[] = ALL_RISK_PATTERNS.filter(
  (p) => p.numeric === undefined,
);

export const NUMERIC_PATTERNS: readonly RiskPattern[] = ALL_RISK_PATTERNS.filter(
  (p) => p.numeric !== undefined,
);
