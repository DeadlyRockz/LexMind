import { describe, expect, it } from 'vitest';
import {
  detectCurrency,
  largestAmount,
  parseAmounts,
  parseDurationDays,
  parseDurationMonths,
  parseGroupedNumber,
  parseHours,
  parseMultipleOfRent,
  parsePercent,
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
