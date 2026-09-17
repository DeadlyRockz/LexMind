import type { ClauseGroup, ClauseType } from './types.ts';

/**
 * The 38 canonical clause types.
 *
 * Derived from four published model instruments rather than invented, so the taxonomy is
 * defensible: the gov.uk Model Agreement for an assured tenancy, HUD model lease form 90105-a,
 * the Model Tenancy Act 2021 (Chapters II-V and both Schedules), and URLTA (Articles I-V).
 *
 * ## Why a flat synonym list was not enough
 *
 * The first version of this file gave every type one undifferentiated `synonyms` array and let the
 * detector add up length-weighted hits. That model cannot tell a *distinctive* phrase from a
 * *generic* one, and the failure was not theoretical:
 *
 *  - `'at any time'` sat in `inspection-entry`'s synonym list, so **every termination clause that
 *    used the phrase was typed as an entry clause** — which made the fact extractor record
 *    `entryNoticeHours: 0` and the rule engine show a tenant a medium-severity "the landlord may
 *    enter without advance notice" card quoting a *possession* clause, on a lease that grants no
 *    right of entry at all.
 *  - `'landlord'` and `'tenant'` sat in `parties`, so `parties` attached itself to almost every
 *    clause in every lease: 1 true positive against 45 false positives on the golden set.
 *  - Meanwhile the clearest possible entry clause — "Landlord shall give twenty-four hours written
 *    notice before entering" — matched nothing at all.
 *
 * So phrases are now typed by the *job they can do*, as three separate columns:
 *
 * | Column    | What it is                                       | Can it type a clause alone? |
 * |-----------|--------------------------------------------------|-----------------------------|
 * | `caption` | the word a drafter puts in the clause's own title | only when found in the caption |
 * | `cues`    | distinctive drafting phrases                      | yes                          |
 * | `support` | generic words that corroborate                    | **never**                    |
 * | `exclude` | phrases or sequences that rule the type out       | —                            |
 *
 * `'at any time'` is now `support` on `inspection-entry`: it strengthens a clause that already
 * says "may enter", and it can no longer manufacture an entry clause out of a termination clause.
 * `'landlord'` is `support` on `parties`; the cue is `'is made between'`.
 *
 * ## Role placeholders
 *
 * Leases say *lessee*, *licensee* and *tenant* for the same person, so a cue may contain a
 * placeholder — `{tenant}`, `{landlord}`, `{premises}`, `{agreement}` — which the detector expands
 * over `ROLE_WORDS`. One row covers every drafting dialect instead of three near-duplicate rows.
 *
 * ## Sequence cues
 *
 * A cue may also be an ordered list of phrases that must appear **in one sentence, in order**:
 * `['{tenant}', 'give', 'notice']` matches "Tenant must give sixty days written notice" and not
 * "The landlord shall give the tenant a written account". Legal drafting is overwhelmingly
 * subject-first, so order carries real meaning and costs nothing to check.
 *
 * ## Naming a subject is not setting a term
 *
 * Some bare noun phrases — "the notice period", "licence fee", "apartment unit", "renewal of this
 * agreement" — are how *any* clause refers to a subject, so they are support: "a deposit of 75,000,
 * being three months licence fee" is a deposit term measured in rent, and "the licence fee shall be
 * increased on renewal of this agreement" is an escalation term that takes effect at renewal. What
 * types a clause is the drafting that *sets* the term: the noun with its figure ("licence fee of"),
 * its verb ("may be renewed"), or its subject ("the deposit … shall not be refunded", in one
 * sentence). `rent` already worked this way: the word `rent` is support and `rent of` is the cue.
 *
 * "Security deposit" is support on the same rule. A lock-in clause saying "the entire security
 * deposit shall stand forfeited" is about forfeiture, not about the deposit being taken. The clause
 * that sets the deposit is still found: by its caption ("5. SECURITY DEPOSIT", or "5. Security
 * Deposit." in title case), by its figure ("deposit of", "deposit equal to"), or by the payment
 * verb ("pay a security deposit").
 *
 * ## Naming a waiver is not waiving
 *
 * `waiver-of-rights` means a tenant giving up a legal right. The standard non-waiver boilerplate —
 * "no waiver of any breach shall be deemed a waiver of any subsequent breach" — uses the word only to
 * say that nobody has given anything up, and it binds both parties. It is ruled out by `exclude`
 * data. An exclusion rules the type out for the whole clause, so a clause that both waives a right
 * and repeats the boilerplate is typed by neither.
 *
 * `synonyms` is derived from the three columns, so the flat list every other module already reads
 * stays true without being a second source of truth.
 */

const AST = 'gov.uk Model Agreement for an assured tenancy';
const HUD = 'HUD model lease 90105-a';
const MTA = 'Model Tenancy Act 2021, Chapters II-V';
const URLTA = 'URLTA Articles I-V';

/**
 * A cue: either one phrase, or an ordered sequence that must share a sentence.
 *
 * Both forms may contain role placeholders.
 */
export type Cue = string | readonly string[];

/**
 * The words a lease uses for the same role, or for the same slot in a sentence.
 *
 * Expanded into cues wherever a `{placeholder}` appears, which is what lets a single row match
 * "the tenant shall repair", "the lessee shall repair" and "the licensee shall repair".
 *
 * `{rent}` is the periodic payment under both drafting traditions: a leave-and-licence agreement
 * calls it a licence fee, and giving the two words one row is what keeps them to one evidence rule.
 * `{month}` is a calendar month, which is how a cue recognises a stated date ("from 1 April 2026")
 * without a date parser. It includes "may", so every cue that uses it anchors the month to a subject
 * and a duration earlier in the same sentence rather than accepting the modal verb on its own.
 *
 * `{days}` and `{notice}` are the two halves of a stated notice period: "thirty days' notice", "one
 * month's prior written notice". Hours are left out on purpose, because "twenty-four hours written
 * notice before entering" is an entry term. The detector reads an apostrophe as optional and as
 * either the straight or the curly form, so "month's" also covers "month’s" and "months", and
 * "days'" also covers "days’" and "days".
 *
 * `{deemed}` is the verb in "shall not be deemed a waiver" and all the other ways of writing it.
 */
export const ROLE_WORDS: Readonly<Record<string, readonly [string, ...string[]]>> = {
  '{landlord}': ['landlord', 'lessor', 'licensor', 'owner'],
  '{tenant}': ['tenant', 'lessee', 'licensee'],
  '{premises}': ['premises', 'property', 'flat', 'apartment', 'dwelling'],
  '{agreement}': ['agreement', 'lease', 'tenancy', 'licence', 'license'],
  '{rent}': ['rent', 'licence fee', 'license fee'],
  '{month}': [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ],
  '{days}': ['day', "day's", "days'", 'week', "week's", "weeks'", 'month', "month's", "months'"],
  '{notice}': [
    'notice',
    'written notice',
    'prior notice',
    'prior written notice',
    'advance notice',
    'advance written notice',
    'clear notice',
  ],
  '{deemed}': [
    'deemed',
    'deemed as',
    'deemed to be',
    'deemed to constitute',
    'construed as',
    'construed to be',
    'treated as',
    'considered',
    'considered as',
    'considered to be',
    'held to be',
    'regarded as',
  ],
};

/** A clause type as the detector reads it: the same row, with its evidence separated by job. */
export interface ClauseTypeRow extends ClauseType {
  /** Words a drafter puts in the clause's own title. Scored only when found in the caption. */
  readonly caption: readonly string[];
  /** Distinctive drafting phrases. One of these is required before a type scores at all. */
  readonly cues: readonly Cue[];
  /** Generic corroboration. Adds weight to a type that already matched; never types a clause. */
  readonly support: readonly string[];
  /** Phrases or sequences that rule the type out for the whole clause, whatever else matched. */
  readonly exclude: readonly Cue[];
}

interface RawRow {
  readonly id: string;
  readonly label: string;
  readonly group: ClauseGroup;
  readonly priority: boolean;
  readonly derivedFrom: readonly string[];
  readonly caption: readonly string[];
  readonly cues: readonly Cue[];
  /** Required, because "this type has nothing generic behind it" is itself worth stating. */
  readonly support: readonly string[];
  /** Omitted by most types; a row only carries one when a phrase genuinely rules the type out. */
  readonly exclude?: readonly Cue[];
}

const RAW_CLAUSE_TYPES = [
  // ─── Formation & parties ──────────────────────────────────────────────────────────────────
  {
    id: 'parties',
    label: 'Parties',
    group: 'formation',
    priority: false,
    derivedFrom: [AST, HUD, MTA],
    caption: ['parties', 'the parties'],
    // Naming a party is not the same as *being* the parties clause, which is the whole reason
    // `landlord` and `tenant` are support rather than cues.
    cues: [
      'is made between',
      'made and entered into between',
      'entered into between',
      'by and between',
      'between the {landlord} and',
      'hereinafter referred to as',
      'hereinafter called',
      'name and address of the {landlord}',
      'name and address of the {tenant}',
    ],
    support: ['{landlord}', '{tenant}', 'guarantor', 'schedule'],
  },
  {
    id: 'premises',
    label: 'The property',
    group: 'formation',
    priority: false,
    derivedFrom: [AST, HUD, MTA],
    caption: [
      'premises',
      'the property',
      'property',
      'the flat',
      'description of the premises',
      'schedule of the property',
    ],
    // A premises clause *describes* the property: where it is, what it is known as, or that it is
    // being let. Every cue here does one of those.
    cues: [
      'the property at',
      'premises known as',
      'premises more particularly described',
      ['{premises}', 'situated at'],
      ['{premises}', 'located at'],
      ['{landlord}', 'lets the', '{premises}'],
      ['{landlord}', 'leases the', '{premises}'],
    ],
    // "The scheduled premises", "the demised premises" and, in a US lease, "the dwelling unit" or
    // "the apartment unit" are the name the *whole document* uses for the property — a preamble
    // saying the act "governs the apartment unit" names it without describing it. A name every
    // clause repeats says nothing about any one clause, so they corroborate and never make one.
    support: [
      '{premises}',
      'demised premises',
      'scheduled premises',
      'dwelling unit',
      'apartment unit',
      'address',
      'situated',
    ],
  },
  {
    id: 'recitals',
    label: 'Recitals',
    group: 'formation',
    priority: false,
    derivedFrom: [MTA],
    caption: ['recitals', 'preamble', 'background', 'whereas'],
    // A preamble states where and how the document comes into being. These are the phrases that
    // do that job; the bare document title is not one of them, which is why a title-only clause
    // still types as nothing.
    cues: [
      'whereas',
      'now therefore',
      'witnesseth',
      'this {agreement} is executed',
      'is executed on',
      'is entered into on',
      'is granted under',
      'is governed by',
      'county of',
      'in consideration of the mutual',
    ],
    support: ['state of', 'district of', 'executed', 'this {agreement}'],
  },
  {
    id: 'definitions',
    label: 'Definitions',
    group: 'formation',
    priority: false,
    derivedFrom: [AST, URLTA],
    caption: ['definitions', 'interpretation'],
    cues: [
      'shall mean',
      'means and includes',
      'shall have the meaning',
      'for the purposes of this {agreement}',
      'in this {agreement}, unless',
      'the following expressions',
    ],
    support: ['defined', 'meaning'],
  },
  {
    id: 'guarantor',
    label: 'Guarantor or co-signer',
    group: 'formation',
    priority: false,
    derivedFrom: [AST],
    caption: ['guarantor', 'surety', 'co-signer'],
    cues: ['guarantor', 'surety', 'co-signer', 'cosigner', 'indemnifier'],
    support: ['guarantee', 'jointly and severally'],
  },
  {
    id: 'registration',
    label: 'Registration and stamp duty',
    group: 'formation',
    priority: false,
    derivedFrom: [MTA],
    caption: ['registration', 'stamp duty'],
    cues: [
      'stamp duty',
      'stamp paper',
      'sub-registrar',
      'registration act',
      'registered with the sub-registrar',
      'shall be registered',
      'notarised',
      'notarized',
      'franking',
    ],
    support: ['registration', 'registered'],
  },

  // ─── Term ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'term-duration',
    label: 'Length of the tenancy',
    group: 'term',
    priority: false,
    derivedFrom: [AST, HUD, MTA, URLTA],
    // `period` is deliberately absent: it would claim "LOCK-IN PERIOD" for this type.
    caption: ['term', 'duration', 'tenancy period', 'lease term', 'term of the tenancy'],
    cues: [
      'for a period of',
      'period of tenancy',
      'tenancy period',
      'for a term of',
      'for a fixed term of',
      'granted for a period',
      ['{agreement}', 'runs for'],
      ['{agreement}', 'is granted for'],
      ['{agreement}', 'shall be for a period'],
      'eleven months',
      '11 months',
    ],
    support: ['months', 'duration', 'expiry'],
  },
  {
    id: 'commencement',
    label: 'Start date and possession',
    group: 'term',
    priority: false,
    derivedFrom: [AST, HUD],
    caption: [
      'commencement',
      'start date',
      'effective date',
      'handover',
      'possession and handover',
    ],
    // A start date is usually stated inside the term clause rather than in a clause of its own, so
    // these read the tenancy (or its term) as the subject of a start verb, or a duration running
    // "from" a calendar date. The subject is what keeps "rent increases starting from the second
    // year" and "refund within two months from vacating" out.
    cues: [
      'shall commence on',
      'shall begin on',
      'shall start on',
      'commencing on',
      'commencing from',
      'with effect from',
      ['{agreement}', 'commencing'],
      ['{agreement}', 'commences'],
      ['{agreement}', 'begins'],
      ['{agreement}', 'starts on'],
      ['term', 'commencing'],
      ['term', 'commences'],
      ['term', 'begins'],
      ['term', 'starts on'],
      ['{agreement}', 'months from', '{month}'],
      ['{agreement}', 'year from', '{month}'],
      ['{agreement}', 'years from', '{month}'],
      'delivery of possession',
      'possession shall be handed',
      'handover of the {premises}',
      'vacant possession shall be given',
    ],
    // "Possession" in an English lease usually means the landlord taking it back, not the tenant
    // being given it, and reading it the wrong way is how a section 21 clause became a start-date.
    exclude: ['recover possession', 'recovery of possession', 'repossess', 'section 21'],
    support: ['commencement', 'possession', 'effective'],
  },
  {
    id: 'renewal',
    label: 'Renewal and auto-renewal',
    group: 'term',
    priority: true,
    derivedFrom: [MTA, HUD],
    caption: ['renewal', 'extension', 'renewal and extension'],
    // A renewal clause grants, refuses or describes the renewal itself. "On renewal of this
    // agreement" is the *time* at which some other term applies — a fee increase, a stamp duty, a
    // brokerage — so it corroborates and never types on its own.
    cues: [
      'automatically renew',
      'auto-renew',
      'shall stand renewed',
      'renewed for a further',
      'may be renewed',
      'shall be renewed',
      'option to renew',
      'right to renew',
      'renew this {agreement}',
      'renewable for',
      'shall be renewable',
      'extend the term',
    ],
    support: ['renewal', 'renewed', 'extension', 'renewal of this {agreement}', 'on renewal'],
  },
  {
    id: 'lock-in',
    label: 'Lock-in period',
    group: 'term',
    priority: true,
    derivedFrom: [MTA],
    caption: ['lock-in', 'lock-in period', 'lock in period', 'lockin', 'minimum term'],
    cues: [
      'lock-in period',
      'lock in period',
      'lockin period',
      'lock-in',
      'minimum term',
      'minimum period',
      'no-exit',
      'shall not vacate before',
      'mandatory period',
    ],
    support: ['months', 'forfeited'],
  },
  {
    id: 'holdover',
    label: 'Staying past the end date',
    group: 'term',
    priority: false,
    derivedFrom: [URLTA, HUD],
    caption: ['holdover', 'hold over', 'overstay'],
    cues: [
      'holdover',
      'hold over',
      'overstay',
      'continues in occupation',
      'double rent',
      'remains in possession after',
      'continues to occupy after',
    ],
    support: ['after the expiry', 'beyond the term'],
  },

  // ─── Money ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'rent',
    label: 'Rent',
    group: 'money',
    priority: false,
    derivedFrom: [AST, HUD, MTA, URLTA],
    caption: ['rent', 'monthly rent', 'licence fee', 'license fee', 'rent and deposit'],
    // `{rent}` covers the licence fee, so both dialects follow one rule: the payment named with its
    // figure or its obligation is a cue, the bare name is not. A bare "licence fee" used to type a
    // deposit clause measured in it ("being three months licence fee") and an escalation clause
    // that raises it, where the bare word "rent" in the same positions typed neither.
    cues: [
      'monthly {rent}',
      '{rent} of',
      'shall pay {rent}',
      '{rent} shall be paid',
      '{rent} is payable',
      'payable in advance',
      'as {rent}',
    ],
    support: ['rent', 'licence fee', 'license fee', 'per month', 'each month', 'compensation'],
  },
  {
    id: 'rent-escalation',
    label: 'Rent increases',
    group: 'money',
    priority: false,
    derivedFrom: [MTA],
    caption: ['escalation', 'rent escalation', 'rent revision', 'rent review', 'increase in rent'],
    cues: [
      'escalation',
      'increase in rent',
      'rent revision',
      'rent review',
      'shall be increased',
      'shall be enhanced',
      'enhanced by',
      'increment of',
      'increased by',
    ],
    support: ['per cent', 'annually', 'renewal'],
  },
  {
    id: 'security-deposit',
    label: 'Security deposit',
    group: 'money',
    priority: true,
    derivedFrom: [AST, HUD, MTA, URLTA],
    caption: ['security deposit', 'deposit', 'caution deposit', 'caution money'],
    // The bare name "security deposit" is support: "the entire security deposit shall stand
    // forfeited" names the deposit in a lock-in clause without taking one. The deposit is set by
    // its figure or by the payment that lodges it.
    cues: [
      'caution deposit',
      'caution money',
      'interest free deposit',
      'interest free security deposit',
      'tenancy deposit',
      'refundable deposit',
      'advance amount',
      'deposit of',
      'deposit equal to',
      'deposit equivalent to',
      'deposit amounting to',
      'pay a security deposit',
      'paid a security deposit',
      'pay a deposit',
      'paid a deposit',
      'pagdi',
    ],
    support: ['security deposit', 'deposit', 'bond', 'refund', 'returned'],
  },
  {
    id: 'deposit-deductions',
    label: 'Deductions from the deposit',
    group: 'money',
    priority: false,
    derivedFrom: [MTA, URLTA],
    caption: ['deductions', 'deduction', 'forfeiture of deposit'],
    // What is non-refundable has to be the *deposit*: "an administration fee … is non-refundable"
    // is a fee term. So refusal-to-refund cues are sequences that need the deposit earlier in the
    // same sentence, and the return-less-deductions drafting ("return the deposit … less any amount
    // owed") is read the same way.
    cues: [
      'deduct from the deposit',
      'deducted from the deposit',
      'deductions from the deposit',
      'forfeit the deposit',
      'deposit shall stand forfeited',
      'deposit shall be forfeited',
      'adjust against the deposit',
      'adjusted against the deposit',
      'account of any deduction',
      'account of any deductions',
      'statement of deductions',
      'itemised statement',
      'itemized statement',
      ['deduct', 'deposit'],
      ['deposit', 'less any'],
      ['deposit', 'after deducting'],
      ['deposit', 'non-refundable'],
      ['non-refundable', 'deposit'],
      ['deposit', 'shall not be refunded'],
    ],
    support: [
      'deduction',
      'deductions',
      'forfeited',
      'deposit',
      'non-refundable',
      'shall not be refunded',
    ],
  },
  {
    id: 'late-fee',
    label: 'Late payment charges',
    group: 'money',
    priority: true,
    derivedFrom: [HUD, URLTA],
    caption: [
      'late fee',
      'late charge',
      'late payment',
      'late rent',
      'penalty',
      'default interest',
      'interest on arrears',
    ],
    cues: [
      'late fee',
      'late charge',
      'penal interest',
      'penalty interest',
      'interest on arrears',
      'default interest',
      'per day for delay',
      'per day of delay',
      'for each day of delay',
      'charged on rent',
      'interest at',
      'days late',
      'falls due',
      'in arrears',
    ],
    support: ['interest', 'delay', 'per cent', 'per day'],
    // A deposit that carries no interest is not a late-payment charge.
    exclude: ['interest free'],
  },
  {
    id: 'utilities',
    label: 'Utilities',
    group: 'money',
    priority: false,
    derivedFrom: [AST, HUD, MTA],
    caption: ['utilities', 'utility charges', 'electricity and water'],
    cues: [
      'utilities',
      'utility bills',
      'utility charges',
      'meter reading',
      'water charges',
      'electricity charges',
      'electricity bill',
      'gas bill',
      'internet charges',
      'separately metered',
    ],
    support: ['electricity', 'gas', 'water', 'internet'],
  },
  {
    id: 'maintenance-charges',
    label: 'Maintenance and society charges',
    group: 'money',
    priority: false,
    derivedFrom: [MTA],
    caption: [
      'maintenance charges',
      'society charges',
      'service charge',
      'cam charges',
      'common area maintenance',
    ],
    cues: [
      'maintenance charges',
      'society charges',
      'common area maintenance',
      'cam charges',
      'service charge',
      'association dues',
      'monthly maintenance',
    ],
    support: ['society', 'association', 'common areas'],
  },
  {
    id: 'taxes-and-fees',
    label: 'Taxes, brokerage and other fees',
    group: 'money',
    priority: false,
    derivedFrom: [MTA, AST],
    caption: ['taxes', 'taxes and fees', 'brokerage', 'administration fee', 'fees'],
    cues: [
      'property tax',
      'municipal tax',
      'brokerage',
      'broker commission',
      'administration fee',
      'administrative fee',
      'processing fee',
      'application fee',
      'renewal fee',
    ],
    support: ['fee', 'payable', 'charge'],
  },

  // ─── Condition & repair ───────────────────────────────────────────────────────────────────
  {
    id: 'landlord-repairs',
    label: 'Landlord repair duties',
    group: 'condition',
    priority: false,
    derivedFrom: [AST, MTA, URLTA],
    // Bare "REPAIRS" is not a caption cue for either side: the caption alone never says who pays.
    caption: [
      'landlord repair',
      'landlord repairs',
      'repairs by the landlord',
      'landlord obligations',
    ],
    cues: [
      '{landlord} shall maintain',
      '{landlord} shall repair',
      '{landlord} shall keep',
      '{landlord} shall be responsible for',
      '{landlord} is responsible for',
      '{landlord} shall carry out',
      'keep in repair',
      'kept in repair',
    ],
    support: ['structural repairs', 'structure and exterior', 'installations'],
  },
  {
    id: 'tenant-repairs',
    label: 'Tenant repair duties',
    group: 'condition',
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
    caption: ['tenant repair', 'tenant repairs', 'repairs by the tenant', 'tenant obligations'],
    cues: [
      '{tenant} shall maintain',
      '{tenant} shall repair',
      '{tenant} shall keep',
      '{tenant} shall be responsible for',
      '{tenant} is responsible for',
      'responsible for all repairs',
      'at the {tenant} own cost',
      'at the {tenant} cost',
      'day-to-day repairs',
      'day to day repairs',
      'minor repairs',
    ],
    support: ['repairs', 'wear and tear', 'structural repairs', 'own cost'],
  },
  {
    id: 'habitability',
    label: 'Fitness and habitability',
    group: 'condition',
    priority: false,
    derivedFrom: [URLTA],
    caption: ['habitability', 'condition of premises', 'condition of the premises', 'fitness'],
    cues: [
      'habitable',
      'habitability',
      'fit for human habitation',
      'fit for purpose',
      'as-is',
      'as is condition',
      'as-is condition',
      'warranty of habitability',
      'present condition',
      'accepts the {premises}',
    ],
    support: ['condition', 'defects'],
  },
  {
    id: 'inventory-condition',
    label: 'Inventory and condition schedule',
    group: 'condition',
    priority: false,
    derivedFrom: [AST, MTA],
    caption: ['inventory', 'schedule of condition', 'fixtures and fittings', 'check-in report'],
    cues: [
      'schedule of condition',
      'fixtures and fittings',
      'check-in report',
      'inventory of',
      'list of items',
      'annexure',
    ],
    support: ['inventory', 'schedule', 'items'],
  },
  {
    id: 'inspection-entry',
    label: 'Landlord entry and inspection',
    group: 'condition',
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
    caption: ['entry', 'inspection', 'entry and inspection', 'right of entry', 'access'],
    // Every cue here names *entering*. `'at any time'` is support, and support cannot type a
    // clause: that one move is what stops a termination clause being read as an entry clause.
    cues: [
      'right to enter',
      'right of entry',
      'may enter',
      'shall enter',
      'enter the {premises}',
      'enter the scheduled premises',
      'enter the demised premises',
      'entry to the {premises}',
      'entry into the {premises}',
      'inspect the {premises}',
      'inspect the scheduled premises',
      'inspect the same',
      'access to the {premises}',
      'before entering',
      'upon entering',
      'prior to entering',
    ],
    support: ['at any time', 'without prior notice', 'unannounced', 'inspection', 'emergency'],
  },

  // ─── Use & control ────────────────────────────────────────────────────────────────────────
  {
    id: 'permitted-use',
    label: 'What the property may be used for',
    group: 'use',
    priority: false,
    derivedFrom: [AST, MTA, HUD],
    caption: ['permitted use', 'use of the premises', 'purpose', 'use'],
    cues: [
      'permitted use',
      'residential purpose',
      'residential purposes',
      'shall be used only',
      'shall be used solely',
      'used solely for',
      'purpose of the tenancy',
      'commercial use',
      'as a private home',
    ],
    support: ['purpose', 'use'],
  },
  {
    id: 'occupancy-limits',
    label: 'Who may live there',
    group: 'use',
    priority: false,
    derivedFrom: [HUD, AST],
    caption: ['occupancy', 'occupants', 'residents'],
    cues: [
      'number of persons',
      'no other person shall reside',
      'shall be occupied only by',
      'occupied only by',
      'shall not be permitted to reside',
      'occupants',
      'guests',
      'visitors',
    ],
    support: ['reside', 'family', 'persons'],
  },
  {
    id: 'subletting-assignment',
    label: 'Subletting and assignment',
    group: 'use',
    priority: false,
    derivedFrom: [AST, MTA, URLTA],
    caption: ['subletting', 'assignment', 'sublet', 'subletting and assignment'],
    cues: [
      'sublet',
      'sub-let',
      'subletting',
      'assignment',
      'assign',
      'part with possession',
      'transfer the tenancy',
      'underlet',
    ],
    support: ['third party', 'consent'],
  },
  {
    id: 'alterations',
    label: 'Alterations and decoration',
    group: 'use',
    priority: false,
    derivedFrom: [AST, HUD],
    caption: ['alterations', 'additions', 'alterations and additions', 'decoration'],
    cues: [
      'alterations',
      'alteration',
      'structural changes',
      'nails in the wall',
      'redecorate',
      'shall not alter',
      'additions or alterations',
    ],
    support: ['consent', 'written permission'],
  },
  {
    id: 'pets',
    label: 'Pets',
    group: 'use',
    priority: false,
    derivedFrom: [AST, HUD],
    caption: ['pets', 'animals'],
    cues: ['pets', 'pet', 'no animals', 'keep any animal', 'keep a dog', 'dog', 'cat'],
    support: ['permission', 'consent'],
  },
  {
    id: 'quiet-enjoyment',
    label: 'Quiet enjoyment',
    group: 'use',
    priority: false,
    derivedFrom: [AST, MTA],
    caption: ['quiet enjoyment', 'peaceful possession'],
    cues: [
      'quiet enjoyment',
      'peaceful possession',
      'peacefully without interruption',
      'without interruption',
      'peaceful and quiet',
      'peaceably',
    ],
    support: ['peacefully', 'undisturbed'],
  },
  {
    id: 'rules-and-regulations',
    label: 'House rules',
    group: 'use',
    priority: false,
    derivedFrom: [HUD, URLTA],
    caption: ['house rules', 'rules and regulations', 'building rules', 'society rules'],
    cues: [
      'rules and regulations',
      'house rules',
      'society bye-laws',
      'bye-laws',
      'byelaws',
      'building rules',
      'as amended from time to time',
    ],
    support: ['rules', 'society'],
  },

  // ─── Risk, liability & remedies ───────────────────────────────────────────────────────────
  {
    id: 'termination-landlord',
    label: 'Landlord ending the tenancy',
    group: 'risk',
    priority: true,
    derivedFrom: [AST, MTA, URLTA, HUD],
    caption: ['termination', 'possession', 'default', 'termination by the landlord'],
    cues: [
      '{landlord} may terminate',
      '{landlord} shall be entitled to terminate',
      '{landlord} may determine',
      '{landlord} may revoke',
      '{landlord} may end',
      ['{landlord}', 'end this {agreement}'],
      ['{landlord}', 'end this tenancy'],
      ['{landlord}', 'terminate this {agreement}'],
      'either party may terminate',
      'either party may end',
      'recover possession',
      'recovery of possession',
      'vacate the {premises} within',
    ],
    // "At the sole discretion of the landlord" describes one-sided power, not the ending of a
    // tenancy — it appears just as often in a rent-escalation clause — so it corroborates and
    // never types on its own.
    support: [
      'terminate',
      'termination',
      'without assigning any reason',
      'at the sole discretion of the {landlord}',
    ],
  },
  {
    id: 'termination-tenant',
    label: 'Tenant ending the tenancy',
    group: 'risk',
    priority: false,
    derivedFrom: [MTA, URLTA],
    caption: ['termination', 'termination by the tenant', 'notice by the tenant'],
    // The sequence cues are what make this type reachable at all. A tenant's right to leave is
    // almost never drafted as "the tenant may terminate"; it is drafted as "the tenant shall give
    // ninety days notice", subject first.
    cues: [
      '{tenant} may terminate',
      '{tenant} may vacate',
      '{tenant} may end',
      'notice by the {tenant}',
      'either party may terminate',
      'either party may end',
      ['{tenant}', 'notice to terminate'],
      ['{tenant}', 'end this tenancy'],
      ['{tenant}', 'end this {agreement}'],
      ['{tenant}', 'shall give', 'notice'],
      ['{tenant}', 'must give', 'notice'],
      ['{tenant}', 'may give', 'notice'],
    ],
    support: ['terminate', 'notice', 'vacate'],
    // A forfeiture-on-early-exit clause is about the lock-in, not about a right to leave.
    exclude: ['lock-in period', 'lock in period'],
  },
  {
    id: 'notice-periods',
    label: 'Notice periods',
    group: 'risk',
    priority: true,
    derivedFrom: [AST, MTA, URLTA, HUD],
    caption: ['notice', 'notice period', 'notice periods'],
    // `'written notice'` is deliberately absent: "twenty-four hours written notice before
    // entering" is an entry clause, and treating it as a notice-period clause is the mirror image
    // of the bug this taxonomy was rewritten to fix. The bare name "the notice period" is support
    // for the same reason: text that only refers to it ("do not mention the notice period") sets
    // no period. Stated with its length, it is a cue. `{days} {notice}` reads the length in every
    // spelling a drafter uses: "seven days notice", "30 days' notice", "one month’s notice", "two
    // weeks' written notice".
    cues: [
      'notice period of',
      'period of notice',
      ['notice period', 'days'],
      ['notice period', 'weeks'],
      ['notice period', 'month'],
      ['notice period', 'months'],
      '{days} {notice}',
      'notice to quit',
      'notice to terminate',
      ['serving', 'notice'],
      ['serve', 'notice'],
      ['service of', 'notice'],
      ['upon giving', 'notice'],
    ],
    support: ['notice', 'written', 'days', 'months', 'notice period', 'notice periods'],
    // Notice before entry, stated in days rather than hours, is still an entry term. These are
    // sequences, so they only rule the type out when the entry and the notice share a sentence.
    exclude: [
      ['{days} {notice}', 'before entering'],
      ['{days} {notice}', 'prior to entering'],
      ['may enter', '{days} {notice}'],
    ],
  },
  {
    id: 'default-remedies',
    label: 'What happens on breach',
    group: 'risk',
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
    caption: ['default', 'breach', 'remedies', 'default and remedies'],
    cues: [
      'forfeiture',
      'forfeit',
      're-enter',
      'reenter',
      're-entry',
      'lock the {premises}',
      'lock out',
      'disconnect',
      'cut off supply',
      'cut off the supply',
      'eviction',
      'evict',
      'on any breach',
      'in the event of default',
    ],
    support: ['breach', 'default', 'remedy'],
  },
  {
    id: 'indemnity-exculpation',
    label: 'Indemnity and limits on liability',
    group: 'risk',
    priority: false,
    derivedFrom: [URLTA, HUD],
    caption: ['indemnity', 'limitation of liability', 'liability', 'exculpation'],
    cues: [
      'indemnify',
      'indemnity',
      'keep indemnified',
      'hold harmless',
      'shall not be liable',
      'not be responsible for any loss',
      'at the {tenant} own risk',
      'exculpate',
      'without any liability',
    ],
    support: ['liable', 'liability', 'claims', 'losses'],
  },
  {
    id: 'dispute-resolution',
    label: 'Disputes, arbitration and costs',
    group: 'risk',
    priority: true,
    derivedFrom: [URLTA, HUD],
    caption: [
      'disputes',
      'dispute resolution',
      'arbitration',
      'legal costs',
      'attorney fees',
      'governing law',
      'jurisdiction',
    ],
    cues: [
      'arbitration',
      'arbitrator',
      'binding arbitration',
      'jurisdiction of the courts',
      'governing law',
      'attorney fees',
      "attorney's fees",
      'advocate fee',
      'advocate fees',
      'legal costs',
      'costs of litigation',
      'class action',
      'jury trial',
      'waive the right to a jury',
      'court or tribunal',
    ],
    support: ['dispute', 'disputes', 'costs', 'court'],
  },
  {
    id: 'waiver-of-rights',
    label: 'Waiver of legal rights',
    group: 'risk',
    priority: true,
    derivedFrom: [URLTA],
    caption: ['waiver', 'waiver of rights', 'waiver of legal rights', 'confession of judgment'],
    cues: [
      'waives the right',
      'waive the right',
      'waives any',
      'waives all rights',
      'waive',
      'waives',
      'waiver',
      'waived',
      'relinquish',
      // Contracting out of the law by overriding it: "notwithstanding anything contained in any
      // law for the time being in force". The sequence needs "in any law" after the override, so
      // "notwithstanding anything in this agreement" — an ordinary internal priority rule — is not
      // a waiver.
      'notwithstanding any law',
      'notwithstanding any other law',
      'notwithstanding any statute',
      ['notwithstanding anything', 'in any law'],
      ['notwithstanding anything', 'in any other law'],
      ['notwithstanding anything', 'in any statute'],
      'confession of judgment',
      'consent to judgment',
      'gives up any right',
    ],
    // What is given up: a warranty ("waives the implied warranty of habitability"), a statutory
    // protection or the benefit of a law is as much a legal right as one called a "right".
    support: [
      'right',
      'rights',
      'remedies',
      'statute',
      'warranty',
      'warranties',
      'implied',
      'protection',
      'benefit of',
    ],
    // The non-waiver boilerplate: letting a breach pass, or enforcing a term late, does not give
    // the right up. It names a waiver only to deny one, it binds both parties, and it is in nearly
    // every lease. "Shall be deemed a waiver" with no negation is left alone, because a deemed
    // waiver ("failure to report a defect within seven days shall be deemed a waiver of all
    // claims") is a tenant losing a right.
    exclude: [
      'no waiver',
      'waiver of any subsequent',
      'waiver of a subsequent',
      'waiver of any succeeding',
      'continuing waiver',
      'not a waiver',
      'not be a waiver',
      'not be {deemed} a waiver',
      'not to be {deemed} a waiver',
      'not be {deemed} to have waived',
      'not constitute a waiver',
      'not operate as a waiver',
      'not amount to a waiver',
      'not waive',
      ['no failure', 'waiver'],
      ['no delay', 'waiver'],
      ['no forbearance', 'waiver'],
    ],
  },
] as const satisfies readonly RawRow[];

export type ClauseTypeId = (typeof RAW_CLAUSE_TYPES)[number]['id'];

const ROLE_ENTRIES: readonly (readonly [string, readonly string[]])[] = Object.entries(ROLE_WORDS);

/**
 * A phrase with every role placeholder expanded, one entry per dialect.
 *
 * `'{tenant} shall repair'` becomes three phrases, not one with a `{tenant}` still in it. A flat
 * list is matched literally by everything that reads it, so a placeholder left in place is a cue
 * that can never fire — and the amount or clause it was meant to name simply goes unfound.
 */
function expandRoles(phrase: string): readonly string[] {
  let out: readonly string[] = [phrase];
  for (const [token, words] of ROLE_ENTRIES) {
    out = out.flatMap((text) =>
      text.includes(token) ? words.map((word) => text.split(token).join(word)) : [text],
    );
  }
  return out;
}

/** Every literal phrase a cue stands for. A sequence reads as its phrases joined. */
function cueTexts(cue: Cue): readonly string[] {
  return expandRoles(typeof cue === 'string' ? cue : cue.join(' '));
}

/**
 * The flat synonym list, derived rather than authored.
 *
 * `analyse/facts.ts` reads `clauseType('rent').synonyms` and `clauseType('security-deposit')
 * .synonyms` to attribute amounts, so the flat list has to stay true. Deriving it from the three
 * evidence columns keeps one source of drafting vocabulary: add a word for a deposit once, and
 * both clause typing and amount attribution pick it up.
 */
function toRow(raw: RawRow): ClauseTypeRow {
  const synonyms = [
    ...new Set([
      ...raw.caption.flatMap(expandRoles),
      ...raw.cues.flatMap(cueTexts),
      ...raw.support.flatMap(expandRoles),
    ]),
  ];
  return {
    id: raw.id,
    label: raw.label,
    group: raw.group,
    priority: raw.priority,
    derivedFrom: raw.derivedFrom,
    caption: raw.caption,
    cues: raw.cues,
    support: raw.support,
    exclude: raw.exclude ?? [],
    synonyms,
  };
}

export const CLAUSE_TYPES: readonly ClauseTypeRow[] = RAW_CLAUSE_TYPES.map(toRow);

const BY_ID = new Map<string, ClauseTypeRow>(CLAUSE_TYPES.map((t) => [t.id, t]));

export function clauseType(id: ClauseTypeId): ClauseTypeRow {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown clause type: ${id}`);
  return found;
}

export function clauseTypeLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export const CLAUSE_GROUP_ORDER: readonly ClauseGroup[] = [
  'formation',
  'term',
  'money',
  'condition',
  'use',
  'risk',
] as const;

export const CLAUSE_GROUP_LABELS: Readonly<Record<ClauseGroup, string>> = {
  formation: 'Who and what',
  term: 'How long',
  money: 'Money',
  condition: 'Condition and repairs',
  use: 'Living there',
  risk: 'Risk and remedies',
};

/** The ten types a tenant is most exposed to. Depth here beats breadth across all 38. */
export const PRIORITY_CLAUSE_TYPES: readonly ClauseType[] = CLAUSE_TYPES.filter((t) => t.priority);
