import { describe, expect, it } from 'vitest';
import { CLAUSE_TYPES, clauseTypeLabel, ROLE_WORDS } from '../domain/clause-types.ts';
import type { Clause } from '../domain/types.ts';
import {
  clauseCaption,
  clausesOfType,
  detectAllClauseTypes,
  detectClauseTypes,
  untypedShare,
} from './detect.ts';

/**
 * Clause typing.
 *
 * Every clause below is drafted here for the test rather than lifted from the golden set, so these
 * assertions say something about *drafting patterns* rather than about seven particular documents.
 * The golden leases are graded separately, end to end, in `test/golden.test.ts`.
 *
 * The cases are grouped by the defect they pin down, because each one is a bug that reached a
 * tenant's screen before it was a test.
 */

let nextId = 0;

/** A clause with the shape the segmenter produces: caption run into the body, no heading field. */
function clause(
  text: string,
  heading: string | null = null,
  trail: readonly string[] = [],
): Clause {
  nextId += 1;
  return {
    id: `t${nextId}`,
    path: [],
    headingTrail: trail,
    heading,
    text,
    charStart: 0,
    charEnd: text.length,
    pageStart: 1,
    pageEnd: 1,
    level: 1,
  };
}

function typesOf(text: string, heading?: string): readonly string[] {
  return detectClauseTypes(clause(text, heading ?? null)).typeIds;
}

describe('the entry detector', () => {
  // ─── Finding A: a termination clause typed as an entry clause ────────────────────────────────
  // `'at any time'` used to be a synonym of `inspection-entry`, so any clause containing the phrase
  // was typed as an entry clause. The fact extractor then recorded `entryNoticeHours: 0` and a
  // tenant was shown a medium-severity "the landlord may enter without advance notice" card
  // quoting a possession clause, on a lease that grants no right of entry at all.

  it('does not type a repossession clause as an entry clause', () => {
    const types = typesOf(
      '7. POSSESSION The landlord may recover possession by serving a notice at any time after ' +
        'the fixed term, without assigning any reason.',
    );
    expect(types).not.toContain('inspection-entry');
    expect(types).toContain('termination-landlord');
  });

  it('does not type a landlord termination clause as an entry clause', () => {
    const types = typesOf(
      '9. TERMINATION The licensor may terminate this agreement at any time without assigning any ' +
        'reason by giving seven days notice.',
    );
    expect(types).not.toContain('inspection-entry');
    expect(types).toContain('termination-landlord');
  });

  it('does not type a no-warning forfeiture clause as an entry clause', () => {
    const types = typesOf(
      '14. DEFAULT On breach the landlord may end the tenancy at any time with immediate effect ' +
        'and without notice.',
    );
    expect(types).not.toContain('inspection-entry');
  });

  // ─── Finding B: the plainest entry clause on earth, missed ───────────────────────────────────

  it('types a plainly worded entry clause, notice given', () => {
    const types = typesOf(
      '11. ENTRY Landlord shall give forty-eight hours written notice before entering, except in ' +
        'an emergency.',
    );
    expect(types).toContain('inspection-entry');
  });

  it('types an entry clause that names no notice at all', () => {
    const types = typesOf(
      '4. ENTRY The landlord may enter the premises at any time without notice.',
    );
    expect(types[0]).toBe('inspection-entry');
  });

  it('types an entry clause drafted in the Indian licence dialect', () => {
    const types = typesOf(
      '6. ACCESS The licensor or his authorised agent may enter the scheduled premises to inspect ' +
        'the same.',
    );
    expect(types).toContain('inspection-entry');
  });

  it('keeps an entry clause out of the notice-period bucket', () => {
    // "Twenty-four hours written notice before entering" is an entry term, not a notice period.
    // Typing it as both is how an entry clause ends up feeding the termination-notice comparison.
    const types = typesOf(
      '8. LANDLORD ENTRY AND INSPECTION The landlord may enter the property to inspect it after ' +
        'giving the tenant at least twenty-four hours written notice.',
    );
    expect(types).toContain('inspection-entry');
    expect(types).not.toContain('notice-periods');
  });
});

describe('the parties and premises flood', () => {
  // Before the rewrite `parties` scored 1 true positive against 45 false positives on the golden
  // set, because `'landlord'` and `'tenant'` were treated as evidence of a parties clause. Naming
  // a party is what every clause in a lease does.

  it('does not call a rent clause a parties clause', () => {
    expect(typesOf('3. RENT The tenant shall pay the landlord rent of 900 each month.')).toEqual([
      'rent',
    ]);
  });

  it('does not call a repair clause a parties clause', () => {
    const types = typesOf(
      '9. TENANT REPAIR DUTIES The tenant shall keep the interior in good order and shall report ' +
        'any disrepair to the landlord.',
    );
    expect(types).not.toContain('parties');
    expect(types).toContain('tenant-repairs');
  });

  it('still types the real parties clause', () => {
    expect(
      typesOf('1. PARTIES This agreement is made between the landlord and the tenant named below.'),
    ).toContain('parties');
  });

  it('does not call every clause that mentions the premises a premises clause', () => {
    const types = typesOf(
      '12. OCCUPANCY The scheduled premises shall be occupied only by the named occupants.',
    );
    expect(types).not.toContain('premises');
    expect(types).toContain('occupancy-limits');
  });

  it('still types the real premises clause', () => {
    expect(
      typesOf('2. THE PROPERTY The landlord lets the property at 3 Mill Lane to the tenant.'),
    ).toContain('premises');
  });
});

describe('types that could not fire at all before', () => {
  it('types a late-payment clause stated as a percentage', () => {
    expect(
      typesOf(
        '10. LATE PAYMENT If rent is more than seven days late, the landlord may charge interest ' +
          'at 2 per cent above the base rate.',
      ),
    ).toContain('late-fee');
  });

  it('types a late-payment clause stated as a daily sum', () => {
    expect(
      typesOf(
        '9. LATE PAYMENT In the event of delay the licensee shall pay 400 for each day of delay.',
      ),
    ).toContain('late-fee');
  });

  it('types a late-rent clause without letting the caption read as rent', () => {
    // "LATE RENT" contains "RENT". The longer caption match wins, so this is a late-fee clause.
    const types = typesOf(
      '5. LATE RENT Interest at 9 per cent per annum shall be charged on rent from the day it ' +
        'falls due.',
    );
    expect(types).toContain('late-fee');
    expect(types).not.toContain('rent');
  });

  it('types the tenant exit right when it is drafted as a notice obligation', () => {
    // A tenant's right to leave is almost never written "the tenant may terminate".
    const types = typesOf('4. NOTICE Tenant must give sixty days written notice.');
    expect(types).toContain('termination-tenant');
  });

  it('types both exit rights when either party may end the tenancy', () => {
    const types = typesOf('6. NOTICE Either party may terminate on thirty days written notice.');
    expect(types).toContain('termination-tenant');
    expect(types).toContain('termination-landlord');
    expect(types).toContain('notice-periods');
  });

  it('does not read a landlord termination right as the tenant ending the tenancy', () => {
    // The tenant word comes first in the sentence, but the landlord is the one who may terminate.
    const types = typesOf(
      '13. DEFAULT On any breach by the licensee, the licensor may terminate this agreement with ' +
        'immediate effect.',
    );
    expect(types).toContain('termination-landlord');
    expect(types).not.toContain('termination-tenant');
  });

  it('types a term clause', () => {
    expect(typesOf('3. TERM The tenancy runs for twelve months.')).toContain('term-duration');
  });

  it('types a term clause drafted as a period', () => {
    expect(typesOf('1. TERM. The licence is granted for a period of eleven months.')).toContain(
      'term-duration',
    );
  });

  it('does not let a lock-in caption claim the term type', () => {
    const types = typesOf('4. LOCK-IN PERIOD. There shall be a lock-in period of nine months.');
    expect(types).toContain('lock-in');
    expect(types).not.toContain('term-duration');
  });

  it('types a preamble as recitals', () => {
    expect(
      typesOf(
        'RESIDENTIAL LEASE\n\nState of Oregon, County of Lane. The dwelling unit is governed by ' +
          'the state landlord-tenant act.',
        'RESIDENTIAL LEASE',
      ),
    ).toContain('recitals');
  });

  it('types an executed-on-stamp-paper preamble as recitals', () => {
    expect(
      typesOf(
        'LEAVE AND LICENCE AGREEMENT\n\nThis agreement is executed on stamp paper before the ' +
          'sub-registrar.',
        'LEAVE AND LICENCE AGREEMENT',
      ),
    ).toContain('recitals');
  });

  it('does not call a bare document title a recital', () => {
    expect(typesOf('TENANCY AGREEMENT', 'TENANCY AGREEMENT')).toEqual([]);
  });
});

describe('word boundaries', () => {
  // Substring matching made "terminate" evidence of a `term` clause, "vacates" evidence of a `cat`,
  // and "assigning" evidence of an assignment clause. Every one of those was a scored hit.

  it('does not read "termination" as the term of the tenancy', () => {
    const types = typesOf(
      '8. TERMINATION The landlord may terminate this agreement on ninety days notice.',
    );
    expect(types).not.toContain('term-duration');
  });

  it('does not read "vacates" as a pets clause', () => {
    const types = typesOf(
      '4. LOCK-IN PERIOD If the licensee vacates before the expiry of the lock-in period, the ' +
        'deposit shall stand forfeited.',
    );
    expect(types).not.toContain('pets');
  });

  it('does not read "without assigning any reason" as an assignment clause', () => {
    const types = typesOf(
      '7. TERMINATION The landlord may end this tenancy without assigning any reason.',
    );
    expect(types).not.toContain('subletting-assignment');
  });
});

describe('the caption', () => {
  it('reads a run-in capitalised caption out of the body', () => {
    expect(clauseCaption(clause('5. SECURITY DEPOSIT The tenant shall pay a deposit.'))).toBe(
      'SECURITY DEPOSIT',
    );
  });

  it('reads a caption behind an ARTICLE numbering scheme', () => {
    expect(clauseCaption(clause('ARTICLE 2 - RENT AND DEPOSIT Tenant shall pay rent.'))).toBe(
      'RENT AND DEPOSIT',
    );
  });

  it('stops the caption at the first ordinary word', () => {
    expect(clauseCaption(clause('9. LATE PAYMENT If rent is late the landlord may charge.'))).toBe(
      'LATE PAYMENT',
    );
  });

  it('prefers a real heading field over the run-in guess, numbering stripped', () => {
    expect(clauseCaption(clause('The landlord may enter.', '8. ENTRY AND INSPECTION'))).toBe(
      'ENTRY AND INSPECTION',
    );
  });

  it('yields no caption for a clause that opens in ordinary prose', () => {
    expect(clauseCaption(clause('The tenant shall pay rent of 900 each month.'))).toBe('');
  });

  it('yields no caption when the first line is only a number, rather than borrowing the body', () => {
    expect(clauseCaption(clause('ARTICLE 5\nTHE TENANT SHALL PAY RENT.'))).toBe('');
  });

  it('ignores a blank heading field and falls back to the run-in caption', () => {
    expect(clauseCaption(clause('4. PETS No animals may be kept.', '   '))).toBe('PETS');
  });

  it('refuses a whole paragraph set in capitals as a caption', () => {
    const shouting =
      'THE TENANT HEREBY ACKNOWLEDGES AND AGREES THAT THE LANDLORD SHALL NOT BE LIABLE FOR ANY LOSS';
    expect(clauseCaption(clause(shouting))).toBe('');
  });

  it.each([
    [
      'ended by a full stop',
      '5. Security Deposit. The licensee has lodged it.',
      'Security Deposit',
    ],
    [
      'with short words left in lower case, ended by a colon',
      '7. Right of Entry: the owner may inspect on reasonable notice.',
      'Right of Entry',
    ],
    [
      'whose line break was lost before a capitalised opening',
      '3. Security Deposit The Licensee shall keep the receipt.',
      'Security Deposit',
    ],
    [
      'whose line break was lost before a role word',
      'ARTICLE 6 - Landlord and Tenant Obligations Landlord shall mend the roof.',
      'Landlord and Tenant Obligations',
    ],
  ])('reads a title-case caption %s', (_case, text, caption) => {
    expect(clauseCaption(clause(text))).toBe(caption);
  });

  it.each([
    [
      'an ordinary sentence with capitalised defined terms',
      'The Landlord shall keep the Premises in good repair.',
    ],
    [
      'a capitalised subject with no second sentence after it',
      'Security Deposit shall be lodged before the licence begins.',
    ],
    ['a label that names no subject the taxonomy knows', 'Tenant: Asha Rao, of 4 Hill Road.'],
    [
      'a title-case sentence longer than a caption',
      'Tenant Shall Pay The Monthly Rent To The Landlord Without Fail.',
    ],
    ['a sentence-case opening', 'Security deposit. The tenant shall pay nothing further.'],
    [
      'a run of proper nouns with no full stop and no sentence after it',
      '12. Subject to the Delhi Rent Control Act',
    ],
    ['capitalised words running into a number', 'Landlord PAN 4821 is kept for rent receipts.'],
  ])('reads no caption from %s', (_case, text) => {
    expect(clauseCaption(clause(text))).toBe('');
  });

  it('does not let a capitalised defined term in ordinary prose act as a caption', () => {
    // "Premises" is a caption word; read as one, it would type this repair duty as a premises clause.
    const types = typesOf('The Landlord shall keep the Premises in good repair.');
    expect(types).not.toContain('premises');
    expect(types).toContain('landlord-repairs');
  });

  it('types a title-case caption the way it types the same caption in capitals', () => {
    const body = 'There shall be no early exit for the first six months.';
    expect(typesOf(`4. Lock-in Period. ${body}`)).toEqual(typesOf(`4. LOCK-IN PERIOD. ${body}`));
    expect(typesOf(`4. Lock-in Period. ${body}`)).toContain('lock-in');
  });

  it('lets the longer caption match win over the shorter one it contains', () => {
    // "CONDITION OF PREMISES" is a condition clause, not a premises clause.
    const types = typesOf(
      '7. CONDITION OF PREMISES Tenant accepts the premises in its present condition, as-is.',
    );
    expect(types).toContain('habitability');
    expect(types).not.toContain('premises');
  });
});

describe('role placeholders', () => {
  it.each([
    ['tenant', 'The tenant shall be responsible for all repairs to the structure.'],
    ['lessee', 'The lessee shall be responsible for all repairs to the structure.'],
    ['licensee', 'The licensee shall be responsible for all repairs to the structure.'],
  ])('reads %s as the same role', (_role, text) => {
    expect(typesOf(`3. REPAIRS ${text}`)).toContain('tenant-repairs');
  });

  it.each([
    ['landlord', 'The landlord shall maintain the premises in a habitable condition.'],
    ['lessor', 'The lessor shall maintain the premises in a habitable condition.'],
    ['licensor', 'The licensor shall maintain the premises in a habitable condition.'],
  ])('reads %s as the same role', (_role, text) => {
    expect(typesOf(`3. REPAIRS ${text}`)).toContain('landlord-repairs');
  });

  it('keeps the two repair duties apart', () => {
    expect(
      typesOf(
        '3. REPAIRS The licensee shall be responsible for all repairs at the licensee own cost.',
      ),
    ).not.toContain('landlord-repairs');
  });
});

describe('the distinctive-cue gate', () => {
  it('never types a clause on support phrases alone', () => {
    // Every phrase here is support for some type and a cue for none.
    const types = typesOf(
      'The landlord and the tenant acknowledge the premises, the rent and the deposit at any time.',
    );
    expect(types).toEqual([]);
  });

  it('gives an empty type list rather than a guess', () => {
    const typing = detectClauseTypes(clause('This page is intentionally left blank.'));
    expect(typing.typeIds).toEqual([]);
    expect(typing.matchedOn).toBeNull();
  });

  it('reports the cue behind the top type so the reader can check it', () => {
    const typing = detectClauseTypes(clause('5. SECURITY DEPOSIT The tenant shall pay a deposit.'));
    expect(typing.typeIds[0]).toBe('security-deposit');
    expect(typing.matchedOn).toBe('security deposit');
  });

  it('honours an exclusion: a possession clause is not a commencement clause', () => {
    expect(
      typesOf('4. POSSESSION The landlord may recover possession after the fixed term.'),
    ).not.toContain('commencement');
  });
});

describe('emission limits', () => {
  it('emits at most three types, best first', () => {
    const typing = detectClauseTypes(
      clause(
        '8. TERMINATION The licensor may terminate this agreement by giving seven days notice. ' +
          'The licensee shall give three months prior written notice to terminate this agreement.',
      ),
    );
    expect(typing.typeIds.length).toBeLessThanOrEqual(3);
    const scores = typing.typeIds.map((id) => typing.scores[id] ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('is stable: the same clause always types the same way', () => {
    const text = '2. SECURITY DEPOSIT. The licensee shall pay a security deposit of 75,000.';
    expect(typesOf(text)).toEqual(typesOf(text));
  });
});

describe('the helpers around the detector', () => {
  const clauses = [
    clause('1. PARTIES This agreement is made between the landlord and the tenant.'),
    clause('2. RENT The tenant shall pay rent of 900 each month.'),
    clause('Nothing in particular.'),
  ];
  const typings = detectAllClauseTypes(clauses);

  it('produces one typing per clause, in order', () => {
    expect(typings.map((t) => t.clauseId)).toEqual(clauses.map((c) => c.id));
  });

  it('selects the clauses carrying a type', () => {
    expect(clausesOfType(clauses, typings, 'rent').map((c) => c.id)).toEqual([clauses[1]?.id]);
  });

  it('selects nothing for a type no clause carries', () => {
    expect(clausesOfType(clauses, typings, 'pets')).toEqual([]);
  });

  it('reports the untyped share honestly rather than hiding it', () => {
    expect(untypedShare(typings)).toBeCloseTo(1 / 3, 3);
    expect(untypedShare([])).toBe(0);
  });
});

describe('the taxonomy rows the detector reads', () => {
  it('gives every type at least one caption word or one cue', () => {
    for (const type of CLAUSE_TYPES) {
      expect(
        type.caption.length + type.cues.length,
        `${type.id} has nothing that can type a clause`,
      ).toBeGreaterThan(0);
    }
  });

  it('never leaves a type reachable by support alone', () => {
    for (const type of CLAUSE_TYPES) {
      if (type.support.length > 0) {
        expect(type.cues.length, `${type.id} has support but no cue to qualify it`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('keeps the derived synonym list complete, because fact extraction reads it', () => {
    for (const type of CLAUSE_TYPES) {
      for (const phrase of [...type.caption, ...type.support]) {
        if (/\{[a-z]+\}/.test(phrase)) continue; // checked in expanded form below
        expect(type.synonyms, `${type.id} drops "${phrase}" from its synonyms`).toContain(phrase);
      }
    }
  });

  it('leaves no role placeholder in the derived synonym list', () => {
    // `facts.ts` matches the flat list literally, so a stray `{tenant}` there is a cue that can
    // never fire — the amount it was meant to name would simply go unattributed.
    for (const type of CLAUSE_TYPES) {
      for (const phrase of type.synonyms) {
        expect(phrase, `${type.id} leaves a placeholder in "${phrase}"`).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });

  it('expands a placeholder into one synonym per dialect', () => {
    const repairs = CLAUSE_TYPES.find((t) => t.id === 'tenant-repairs');
    expect(repairs?.cues).toContain('{tenant} shall repair');
    for (const word of ROLE_WORDS['{tenant}'] ?? []) {
      expect(repairs?.synonyms).toContain(`${word} shall repair`);
    }
  });

  it('falls back to the raw id when asked to label a type that does not exist', () => {
    expect(clauseTypeLabel('not-a-type')).toBe('not-a-type');
    expect(clauseTypeLabel('inspection-entry')).toBe('Landlord entry and inspection');
  });
});
