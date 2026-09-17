import { describe, expect, it } from 'vitest';
import { clauseType } from '../domain/clause-types.ts';
import type { Clause } from '../domain/types.ts';
import { detectClauseTypes } from './detect.ts';
import { extractFacts, extractNotices } from './facts.ts';

/**
 * Held-out phrasings for the taxonomy rows tuned against the golden set.
 *
 * The golden-set scorecard in `test/golden.test.ts` measures clause typing on seven leases, and every
 * cue added to fix a miss there is at risk of being a copy of one sentence rather than a drafting
 * pattern. None of the clauses below appears in `test/fixtures/leases.ts`: each type is checked
 * against wordings the rows were not tuned on, in both directions — drafting that sets the term must
 * type, and drafting that only *mentions* the subject must not.
 */

let nextId = 0;

function clause(text: string): Clause {
  nextId += 1;
  return {
    id: `h${nextId}`,
    path: [],
    headingTrail: [],
    heading: null,
    text,
    charStart: 0,
    charEnd: text.length,
    pageStart: 1,
    pageEnd: 1,
    level: 1,
  };
}

function typesOf(text: string): readonly string[] {
  return detectClauseTypes(clause(text)).typeIds;
}

describe('commencement: a start date stated for the tenancy', () => {
  it.each([
    ['a start verb with the lease as subject', 'This lease begins on the first day of May 2026.'],
    ['a numeric date after "term commences"', 'Term commences 01/05/2026 and runs for six months.'],
    [
      'a duration running from a calendar date',
      'The tenancy is granted for one year from 1 June 2026.',
    ],
    [
      'a term of years from a date in May',
      'The tenancy shall be for a term of two years from 1 May 2026.',
    ],
    [
      'the licence dialect with no preposition',
      'The licence commencing 15 August 2026 shall continue for eleven months.',
    ],
    ['"shall begin on"', 'The term of this lease shall begin on 1 March 2027.'],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('commencement');
  });

  it.each([
    [
      'a refund deadline counted from vacating, with the modal "may" after it',
      'The landlord shall refund the deposit within two months from the date the tenant vacates ' +
        'and may deduct unpaid rent.',
    ],
    [
      'a rent increase that starts in a later year',
      'The rent shall be increased by five per cent every year, starting from the second year.',
    ],
    [
      '"from" and a month name with no duration between them',
      'Any notice under this agreement from the landlord may be served by post in March.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('commencement');
  });
});

describe('deposit-deductions: what may be kept back from the deposit', () => {
  it.each([
    [
      'a deduction sequence with words between the verb and the deposit',
      'The landlord may deduct the cost of professional cleaning from the security deposit.',
    ],
    [
      'return less amounts owed',
      'The deposit will be returned within 30 days of move-out, less any unpaid rent and the cost ' +
        'of repairing damage.',
    ],
    ['a deposit declared non-refundable', 'The caution deposit is non-refundable.'],
    [
      'the itemized statement of what was withheld',
      'Within 21 days the landlord shall send the tenant an itemized statement of any amounts ' +
        'withheld.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('deposit-deductions');
  });

  it.each([
    [
      'a non-refundable fee in a different sentence from the deposit',
      'An application fee of 50 is non-refundable. The tenant shall pay a deposit of 1,000.',
    ],
    [
      "the tenant's repair-and-deduct remedy against rent",
      'The tenant may deduct the cost of urgent repairs from the next payment of rent.',
    ],
    [
      'a full refund of the deposit',
      'The landlord shall return the deposit in full within ten days after the tenancy ends.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('deposit-deductions');
  });
});

describe('waiver-of-rights: contracting out of the law', () => {
  it.each([
    [
      'an override of "any other law"',
      'Notwithstanding anything to the contrary contained in any other law, the licensee shall ' +
        'have no claim to tenancy rights.',
    ],
    [
      'an override of statute',
      'The tenant shall pay all municipal taxes, notwithstanding any statute placing them on the ' +
        'owner.',
    ],
    ['a waived implied warranty', 'Tenant waives the implied warranty of quiet enjoyment.'],
    [
      'a waived statutory protection',
      'The lessee waives the protection of any rent control ordinance.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('waiver-of-rights');
  });

  it.each([
    [
      'a savings clause preserving rights under the law',
      'Nothing in this agreement takes away any right the tenant has under any law for the time ' +
        'being in force.',
    ],
    [
      'an internal priority rule over the agreement itself',
      'Notwithstanding anything contained in this agreement, either party may end the tenancy by ' +
        'giving one month notice.',
    ],
    [
      'a landlord warranty given rather than waived',
      'The landlord warrants that the premises are fit for human habitation and in good repair.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('waiver-of-rights');
  });

  it.each([
    [
      'a breach let pass once',
      'No waiver of any breach shall be deemed a waiver of any subsequent breach or of any other ' +
        'right.',
    ],
    [
      'a provision not enforced',
      'Failure by either party to enforce any provision shall not constitute a waiver of its ' +
        'rights under this agreement.',
    ],
    [
      'rent accepted after a breach',
      "The landlord's acceptance of rent with knowledge of a breach shall not be construed as a " +
        "waiver of the landlord's rights.",
    ],
    [
      'a right exercised late',
      'No delay or omission by either party in exercising any right or remedy shall operate as a ' +
        'waiver of it.',
    ],
    [
      'the boilerplate under its own caption',
      '21. WAIVER. The waiver by either party of one breach is not to be treated as a waiver of ' +
        'any other breach.',
    ],
    [
      'the boilerplate under a title-case caption',
      '21. Waiver. No waiver of any term of this licence is effective unless made in writing.',
    ],
  ])('does not type the non-waiver boilerplate: %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('waiver-of-rights');
  });

  it.each([
    ['a right given up', 'The tenant waives any right to withhold rent while repairs are pending.'],
    ['a warranty given up', 'The lessee waives the implied warranty of habitability.'],
    [
      'the law overridden',
      'Notwithstanding anything contained in any law for the time being in force, the licensee ' +
        'shall vacate on demand.',
    ],
    [
      'a deemed waiver, which is not negated',
      "The tenant's failure to report a defect within seven days shall be deemed a waiver of all " +
        'rights and remedies in respect of it.',
    ],
  ])('still types a genuine waiver: %s', (_case, text) => {
    expect(typesOf(text)).toContain('waiver-of-rights');
  });
});

describe('rent: the licence fee follows the same evidence rule as rent', () => {
  it.each([
    [
      'a monthly licence fee with its figure',
      'The licensee shall pay a monthly licence fee of Rs. 30,000 on or before the seventh day.',
    ],
    ['a sum paid "as licence fee"', 'The lessee shall pay Rs. 18,000 per month as licence fee.'],
    [
      'the US spelling with its figure',
      'A license fee of $900 is due on the first day of each month.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('rent');
  });

  it.each([
    [
      'a deposit measured in months of licence fee',
      'The licensee shall pay a security deposit of Rs. 60,000, equal to two months licence fee.',
    ],
    [
      'an increase to the licence fee',
      'The licence fee shall be revised by ten per cent on each anniversary of this agreement.',
    ],
    [
      'a late-payment term on an unpaid licence fee',
      'If the licence fee remains unpaid after the tenth day, interest at 18 per cent per annum ' +
        'shall be charged.',
    ],
    [
      'an early-exit charge paid in licence fee',
      'LOCK-IN. If the licensee leaves before six months, the licensee shall pay the licence fee ' +
        'for the remaining months of the lock-in period.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('rent');
  });

  it('keeps a combined rent-and-deposit clause as both, which deposit fact extraction relies on', () => {
    const types = typesOf(
      '4. RENT AND DEPOSIT The lessee shall pay rent of 950 each month and a security deposit of ' +
        '1,900.',
    );
    expect(types).toContain('rent');
    expect(types).toContain('security-deposit');
  });

  it('types a title-case licence-fee caption as rent, and reads the fee from it', () => {
    // The bare name "licence fee" is support, so this clause is typed by its caption alone. Fact
    // extraction reads the rent only from clauses typed `rent`, so losing the caption loses the fee.
    const licence = clause('2. Licence Fee. The licensee shall pay Rs. 25,000 per month.');
    const typing = detectClauseTypes(licence);
    expect(typing.typeIds).toContain('rent');
    expect(typing.matchedOn).toBe('licence fee');

    const { facts } = extractFacts([licence], [typing]);
    expect(facts.rentAmount).toBe(25_000);
    expect(facts.currency).toBe('INR');
    expect(facts.rentPeriod).toBe('month');
  });

  it('still hands the licence-fee dialect to amount attribution', () => {
    // `facts.ts` attributes figures using the rent synonyms. Moving the bare name out of `cues` must
    // not drop it from that list.
    expect(clauseType('rent').synonyms).toEqual(
      expect.arrayContaining(['licence fee', 'license fee', 'licence fee of', 'as licence fee']),
    );
  });
});

describe('renewal: the renewal itself, not a term that applies at renewal', () => {
  it.each([
    [
      'a renewal by consent',
      'This agreement may be renewed for a further period of eleven months by mutual consent.',
    ],
    [
      "a tenant's option",
      'The tenant shall have an option to renew the lease for one further year on the same terms.',
    ],
    [
      'a renewable licence',
      'The licence is renewable for two further terms of eleven months each.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('renewal');
  });

  it.each([
    [
      'a charge payable on renewal',
      'Stamp duty and registration charges payable on renewal of this agreement shall be shared ' +
        'equally.',
    ],
    [
      'a rent revision on renewal',
      'The rent shall be revised upwards by five per cent on renewal.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('renewal');
  });
});

describe('premises: describing the property, not naming it', () => {
  it.each([
    [
      'a located-at description',
      'The landlord leases to the tenant the apartment unit located at 40 Elm Street.',
    ],
    [
      'a situated-at description with a verb between',
      'The flat is situated at 7 Canal Road, Pune.',
    ],
    [
      'a letting of the dwelling unit',
      'The lessor leases the dwelling unit at 22 Lake Road to the lessee.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('premises');
  });

  it.each([
    [
      'a preamble that names the unit the act governs',
      'State of Oregon, County of Lane. This lease governs the dwelling unit described below.',
    ],
    [
      'a tenant duty that names the unit',
      'The tenant shall keep the apartment unit clean, safe and sanitary.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('premises');
  });
});

describe('notice-periods: a period stated, not a period mentioned', () => {
  it.each([
    [
      'a notice period with its length after a verb',
      'The notice period for either party is two months.',
    ],
    ['"notice period of"', 'A notice period of thirty days applies to both parties.'],
    [
      '"period of notice"',
      'Either party may end the tenancy by giving a period of notice of not less than one month.',
    ],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('notice-periods');
  });

  it.each([
    ['a reference that sets no period', 'Nothing in this clause changes the notice period.'],
    [
      'an instruction about what to discuss',
      'The agent will explain the notice period and the deposit to the tenant before signing.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('notice-periods');
  });

  it.each([
    [
      "a month's notice, straight apostrophe",
      "The lessee may end the lease on one month's notice.",
      30,
    ],
    [
      'a month’s notice, curly apostrophe',
      'The lessee may end the lease on one month’s notice.',
      30,
    ],
    ["days' notice, straight apostrophe", "The owner may terminate on 30 days' notice.", 30],
    ['days’ notice, curly apostrophe', 'The owner may terminate on 30 days’ notice.', 30],
    ['days notice, no apostrophe', 'The licensee may vacate by giving seven days notice.', 7],
    [
      "weeks' written notice, straight apostrophe",
      "The tenant may quit on two weeks' written notice.",
      14,
    ],
    [
      'weeks’ written notice, curly apostrophe',
      'The tenant may quit on two weeks’ written notice.',
      14,
    ],
  ])('types and reads %s', (_case, text, days) => {
    expect(typesOf(text)).toContain('notice-periods');
    // Notice extraction reads every clause, typed or not; this pins that it reads the same spelling.
    expect(extractNotices([clause(text)]).map((notice) => notice.days)).toEqual([days]);
  });

  it.each([
    [
      'notice before entering stated in days',
      "The landlord shall give two days' written notice before entering the flat.",
    ],
    [
      'an entry right exercised on a day’s notice',
      'The owner may enter the apartment on one day’s notice to inspect it.',
    ],
  ])('keeps an entry term out of the notice-period bucket: %s', (_case, text) => {
    const types = typesOf(text);
    expect(types).toContain('inspection-entry');
    expect(types).not.toContain('notice-periods');
  });
});

describe('security-deposit: setting the deposit, not naming it', () => {
  it.each([
    ['a title-case caption', '5. Security Deposit. The licensee has lodged the amount in full.'],
    ['a caption in capitals', '5. SECURITY DEPOSIT The licensee has lodged the amount in full.'],
    [
      'a title-case caption whose line break was lost',
      '5. Security Deposit The licensee has lodged the amount in full.',
    ],
    [
      'the payment that lodges it',
      "The tenant shall pay a security deposit equal to one month's rent before moving in.",
    ],
    ['its size', 'A deposit equivalent to two months rent is held by the owner.'],
  ])('types %s', (_case, text) => {
    expect(typesOf(text)).toContain('security-deposit');
  });

  it.each([
    [
      'a lock-in forfeiture',
      'LOCK-IN. If the lessee leaves within six months, the whole security deposit stands forfeited.',
    ],
    [
      'an early-exit penalty under a title-case caption',
      'Early Exit. A licensee who leaves before the lock-in period ends loses the security deposit.',
    ],
  ])('does not type %s', (_case, text) => {
    expect(typesOf(text)).not.toContain('security-deposit');
  });
});
