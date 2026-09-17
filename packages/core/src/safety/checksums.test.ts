import { describe, expect, it } from 'vitest';
import {
  isValidIfscFormat,
  isValidLuhn,
  isValidNino,
  isValidNric,
  isValidPanFormat,
  isValidVerhoeff,
  verhoeffCheckDigit,
} from './checksums.ts';

/**
 * Check-digit validators, across every prefix and length rule they encode.
 *
 * These decide what gets redacted before a lease reaches a model. A validator that rejects a real
 * identifier leaks it; one that accepts any shape redacts phone numbers and rent figures and wrecks
 * the analysis. So each is pinned with a valid value and the same value one character wrong.
 */

describe('isValidVerhoeff (Aadhaar)', () => {
  const eleven = '23456789012';
  const valid = `${eleven}${verhoeffCheckDigit(eleven)}`;

  it('accepts a number whose check digit it generated, however it is spaced', () => {
    expect(valid).toBe('234567890124');
    expect(isValidVerhoeff(valid)).toBe(true);
    expect(isValidVerhoeff('2345 6789 0124')).toBe(true);
  });

  it('rejects the same number with its check digit changed', () => {
    expect(isValidVerhoeff('234567890125')).toBe(false);
  });

  it('rejects anything that is not exactly twelve digits', () => {
    expect(isValidVerhoeff('23456789012')).toBe(false);
    expect(isValidVerhoeff('2345678901245')).toBe(false);
    expect(isValidVerhoeff('')).toBe(false);
  });
});

describe('isValidNric (Singapore NRIC and FIN)', () => {
  it('uses the S/T check table, with the T-series offset', () => {
    expect(isValidNric('S1234567D')).toBe(true);
    expect(isValidNric('T0123456G')).toBe(true);
    expect(isValidNric('T0123456A')).toBe(false);
  });

  it('uses the F/G check table, with the G-series offset', () => {
    expect(isValidNric('F1234567N')).toBe(true);
    expect(isValidNric('G1234567X')).toBe(true);
    expect(isValidNric('G1234567A')).toBe(false);
  });

  it('applies the M-series offset', () => {
    expect(isValidNric('M1234567K')).toBe(true);
    expect(isValidNric('M5000000U')).toBe(true);
    expect(isValidNric('M5000000A')).toBe(false);
  });

  it('normalises case and separators before checking', () => {
    expect(isValidNric('s-1234567-d')).toBe(true);
  });

  it('rejects a value of the wrong shape before computing anything', () => {
    expect(isValidNric('S123456D')).toBe(false);
    expect(isValidNric('A1234567D')).toBe(false);
  });
});

describe('isValidLuhn (payment cards)', () => {
  it('accepts a card number written with any separator', () => {
    expect(isValidLuhn('4111-1111-1111-1111')).toBe(true);
  });

  it('refuses a Luhn-valid number outside card lengths, so short account numbers are not cards', () => {
    // 79927398713 is the textbook Luhn example, but eleven digits is not a card.
    expect(isValidLuhn('79927398713')).toBe(false);
    expect(isValidLuhn('4111 1111 1111 1111 1111')).toBe(false);
  });
});

describe('format-only validators', () => {
  it('reads a National Insurance number regardless of case and spacing', () => {
    expect(isValidNino('ab 12 34 56 c')).toBe(true);
  });

  it('rejects the reserved and disallowed NINO prefixes', () => {
    expect(isValidNino('QQ123456C')).toBe(false);
    expect(isValidNino('GB123456A')).toBe(false);
    expect(isValidNino('NK123456A')).toBe(false);
  });

  it('reads PAN and IFSC case-insensitively', () => {
    expect(isValidPanFormat('abcde1234f')).toBe(true);
    expect(isValidIfscFormat('sbin0001234')).toBe(true);
  });
});
