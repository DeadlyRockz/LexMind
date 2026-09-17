import { describe, expect, it } from 'vitest';
import { clauseType } from '../domain/clause-types.ts';
import {
  amountForSubject,
  cueOccurrences,
  detectCurrency,
  largestAmount,
  parseAmounts,
  parseDurationDays,
  parseDurationMonths,
  parseGroupedNumber,
  parseHours,
  parseMultipleOfRent,
  parsePercent,
  subjectAmounts,
  subjectSentences,
  wordsToNumber,
} from './amounts.ts';

describe('wordsToNumber', () => {
  it('reads the number words a lease actually uses', () => {
    expect(wordsToNumber('eleven')).toBe(11);
    expect(wordsToNumber('thirty')).toBe(30);
    expect(wordsToNumber('twenty-four')).toBe(24);
    expect(wordsToNumber('fifty thousand')).toBe(50_000);
    expect(wordsToNumber('seventy five thousand')).toBe(75_000);
    expect(wordsToNumber('one hundred and fifty')).toBe(150);
  });

  it('reads Indian scale words', () => {
    expect(wordsToNumber('two lakh')).toBe(200_000);
    expect(wordsToNumber('Rupees Two Lakh only')).toBe(200_000);
    expect(wordsToNumber('1.5 crore')).toBe(15_000_000);
  });

  it('returns null rather than a partial reading', () => {
    expect(wordsToNumber('the tenant')).toBeNull();
    expect(wordsToNumber('')).toBeNull();
    expect(wordsToNumber('thousand')).toBeNull();
  });
});

describe('parseGroupedNumber', () => {
  it('handles both grouping conventions, which are the same number', () => {
    expect(parseGroupedNumber('2,00,000')).toBe(200_000);
    expect(parseGroupedNumber('200,000')).toBe(200_000);
    expect(parseGroupedNumber('2,450.00')).toBe(2450);
  });

  it('returns null for no digits', () => {
    expect(parseGroupedNumber('abc')).toBeNull();
  });
});

describe('detectCurrency', () => {
  it('reads symbols and names', () => {
    expect(detectCurrency('Rs. 25,000')).toBe('INR');
    expect(detectCurrency('the sum of 25,000 rupees')).toBe('INR');
    expect(detectCurrency('£1,200 per month')).toBe('GBP');
    expect(detectCurrency('$2,450.00')).toBe('USD');
    expect(detectCurrency('1,000 each month')).toBeNull();
  });
});

describe('parseAmounts', () => {
  it('parses every real-world spelling of a money figure', () => {
    expect(largestAmount('Rs. 50,000/- per month')?.value).toBe(50_000);
    expect(largestAmount('a deposit of $2,450.00')?.value).toBe(2450);
    expect(largestAmount('rent of £1,200 each month')?.value).toBe(1200);
    expect(largestAmount('deposit of Rs. 2,00,000 (Rupees Two Lakh only)')?.value).toBe(200_000);
    expect(largestAmount('fifty thousand rupees only')?.value).toBe(50_000);
  });

  it('tags the currency from the surrounding text', () => {
    expect(largestAmount('Rs. 75,000')?.currency).toBe('INR');
    expect(largestAmount('75,000 rupees')?.currency).toBe('INR');
  });

  it('returns the figure the clause is about, not the first number it sees', () => {
    const text = 'Under clause 3, the tenant shall pay a deposit of Rs. 75,000.';
    expect(largestAmount(text)?.value).toBe(75_000);
  });

  it('finds several amounts in document order', () => {
    const amounts = parseAmounts('rent of 25,000 and a deposit of 75,000');
    expect(amounts.map((a) => a.value)).toEqual([25_000, 75_000]);
  });

  it('returns nothing when there is no amount', () => {
    expect(parseAmounts('The tenant shall keep the flat clean.')).toEqual([]);
    expect(largestAmount('no numbers here')).toBeNull();
  });
});

describe('durations', () => {
  it('reads a term in months, converting years', () => {
    expect(parseDurationMonths('for a period of eleven months')).toBe(11);
    expect(parseDurationMonths('eleven (11) months')).toBe(11);
    expect(parseDurationMonths('for twelve months')).toBe(12);
    expect(parseDurationMonths('a term of one year')).toBe(12);
    expect(parseDurationMonths('no duration stated')).toBeNull();
  });

  it('reads a notice period in days, converting weeks and months so they compare', () => {
    expect(parseDurationDays('thirty (30) days notice')).toBe(30);
    expect(parseDurationDays('two days notice')).toBe(2);
    expect(parseDurationDays('seven days notice')).toBe(7);
    expect(parseDurationDays('three months prior written notice')).toBe(90);
    expect(parseDurationDays('one month written notice')).toBe(30);
    expect(parseDurationDays('four weeks notice')).toBe(28);
  });

  it('reads an entry notice in hours, converting days', () => {
    expect(parseHours('at least twenty-four hours written notice')).toBe(24);
    expect(parseHours('48 hours notice')).toBe(48);
    expect(parseHours('two days notice')).toBe(48);
    expect(parseHours('no notice figure')).toBeNull();
  });
});

describe('parsePercent', () => {
  it('reads both spellings', () => {
    expect(parsePercent('interest at 12 per cent per annum')).toBe(12);
    expect(parsePercent('a late fee of 5%')).toBe(5);
    expect(parsePercent('3 per cent above the base rate')).toBe(3);
    expect(parsePercent('no percentage')).toBeNull();
  });
});

describe('parseMultipleOfRent', () => {
  it('reads a deposit expressed as a multiple of rent', () => {
    expect(parseMultipleOfRent("two months' rent")?.months).toBe(2);
    expect(parseMultipleOfRent('being three months licence fee')?.months).toBe(3);
    expect(parseMultipleOfRent('equal to one month of rent')?.months).toBe(1);
  });

  it('converts a weeks-of-rent cap, as England states it', () => {
    const parsed = parseMultipleOfRent('five weeks rent');
    expect(parsed?.weeks).toBe(true);
    expect(parsed?.months).toBeCloseTo(1.15, 1);
  });

  it('returns null when the deposit is a flat figure', () => {
    expect(parseMultipleOfRent('a deposit of Rs. 75,000')).toBeNull();
  });
});

describe('amountForSubject', () => {
  const RENT = clauseType('rent').synonyms;
  const DEPOSIT = clauseType('security-deposit').synonyms;

  it('binds a figure to the word naming it, not to the largest figure present', () => {
    const article =
      'ARTICLE 2 - RENT AND DEPOSIT\n' +
      'Tenant shall pay rent of $1,800 per month. Tenant shall pay a security deposit of $3,600.';
    expect(amountForSubject(article, RENT)?.value).toBe(1800);
    expect(amountForSubject(article, DEPOSIT)?.value).toBe(3600);
  });

  it('will not reach across a full stop for a cue that names no figure of its own', () => {
    // The reading that produced "the deposit is 40 months of rent, 20 times the limit" — cited to
    // a statute — from a document that states no rent at all.
    const clause =
      '3. RENT\n' +
      'The rent is as set out in Schedule A hereto. ' +
      'The Licensee has paid a brokerage of Rs. 5,000 to the agent on signing.';
    expect(amountForSubject(clause, RENT)).toBeNull();
  });

  it('reads a label that follows its figure, which is ordinary drafting', () => {
    expect(
      amountForSubject('$1,800 shall be paid as rent on the first day of each month.', RENT)?.value,
    ).toBe(1800);
    expect(
      amountForSubject('The tenant shall pay 25,000 rupees as rent each month.', RENT)?.value,
    ).toBe(25_000);
  });

  it('reads a figure at the far end of a long sentence, which no character window can', () => {
    const sentence =
      'The monthly rent, which shall be payable in advance on the first day of each calendar ' +
      'month without any deduction, abatement or set-off whatsoever, is $1,800.';
    expect(amountForSubject(sentence, RENT)?.value).toBe(1800);
  });

  it('does not match a cue inside a longer word', () => {
    // "cur|rent" is the whole bug: a fittings valuation reported as the rent, and every deposit
    // ratio computed from it.
    expect(
      amountForSubject(
        'Rent is payable monthly in advance. The current market value of the fittings is $9,500.',
        RENT,
      ),
    ).toBeNull();
  });

  it('never reads the clause number as the amount', () => {
    expect(
      amountForSubject('5. SECURITY DEPOSIT\nThe deposit is one month of rent.', DEPOSIT),
    ).toBeNull();
    expect(
      amountForSubject('ARTICLE 2 - RENT\nThe rent is set out in Schedule A.', RENT),
    ).toBeNull();
  });

  it('reads a figure from an enumerated list', () => {
    const list =
      'The tenant shall pay: (a) rent of $1,800 each month; and (b) a security deposit of $3,600.';
    expect(amountForSubject(list, RENT)?.value).toBe(1800);
    expect(amountForSubject(list, DEPOSIT)?.value).toBe(3600);
  });

  it('keeps the whole deposit rather than a part of it named twice', () => {
    expect(
      amountForSubject('The landlord holds £500 of the £7,200 deposit against cleaning.', DEPOSIT)
        ?.value,
    ).toBe(7200);
  });

  it('returns null when no cue is present at all', () => {
    expect(amountForSubject('The tenant shall keep the flat clean.', RENT)).toBeNull();
  });

  it('ranks a nearby cue above a distant one and a preceding cue above a following one', () => {
    const ranked = subjectAmounts(
      'a security deposit of $3,600 is due, being two months rent',
      DEPOSIT,
    );
    expect(ranked[0]?.amount.value).toBe(3600);
    expect(ranked[0]?.direction).toBe(0);
  });
});

describe('figures that are not amounts', () => {
  it('skips a parenthetical digit gloss of the number word before it', () => {
    // "two (2) months' rent" is one number written twice. Read as a figure, the deposit becomes
    // two rupees — and the plan's own acceptance criterion, ₹50,000, never runs.
    expect(parseAmounts("a deposit equal to two (2) months' rent").map((a) => a.value)).toEqual([]);
    expect(parseAmounts('for a period of eleven (11) months').map((a) => a.value)).toEqual([]);
    expect(parseAmounts('thirty (30) days written notice').map((a) => a.value)).toEqual([]);
  });

  it('keeps a parenthetical that is not a restatement', () => {
    expect(
      parseAmounts('a deposit of $3,600 (three thousand six hundred dollars)').length,
    ).toBeGreaterThan(0);
    expect(largestAmount('the sum of Rs. 2,00,000 (Rupees Two Lakh only)')?.value).toBe(200_000);
  });

  it('skips a bare digit run long enough to be an account number', () => {
    expect(
      parseAmounts(
        'Rent shall be credited to account number 50100234567890, IFSC HDFC0000123.',
      ).map((a) => a.value),
    ).toEqual([]);
  });

  it('keeps a large figure that carries a currency, however it is written', () => {
    expect(largestAmount('a deposit of Rs. 2500000')?.value).toBe(2_500_000);
    expect(largestAmount('a deposit of 25,00,000')?.value).toBe(2_500_000);
  });

  it('skips clause numbering but not a figure in the body', () => {
    expect(parseAmounts('4. RENT\nThe rent is 1,200 each month.').map((a) => a.value)).toEqual([
      1200,
    ]);
    expect(parseAmounts('5.2 The deposit is 900 dollars.').map((a) => a.value)).toEqual([900]);
  });
});

describe('Indian scale notation end to end', () => {
  it('reads lakh and crore in both digit and word form', () => {
    expect(largestAmount('a deposit of Rs. 2,00,000')?.value).toBe(200_000);
    expect(largestAmount('a deposit of two lakh rupees')?.value).toBe(200_000);
    expect(largestAmount('a consideration of 1.5 crore')?.value).toBe(15_000_000);
    expect(largestAmount('fifty thousand rupees only')?.value).toBe(50_000);
  });

  it('tags the currency when it follows the figure as well as when it precedes it', () => {
    expect(largestAmount('25,000 rupees per month')?.currency).toBe('INR');
    expect(largestAmount('Rs. 25,000 per month')?.currency).toBe('INR');
    expect(largestAmount('1,200 pounds each month')?.currency).toBe('GBP');
    expect(largestAmount('2,450 dollars')?.currency).toBe('USD');
  });
});

describe('subjectSentences', () => {
  it('does not treat the full stop in "Rs." as the end of a sentence', () => {
    // Otherwise "a security deposit of Rs." and "2,00,000" are different sentences, and the most
    // common way an Indian lease states its deposit stops parsing.
    const text = 'The licensee shall pay a security deposit of Rs. 2,00,000 to the licensor.';
    expect(subjectSentences(text).length).toBe(1);
    expect(amountForSubject(text, clauseType('security-deposit').synonyms)?.value).toBe(200_000);
  });

  it('still splits real sentences, and every span slices its own text back out', () => {
    const text = 'The rent is $1,800. The deposit is $3,600.';
    const spans = subjectSentences(text);
    expect(spans.length).toBe(2);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text);
  });
});

// ─── Word-form numbers ─────────────────────────────────────────────────────────────────────────

describe('number words, as leases actually write them', () => {
  it('reads every tens word, including the common misspelling "fourty"', () => {
    const tens: readonly [string, number][] = [
      ['twenty', 20],
      ['thirty', 30],
      ['forty', 40],
      ['fourty', 40],
      ['fifty', 50],
      ['sixty', 60],
      ['seventy', 70],
      ['eighty', 80],
      ['ninety', 90],
    ];
    for (const [word, value] of tens) expect(wordsToNumber(word), word).toBe(value);
  });

  it('reads compound and scaled phrases the way a rupee figure is spelled out', () => {
    expect(wordsToNumber('sixty-five')).toBe(65);
    expect(wordsToNumber('twelve hundred')).toBe(1200);
    expect(wordsToNumber('one lakh fifty thousand')).toBe(150_000);
    expect(wordsToNumber('Rupees Fifty Thousand Five Hundred only')).toBe(50_500);
    expect(wordsToNumber('three lacs')).toBe(300_000);
    expect(wordsToNumber('two crores')).toBe(20_000_000);
  });

  it('stops at the first word that is not part of the number once the number has started', () => {
    expect(wordsToNumber('fifty thousand rupees and other terms')).toBe(50_000);
  });

  it('never mistakes a name inherited from Object.prototype for a number word', () => {
    // Regression: the tables were plain objects, so "constructor" found a function, poisoned the
    // running total and turned a two-lakh deposit into null.
    expect(wordsToNumber('Rupees constructor two lakh')).toBe(200_000);
    expect(wordsToNumber('toString two lakh')).toBe(200_000);
    expect(wordsToNumber('__proto__ fifty thousand')).toBe(50_000);
    expect(wordsToNumber('two lakh constructor hundred')).toBe(200_000);
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(wordsToNumber(word), word).toBeNull();
    }
  });

  it('never reports zero as an amount', () => {
    expect(wordsToNumber('zero')).toBeNull();
    expect(parseGroupedNumber('0')).toBeNull();
    expect(parseGroupedNumber('0.00')).toBeNull();
    expect(parseGroupedNumber('.')).toBeNull();
    expect(parseAmounts('an outstanding balance of 0.00')).toEqual([]);
  });

  it('parses a spelled-out amount inside running text, with the currency named after it', () => {
    expect(parseAmounts('sixty thousand').map((a) => a.value)).toEqual([60_000]);
    const [amount] = parseAmounts('Rupees One Lakh Fifty Thousand only');
    expect(amount?.value).toBe(150_000);
    expect(amount?.currency).toBe('INR');
  });

  it('drops a run of scale words with no number in front of them', () => {
    expect(parseAmounts('hundred thousand')).toEqual([]);
  });
});

describe('a digit figure followed by a scale word', () => {
  it('multiplies by the scale and quotes the whole phrase', () => {
    const [lakh] = parseAmounts('a deposit of Rs. 2 lakh');
    expect(lakh).toMatchObject({ value: 200_000, source: 'Rs. 2 lakh', currency: 'INR' });

    const [crores] = parseAmounts('a premium of 1.5 crores');
    expect(crores).toMatchObject({ value: 15_000_000, source: '1.5 crores' });

    const [million] = parseAmounts('$1.2 million');
    expect(million).toMatchObject({ value: 1_200_000, source: '$1.2 million', currency: 'USD' });
  });
});

describe('currency codes and names', () => {
  it('reads ISO codes and the euro, not only symbols', () => {
    expect(detectCurrency('INR 5000')).toBe('INR');
    expect(detectCurrency('USD 20')).toBe('USD');
    expect(detectCurrency('GBP 900')).toBe('GBP');
    expect(detectCurrency('20 euros')).toBe('EUR');
    expect(parseAmounts('€950 monthly')[0]?.currency).toBe('EUR');
  });
});

describe('restatements and leading figures', () => {
  it('reads a digit figure restated in digits as one amount, not two', () => {
    expect(parseAmounts('a deposit of Rs. 5,000 (5,000) only').map((a) => a.value)).toEqual([5000]);
  });

  it('keeps a bracketed figure that restates nothing', () => {
    expect(parseAmounts('Deposit: (75,000)').map((a) => a.value)).toEqual([75_000]);
  });

  it('reads a leading figure above 99 as money rather than clause numbering', () => {
    expect(parseAmounts('1200 each month').map((a) => a.value)).toEqual([1200]);
  });
});

describe('cueOccurrences', () => {
  it('finds nothing for a blank cue rather than matching everywhere', () => {
    expect(cueOccurrences('rent is due', '   ')).toEqual([]);
  });

  it('matches a cue that opens or closes with punctuation, where a word boundary cannot apply', () => {
    expect(cueOccurrences('the deposit (refundable) is held', '(refundable)')).toEqual([
      { start: 12, end: 24 },
    ]);
    expect(cueOccurrences('Rs. 500 and Rs. 600', 'Rs.')).toEqual([
      { start: 0, end: 3 },
      { start: 12, end: 15 },
    ]);
  });

  it('still refuses a match that starts inside a longer word', () => {
    expect(cueOccurrences('Brs. 5', 'Rs.')).toEqual([]);
  });
});

describe('subjectSentences on empty input', () => {
  it('returns one span covering the text, so offsets stay addressable', () => {
    expect(subjectSentences('')).toEqual([{ start: 0, end: 0, text: '' }]);
    expect(subjectSentences('   ')).toEqual([{ start: 0, end: 3, text: '   ' }]);
  });
});

describe('subjectAmounts ties', () => {
  it('breaks a tie in direction and distance in favour of the larger figure', () => {
    const ranked = subjectAmounts('a deposit of 500 or a deposit of 700', ['deposit']);
    expect(ranked.map((r) => [r.amount.value, r.direction, r.gap])).toEqual([
      [700, 0, 4],
      [500, 0, 4],
    ]);
  });
});

// ─── Durations written with compound number words ─────────────────────────────────────────────

describe('durations in digits and in the full range of number words', () => {
  it('reads months and years', () => {
    expect(parseDurationMonths('12 months')).toBe(12);
    expect(parseDurationMonths('2 years')).toBe(24);
    expect(parseDurationMonths('three years')).toBe(36);
    expect(parseDurationMonths('eighteen months')).toBe(18);
    expect(parseDurationMonths('twenty-four months')).toBe(24);
    expect(parseDurationMonths('thirty six months')).toBe(36);
  });

  it('reads days, weeks and months as days', () => {
    expect(parseDurationDays('60 days')).toBe(60);
    expect(parseDurationDays('sixty days')).toBe(60);
    expect(parseDurationDays('ninety (90) days')).toBe(90);
    expect(parseDurationDays('fourteen days')).toBe(14);
    expect(parseDurationDays('fifteen days')).toBe(15);
    expect(parseDurationDays('forty days')).toBe(40);
    expect(parseDurationDays('2 weeks')).toBe(14);
  });

  it('reads hours, and converts a week to hours', () => {
    expect(parseHours('12 hours')).toBe(12);
    expect(parseHours('seventy-two hours')).toBe(72);
    expect(parseHours('forty eight hours')).toBe(48);
    expect(parseHours('twenty four (24) hours')).toBe(24);
    expect(parseHours('one week')).toBe(168);
  });

  it('reads both spellings of per cent, with decimals', () => {
    expect(parsePercent('2.5%')).toBe(2.5);
    expect(parsePercent('18 percent')).toBe(18);
  });

  it('reads a multiple of rent in digits, and with a curly apostrophe', () => {
    expect(parseMultipleOfRent('6 months rent')).toEqual({ months: 6, weeks: false });
    expect(parseMultipleOfRent('two months’ compensation')).toEqual({ months: 2, weeks: false });
    expect(parseMultipleOfRent("three months' license fee")).toEqual({ months: 3, weeks: false });
  });
});

describe('a compound number word is read whole, never as its last word', () => {
  // Regression: every duration pattern listed "five" but not "forty-five", so it matched the
  // "five" inside it. "The Tenant shall give forty-five (45) days notice" read as five days, which
  // turns a tenant who owes far more warning than the landlord into one who owes less.
  it('reads a compound notice period in days', () => {
    expect(parseDurationDays('forty-five (45) days written notice')).toBe(45);
    expect(parseDurationDays('sixty-five days')).toBe(65);
    expect(parseDurationDays('twenty-one days')).toBe(21);
    expect(parseDurationDays('forty two days')).toBe(42);
  });

  it('reads a compound term in months, and a compound entry notice in hours', () => {
    expect(parseDurationMonths('twenty-one months')).toBe(21);
    expect(parseDurationMonths('forty-eight months')).toBe(48);
    expect(parseHours('thirty-six hours')).toBe(36);
    expect(parseHours('ninety-six hours')).toBe(96);
  });

  it('reads a compound multiple of rent', () => {
    expect(parseMultipleOfRent('twenty-two weeks rent')?.months).toBeCloseTo(22 / 4.345, 5);
  });

  it('abstains rather than reading the tail of a number it cannot read whole', () => {
    expect(parseDurationDays('one hundred and twenty days')).toBeNull();
    expect(parseDurationDays('one hundred and twenty-five days')).toBeNull();
  });

  it('still reads the plain words the patterns always read', () => {
    expect(parseDurationDays('seven days')).toBe(7);
    expect(parseDurationDays('thirty (30) days')).toBe(30);
    expect(parseDurationMonths('eleven (11) months')).toBe(11);
    expect(parseHours('twenty-four hours')).toBe(24);
  });
});
