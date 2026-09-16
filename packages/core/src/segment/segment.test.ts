import { describe, expect, it } from 'vitest';
import { ingestPastedText } from '../ingest/index.ts';
import { normalizeForMatch } from '../util/text.ts';
import { clauseReference, segmentClauses } from './clauses.ts';
import { headingTitle, looksLikeHeading, parseNumbering } from './headings.ts';
import { buildRetrievalIndex, expandQuery, search, tokenize } from './lexical.ts';
import { buildMatchIndex, locateQuote, MIN_QUOTE_CHARS, pinQuote } from './locate.ts';
import { buildOutline, flattenOutline, outlineDepth } from './outline.ts';
import { segment } from './index.ts';

describe('parseNumbering', () => {
  it('reads each numbering scheme a lease actually uses', () => {
    expect(parseNumbering('1. TERM')?.path).toEqual(['1']);
    expect(parseNumbering('8.3 Deductions')?.path).toEqual(['8', '3']);
    expect(parseNumbering('8.3.1 Sub-deduction')?.path).toEqual(['8', '3', '1']);
    expect(parseNumbering('(a) The tenant shall')?.path).toEqual(['a']);
    expect(parseNumbering('(B) The landlord shall')?.path).toEqual(['B']);
    expect(parseNumbering('(iv) Further provisions')?.path).toEqual(['iv']);
    expect(parseNumbering('ARTICLE 8 - DEPOSIT')?.path).toEqual(['8']);
    expect(parseNumbering('Section 5.2 Rent')?.path).toEqual(['5', '2']);
    expect(parseNumbering('Clause 12: Notice')?.path).toEqual(['12']);
    expect(parseNumbering('Schedule A')?.path).toEqual(['A']);
  });

  it('records the nesting depth the scheme implies', () => {
    expect(parseNumbering('1. TERM')?.depth).toBe(1);
    expect(parseNumbering('(a) sub')?.depth).toBe(3);
    expect(parseNumbering('(iv) sub-sub')?.depth).toBe(4);
  });

  it('does not swallow the pronoun "I" at the start of a line', () => {
    expect(parseNumbering('I agree to the terms above.')).toBeNull();
  });

  it('rejects a parenthesised token that is not a roman numeral', () => {
    expect(parseNumbering('(vv) not roman')).toBeNull();
  });

  it('returns null for ordinary prose', () => {
    expect(parseNumbering('The tenant shall pay rent monthly.')).toBeNull();
  });

  it('strips the label to leave the title', () => {
    expect(headingTitle('ARTICLE 8 - SECURITY DEPOSIT')).toBe('SECURITY DEPOSIT');
    expect(headingTitle('8.3 Deductions from Deposit')).toBe('Deductions from Deposit');
  });
});

describe('looksLikeHeading', () => {
  it('accepts ALL-CAPS and keyword headings', () => {
    expect(looksLikeHeading('SECURITY DEPOSIT')).toBe(true);
    expect(looksLikeHeading('Article 4 Termination')).toBe(true);
  });

  it('rejects a sentence, however short', () => {
    expect(looksLikeHeading('The tenant shall pay rent.')).toBe(false);
  });

  it('rejects a long line even in capitals', () => {
    expect(looksLikeHeading('A'.repeat(120))).toBe(false);
  });
});

describe('segmentClauses', () => {
  const document = ingestPastedText(`ARTICLE 8 - SECURITY DEPOSIT

8.1 Amount

The tenant shall pay a deposit of two months rent.

8.2 Deductions

The landlord may deduct unpaid rent from the deposit.

ARTICLE 9 - NOTICE

Either party may give thirty days notice.

IN WITNESS WHEREOF the parties have signed below.

Landlord signature
`);
  const clauses = segmentClauses(document);

  it('holds the offset invariant for every clause', () => {
    for (const clause of clauses) {
      expect(document.text.slice(clause.charStart, clause.charEnd)).toBe(clause.text);
    }
  });

  it('nests sub-clauses under their article via the heading trail', () => {
    const deductions = clauses.find((c) => c.path.join('.') === '8.2');
    expect(deductions).toBeDefined();
    expect(deductions?.headingTrail.join(' | ')).toMatch(/ARTICLE 8 - SECURITY DEPOSIT/);
  });

  it('resets the heading stack at the next article, so context does not leak forward', () => {
    const notice = clauses.find((c) => c.text.includes('thirty days notice'));
    // A clause's own heading lives in `heading`; `headingTrail` holds its ancestors. What must
    // never happen is ARTICLE 8 still hanging over a clause that belongs to ARTICLE 9.
    expect(notice?.heading).toMatch(/NOTICE/);
    expect(notice?.headingTrail.join(' ')).not.toMatch(/ARTICLE 8/);
  });

  it('stops at the signature block instead of citing it as a term', () => {
    const joined = clauses.map((c) => c.text).join('\n');
    expect(joined).not.toMatch(/IN WITNESS WHEREOF/);
    expect(joined).not.toMatch(/Landlord signature/);
  });

  it('builds a readable reference for each clause', () => {
    const deductions = clauses.find((c) => c.path.join('.') === '8.2');
    expect(clauseReference(deductions as never)).toMatch(/SECURITY DEPOSIT/);
    expect(clauseReference(deductions as never)).toMatch(/Clause 8\.2/);
  });
});

describe('buildOutline', () => {
  it('produces a nested tree, not a flat list', () => {
    const document = ingestPastedText(`ARTICLE 1 - RENT

1.1 Amount

Rent is 1,000 per month.

1.2 Due date

Rent is due on the first.
`);
    const outline = buildOutline(segmentClauses(document));
    expect(outline).toHaveLength(1);
    expect(outline[0]?.children.length).toBeGreaterThanOrEqual(1);
    expect(outlineDepth(outline)).toBeGreaterThan(1);
  });

  it('flattens back to document order', () => {
    const clauses = segmentClauses(ingestPastedText('1. One\n\n2. Two\n\n3. Three'));
    const flat = flattenOutline(buildOutline(clauses));
    expect(flat.map((n) => n.clause.id)).toEqual(clauses.map((c) => c.id));
  });

  it('handles an empty document', () => {
    expect(buildOutline([])).toEqual([]);
    expect(outlineDepth([])).toBe(0);
  });
});

describe('buildMatchIndex', () => {
  const samples = [
    'The tenant shall pay "thirty (30) days" notice.',
    '  leading and trailing  ',
    'ligature: oﬃce and NBSP: here',
    'CAPS and    multiple   spaces',
    'newlines\nand\n\nparagraphs',
  ];

  it('agrees exactly with normalizeForMatch', () => {
    for (const sample of samples) {
      expect(buildMatchIndex(sample).norm, sample).toBe(normalizeForMatch(sample));
    }
  });

  it('maps every normalized position back to a real original offset', () => {
    const text = samples[0] ?? '';
    const index = buildMatchIndex(text);
    expect(index.starts).toHaveLength(index.norm.length);
    for (let i = 0; i < index.norm.length; i += 1) {
      const start = index.starts[i] ?? -1;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThan(text.length);
    }
  });
});

describe('locateQuote', () => {
  const text =
    'The tenant shall give thirty (30) days notice. The landlord shall give thirty (30) days ' +
    'notice as well. Deposits are refundable within fourteen days.';

  it('finds an exact quote', () => {
    const hits = locateQuote(text, 'Deposits are refundable within fourteen days');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchKind).toBe('exact');
    expect(text.slice(hits[0]?.charStart ?? 0, hits[0]?.charEnd ?? 0)).toBe(
      'Deposits are refundable within fourteen days',
    );
  });

  it('returns every occurrence of a repeated phrase, not just the first', () => {
    const hits = locateQuote(text, 'thirty (30) days notice');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.charStart).not.toBe(hits[1]?.charStart);
  });

  it('falls back to a folded match when whitespace and case have drifted', () => {
    const hits = locateQuote(text, 'THIRTY   (30)\n DAYS NOTICE. the landlord');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchKind).toBe('normalized');
    // The offsets must still slice out the real text, folded-equal to the quote.
    const sliced = text.slice(hits[0]?.charStart ?? 0, hits[0]?.charEnd ?? 0);
    expect(normalizeForMatch(sliced)).toBe(normalizeForMatch('THIRTY (30) DAYS NOTICE. the landlord'));
  });

  it('never invents an offset for a quote the document does not contain', () => {
    expect(locateQuote(text, 'the landlord shall paint the walls annually')).toEqual([]);
  });

  it('does not fuzzy-match a near-miss, because a plausible citation is the worst outcome', () => {
    // One word changed: "fourteen" to "twenty". A similarity threshold would accept this.
    expect(locateQuote(text, 'Deposits are refundable within twenty days')).toEqual([]);
  });

  it('refuses to anchor a quote too short to be unique', () => {
    expect(locateQuote(text, 'days')).toEqual([]);
    expect('days'.length).toBeLessThan(MIN_QUOTE_CHARS);
  });
});

describe('pinQuote', () => {
  const text =
    'Clause 3 says thirty (30) days notice applies. Clause 9 says thirty (30) days notice applies.';

  it('pins a unique quote', () => {
    expect(pinQuote(text, 'Clause 3 says thirty (30) days')).not.toBeNull();
  });

  it('refuses to guess between two identical phrases', () => {
    expect(pinQuote(text, 'thirty (30) days notice applies')).toBeNull();
  });

  it('resolves the ambiguity when told which clause was meant', () => {
    const pinned = pinQuote(text, 'thirty (30) days notice applies', {
      within: { charStart: 0, charEnd: 46 },
    });
    expect(pinned).not.toBeNull();
    expect(pinned?.charStart).toBeLessThan(46);
  });

  it('returns null for a quote that is not present at all', () => {
    expect(pinQuote(text, 'the landlord shall provide parking')).toBeNull();
  });
});

describe('lexical retrieval', () => {
  const { clauses } = segment(
    ingestPastedText(`1. RENT

The tenant shall pay rent of 1,000 each month in advance.

2. SECURITY DEPOSIT

The tenant shall pay a security deposit equal to two months rent. The deposit is refundable.

3. LOCK-IN PERIOD

There shall be a lock-in period of nine months during which the tenant may not vacate.

4. PETS

No pets are permitted in the premises.
`),
  );
  const index = buildRetrievalIndex(clauses);

  it('drops stopwords but keeps legal terms', () => {
    const tokens = tokenize('The tenant shall indemnify the landlord hereby');
    expect(tokens).toContain('indemnify');
    expect(tokens).toContain('tenant');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('hereby');
  });

  it('retrieves the deposit clause for a deposit question', () => {
    expect(search(index, 'how much is the security deposit?', 3)[0]?.clause.text).toMatch(
      /security deposit/i,
    );
  });

  it('bridges a tenant phrasing that shares no words with the clause', () => {
    // "can I leave early" and "lock-in period" have zero term overlap, so BM25 alone scores this
    // at nothing however well tuned. The expansion table is what closes the gap.
    expect(search(index, 'can I leave early?', 5).map((h) => h.clause.text).join(' ')).toMatch(
      /lock-in/i,
    );
  });

  it('still scores the reader own words, so expansion never replaces the question', () => {
    expect(search(index, 'pets', 3)[0]?.clause.text).toMatch(/pets/i);
  });

  it('reports which terms matched, so the UI can say why', () => {
    const hit = search(index, 'lock-in period', 1)[0];
    expect(hit?.matchedTerms.length).toBeGreaterThan(0);
  });

  it('returns nothing for a query of pure stopwords', () => {
    expect(search(index, 'the and of', 3)).toEqual([]);
  });

  it('expands a bridged phrase and leaves an unbridged one alone', () => {
    expect(expandQuery('can I leave early?')).toContain('lock-in');
    expect(expandQuery('what is the rent')).toEqual(['rent']);
  });

  it('is deterministic across runs', () => {
    const once = search(index, 'deposit refundable', 3).map((h) => h.clause.id);
    const twice = search(index, 'deposit refundable', 3).map((h) => h.clause.id);
    expect(twice).toEqual(once);
  });
});
