import type { ClauseGroup, ClauseType } from './types.ts';

/**
 * The 38 canonical clause types.
 *
 * Derived from four published model instruments rather than invented, so the taxonomy is
 * defensible: the gov.uk Model Agreement for an assured tenancy, HUD model lease form 90105-a,
 * the Model Tenancy Act 2021 (Chapters II-V and both Schedules), and URLTA (Articles I-V).
 *
 * `synonyms` matters far more than `label`. Nobody writes "inspection and entry" — they write
 * "right of access", "landlord's right to enter", or "inspection". Detection reads synonyms.
 */

const AST = 'gov.uk Model Agreement for an assured tenancy';
const HUD = 'HUD model lease 90105-a';
const MTA = 'Model Tenancy Act 2021, Chapters II-V';
const URLTA = 'URLTA Articles I-V';

export const CLAUSE_TYPES = [
  // ─── Formation & parties ──────────────────────────────────────────────────────────────────
  {
    id: 'parties',
    label: 'Parties',
    group: 'formation',
    synonyms: ['landlord', 'lessor', 'licensor', 'tenant', 'lessee', 'licensee', 'the parties', 'between'],
    priority: false,
    derivedFrom: [AST, HUD, MTA],
  },
  {
    id: 'premises',
    label: 'The property',
    group: 'formation',
    synonyms: ['premises', 'the property', 'demised premises', 'scheduled premises', 'dwelling unit', 'flat', 'apartment'],
    priority: false,
    derivedFrom: [AST, HUD, MTA],
  },
  {
    id: 'recitals',
    label: 'Recitals',
    group: 'formation',
    synonyms: ['whereas', 'recitals', 'preamble', 'background'],
    priority: false,
    derivedFrom: [MTA],
  },
  {
    id: 'definitions',
    label: 'Definitions',
    group: 'formation',
    synonyms: ['definitions', 'interpretation', 'in this agreement', 'shall mean'],
    priority: false,
    derivedFrom: [AST, URLTA],
  },
  {
    id: 'guarantor',
    label: 'Guarantor or co-signer',
    group: 'formation',
    synonyms: ['guarantor', 'surety', 'co-signer', 'cosigner', 'indemnifier'],
    priority: false,
    derivedFrom: [AST],
  },
  {
    id: 'registration',
    label: 'Registration and stamp duty',
    group: 'formation',
    synonyms: ['registration', 'stamp duty', 'registered with the sub-registrar', 'notarised', 'notarized', 'franking'],
    priority: false,
    derivedFrom: [MTA],
  },

  // ─── Term ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'term-duration',
    label: 'Length of the tenancy',
    group: 'term',
    synonyms: ['term', 'duration', 'period of tenancy', 'tenancy period', 'for a period of', 'eleven months', '11 months'],
    priority: false,
    derivedFrom: [AST, HUD, MTA, URLTA],
  },
  {
    id: 'commencement',
    label: 'Start date and possession',
    group: 'term',
    synonyms: ['commencement', 'commencing', 'start date', 'possession', 'handover', 'effective date'],
    priority: false,
    derivedFrom: [AST, HUD],
  },
  {
    id: 'renewal',
    label: 'Renewal and auto-renewal',
    group: 'term',
    synonyms: ['renewal', 'renew', 'extension', 'extend the term', 'automatically renew', 'auto-renew', 'shall stand renewed'],
    priority: true,
    derivedFrom: [MTA, HUD],
  },
  {
    id: 'lock-in',
    label: 'Lock-in period',
    group: 'term',
    synonyms: ['lock-in', 'lock in period', 'lockin', 'minimum term', 'minimum period', 'no-exit', 'shall not vacate before', 'mandatory period'],
    priority: true,
    derivedFrom: [MTA],
  },
  {
    id: 'holdover',
    label: 'Staying past the end date',
    group: 'term',
    synonyms: ['holdover', 'hold over', 'overstay', 'continues in occupation', 'double rent', 'remains in possession after'],
    priority: false,
    derivedFrom: [URLTA, HUD],
  },

  // ─── Money ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'rent',
    label: 'Rent',
    group: 'money',
    synonyms: ['rent', 'monthly rent', 'licence fee', 'license fee', 'compensation', 'payable in advance'],
    priority: false,
    derivedFrom: [AST, HUD, MTA, URLTA],
  },
  {
    id: 'rent-escalation',
    label: 'Rent increases',
    group: 'money',
    synonyms: ['escalation', 'increase in rent', 'rent revision', 'enhanced by', 'increment', 'rent review'],
    priority: false,
    derivedFrom: [MTA],
  },
  {
    id: 'security-deposit',
    label: 'Security deposit',
    group: 'money',
    synonyms: ['security deposit', 'deposit', 'caution deposit', 'caution money', 'bond', 'pagdi', 'advance amount', 'interest free deposit'],
    priority: true,
    derivedFrom: [AST, HUD, MTA, URLTA],
  },
  {
    id: 'deposit-deductions',
    label: 'Deductions from the deposit',
    group: 'money',
    synonyms: ['deduct from the deposit', 'forfeit the deposit', 'deductions', 'adjust against the deposit', 'non-refundable'],
    priority: false,
    derivedFrom: [MTA, URLTA],
  },
  {
    id: 'late-fee',
    label: 'Late payment charges',
    group: 'money',
    synonyms: ['late fee', 'late charge', 'penal interest', 'penalty interest', 'interest on arrears', 'default interest', 'per day for delay'],
    priority: true,
    derivedFrom: [HUD, URLTA],
  },
  {
    id: 'utilities',
    label: 'Utilities',
    group: 'money',
    synonyms: ['utilities', 'electricity', 'water charges', 'gas', 'internet', 'utility bills', 'meter reading'],
    priority: false,
    derivedFrom: [AST, HUD, MTA],
  },
  {
    id: 'maintenance-charges',
    label: 'Maintenance and society charges',
    group: 'money',
    synonyms: ['maintenance charges', 'society charges', 'common area maintenance', 'cam charges', 'service charge', 'association dues'],
    priority: false,
    derivedFrom: [MTA],
  },
  {
    id: 'taxes-and-fees',
    label: 'Taxes, brokerage and other fees',
    group: 'money',
    synonyms: ['property tax', 'municipal tax', 'brokerage', 'broker commission', 'administration fee', 'processing fee', 'application fee'],
    priority: false,
    derivedFrom: [MTA, AST],
  },

  // ─── Condition & repair ───────────────────────────────────────────────────────────────────
  {
    id: 'landlord-repairs',
    label: 'Landlord repair duties',
    group: 'condition',
    synonyms: ['landlord shall maintain', 'structural repairs', 'landlord shall repair', 'keep in repair', 'lessor shall maintain'],
    priority: false,
    derivedFrom: [AST, MTA, URLTA],
  },
  {
    id: 'tenant-repairs',
    label: 'Tenant repair duties',
    group: 'condition',
    synonyms: ['tenant shall maintain', 'tenant shall repair', 'at the tenant own cost', 'all repairs', 'day-to-day repairs', 'wear and tear', 'tenant is responsible for all'],
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
  },
  {
    id: 'habitability',
    label: 'Fitness and habitability',
    group: 'condition',
    synonyms: ['habitable', 'habitability', 'fit for human habitation', 'fit for purpose', 'as is', 'as-is condition', 'warranty of habitability'],
    priority: false,
    derivedFrom: [URLTA],
  },
  {
    id: 'inventory-condition',
    label: 'Inventory and condition schedule',
    group: 'condition',
    synonyms: ['inventory', 'schedule of condition', 'fixtures and fittings', 'annexure', 'list of items', 'check-in report'],
    priority: false,
    derivedFrom: [AST, MTA],
  },
  {
    id: 'inspection-entry',
    label: 'Landlord entry and inspection',
    group: 'condition',
    synonyms: ['right to enter', 'right of entry', 'inspection', 'inspect the premises', 'access to the premises', 'enter the premises', 'at any time'],
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
  },

  // ─── Use & control ────────────────────────────────────────────────────────────────────────
  {
    id: 'permitted-use',
    label: 'What the property may be used for',
    group: 'use',
    synonyms: ['permitted use', 'residential purpose', 'shall be used only', 'purpose of the tenancy', 'commercial use'],
    priority: false,
    derivedFrom: [AST, MTA, HUD],
  },
  {
    id: 'occupancy-limits',
    label: 'Who may live there',
    group: 'use',
    synonyms: ['occupancy', 'occupants', 'number of persons', 'guests', 'visitors', 'no other person shall reside'],
    priority: false,
    derivedFrom: [HUD, AST],
  },
  {
    id: 'subletting-assignment',
    label: 'Subletting and assignment',
    group: 'use',
    synonyms: ['sublet', 'sub-let', 'subletting', 'assignment', 'assign', 'part with possession', 'transfer the tenancy'],
    priority: false,
    derivedFrom: [AST, MTA, URLTA],
  },
  {
    id: 'alterations',
    label: 'Alterations and decoration',
    group: 'use',
    synonyms: ['alterations', 'additions', 'structural changes', 'nails in the wall', 'redecorate', 'no alteration'],
    priority: false,
    derivedFrom: [AST, HUD],
  },
  {
    id: 'pets',
    label: 'Pets',
    group: 'use',
    synonyms: ['pets', 'pet', 'animals', 'no animals', 'dog', 'cat'],
    priority: false,
    derivedFrom: [AST, HUD],
  },
  {
    id: 'quiet-enjoyment',
    label: 'Quiet enjoyment',
    group: 'use',
    synonyms: ['quiet enjoyment', 'peaceful possession', 'without interruption', 'peaceful and quiet'],
    priority: false,
    derivedFrom: [AST, MTA],
  },
  {
    id: 'rules-and-regulations',
    label: 'House rules',
    group: 'use',
    synonyms: ['rules and regulations', 'house rules', 'society bye-laws', 'byelaws', 'building rules', 'as amended from time to time'],
    priority: false,
    derivedFrom: [HUD, URLTA],
  },

  // ─── Risk, liability & remedies ───────────────────────────────────────────────────────────
  {
    id: 'termination-landlord',
    label: 'Landlord ending the tenancy',
    group: 'risk',
    synonyms: ['landlord may terminate', 'lessor may terminate', 'terminate this agreement', 'vacate the premises within', 'at the sole discretion of the landlord'],
    priority: true,
    derivedFrom: [AST, MTA, URLTA, HUD],
  },
  {
    id: 'termination-tenant',
    label: 'Tenant ending the tenancy',
    group: 'risk',
    synonyms: ['tenant may terminate', 'lessee may terminate', 'tenant may vacate', 'notice by the tenant'],
    priority: false,
    derivedFrom: [MTA, URLTA],
  },
  {
    id: 'notice-periods',
    label: 'Notice periods',
    group: 'risk',
    synonyms: ['notice period', 'prior written notice', 'days notice', 'months notice', 'upon giving notice', 'notice in writing'],
    priority: true,
    derivedFrom: [AST, MTA, URLTA, HUD],
  },
  {
    id: 'default-remedies',
    label: 'What happens on breach',
    group: 'risk',
    synonyms: ['default', 'breach', 'forfeiture', 'forfeit', 're-entry', 'reenter', 'lock the premises', 'disconnect', 'cut off supply', 'eviction'],
    priority: true,
    derivedFrom: [MTA, URLTA, HUD],
  },
  {
    id: 'indemnity-exculpation',
    label: 'Indemnity and limits on liability',
    group: 'risk',
    synonyms: ['indemnify', 'indemnity', 'hold harmless', 'shall not be liable', 'not be responsible for any loss', 'at the tenant own risk', 'exculpate'],
    priority: false,
    derivedFrom: [URLTA, HUD],
  },
  {
    id: 'dispute-resolution',
    label: 'Disputes, arbitration and costs',
    group: 'risk',
    synonyms: ['arbitration', 'arbitrator', 'jurisdiction of the courts', 'governing law', 'attorney fees', 'advocate fees', 'legal costs', 'class action', 'waive the right to a jury'],
    priority: true,
    derivedFrom: [URLTA, HUD],
  },
  {
    id: 'waiver-of-rights',
    label: 'Waiver of legal rights',
    group: 'risk',
    synonyms: ['waive', 'waiver', 'gives up', 'relinquish', 'notwithstanding any law', 'confession of judgment', 'consent to judgment', 'waives all rights'],
    priority: true,
    derivedFrom: [URLTA],
  },
] as const satisfies readonly ClauseType[];

export type ClauseTypeId = (typeof CLAUSE_TYPES)[number]['id'];

const BY_ID = new Map<string, ClauseType>(CLAUSE_TYPES.map((t) => [t.id, t]));

export function clauseType(id: ClauseTypeId): ClauseType {
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
