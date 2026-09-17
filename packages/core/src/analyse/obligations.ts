import type { Clause, Party } from '../domain/types.ts';
import { splitSentences, truncateWords } from '../util/text.ts';
import { actingParty } from './facts.ts';

/**
 * The who-owes-what matrix.
 *
 * This is what a tenant actually needs, and it is the thing a lease makes hardest to see: the
 * obligations are scattered across twenty clauses, stated in the passive voice, with the
 * consequence in a different paragraph from the duty. Gathering them per party, with the deadline
 * and the consequence attached, is most of the value of reading the document for someone.
 *
 * It feeds the negotiation checklist and the obligations timeline directly, and it is computed
 * deterministically, so it survives having no model available.
 */

export interface ObligationDraft {
  readonly party: Party;
  /** What must be done, in the document's own words. */
  readonly what: string;
  /** When, where the clause says so. */
  readonly when: string | null;
  /** What happens if it is not done, where the clause says so. */
  readonly consequence: string | null;
  readonly clauseId: string;
  /** Verbatim, for verification. */
  readonly quote: string;
}

/** A duty, in the modal forms legal drafting actually uses. */
const DUTY =
  /\b(?:shall|must|is required to|are required to|agrees to|undertakes to|is responsible for|are responsible for|is liable to|has to|is to)\b/i;

/** A duty of the landlord phrased as a right of entry or a power, which is still an obligation matrix entry. */
const POWER = /\b(?:may|is entitled to|reserves the right to|shall be entitled to)\b/i;

const WHEN_PATTERNS: readonly RegExp[] = [
  /\bon or before the \w+(?:\s+\w+)? day of (?:each|every) month\b/i,
  // `[\w-]+`, not `\w+`: a hyphenated number — "at least twenty-four hours" — is how an entry or
  // notice deadline is most often written, and `\w+` stops at the hyphen and loses the deadline.
  /\bwithin [\w-]+(?:\s*\(\d+\))?\s*(?:days?|weeks?|months?|hours?)\b/i,
  /\bat least [\w-]+(?:\s*\(\d+\))?\s*(?:days?|weeks?|months?|hours?)\b/i,
  /\bby the \w+ day of\b/i,
  /\bon the (?:first|last|\d+(?:st|nd|rd|th)) day of (?:each|every|the) (?:month|year)\b/i,
  /\b(?:monthly|annually|quarterly|每)\b/i,
  /\bin advance\b/i,
  /\bbefore (?:the )?(?:commencement|expiry|handover|possession)\b/i,
  /\bupon (?:vacating|termination|expiry|handover)\b/i,
];

const CONSEQUENCE_PATTERNS: readonly RegExp[] = [
  /\bfailing which\b[^.]*/i,
  /\bin (?:the )?event of (?:any )?(?:default|breach|delay|non-payment)\b[^.]*/i,
  /\bif the \w+ fails\b[^.]*/i,
  /\bshall be liable\b[^.]*/i,
  /\bshall (?:stand )?forfeit(?:ed)?\b[^.]*/i,
  /\bshall be (?:deemed|treated as) a breach\b[^.]*/i,
  /\bshall pay (?:interest|a penalty|a late fee)\b[^.]*/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return match[0].trim();
  }
  return null;
}

/** How far ahead to look for a consequence stated in a following sentence. */
const CONSEQUENCE_LOOKAHEAD = 2;

export function extractObligations(clauses: readonly Clause[]): readonly ObligationDraft[] {
  const drafts: ObligationDraft[] = [];

  for (const clause of clauses) {
    const sentences = splitSentences(clause.text);

    sentences.forEach((sentence, index) => {
      const isDuty = DUTY.test(sentence);
      const isPower = POWER.test(sentence);
      if (!isDuty && !isPower) return;

      const party = actingParty(sentence);
      if (party === 'unknown') return;

      // A consequence often sits in the next sentence rather than this one, which is exactly why
      // obligations are hard to read off a lease by eye.
      const lookahead = sentences.slice(index, index + 1 + CONSEQUENCE_LOOKAHEAD).join(' ');

      drafts.push({
        party,
        what: truncateWords(sentence, 220),
        when: firstMatch(sentence, WHEN_PATTERNS),
        consequence: firstMatch(lookahead, CONSEQUENCE_PATTERNS),
        clauseId: clause.id,
        quote: sentence,
      });
    });
  }

  return drafts;
}

/** Group by party, so the reader sees their own column without reading the landlord's. */
export function obligationsByParty(
  drafts: readonly ObligationDraft[],
): Readonly<Record<Party, readonly ObligationDraft[]>> {
  return {
    tenant: drafts.filter((d) => d.party === 'tenant'),
    landlord: drafts.filter((d) => d.party === 'landlord'),
    both: drafts.filter((d) => d.party === 'both'),
    unknown: drafts.filter((d) => d.party === 'unknown'),
  };
}

/**
 * The obligations that carry a deadline, which are the ones that end up as calendar entries.
 */
export function datedObligations(drafts: readonly ObligationDraft[]): readonly ObligationDraft[] {
  return drafts.filter((draft) => draft.when !== null);
}

/**
 * The balance of duties between the parties.
 *
 * A jurisdiction-free structural reading: a document placing twenty duties on the tenant and three
 * on the landlord is one-sided on its face, and that is worth stating as a number rather than an
 * adjective.
 */
export function obligationBalance(drafts: readonly ObligationDraft[]): {
  readonly tenant: number;
  readonly landlord: number;
  readonly ratio: number | null;
} {
  const tenant = drafts.filter((d) => d.party === 'tenant').length;
  const landlord = drafts.filter((d) => d.party === 'landlord').length;
  return {
    tenant,
    landlord,
    ratio: landlord === 0 ? null : Math.round((tenant / landlord) * 10) / 10,
  };
}
