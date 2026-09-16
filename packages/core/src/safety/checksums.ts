/**
 * Check-digit validators.
 *
 * These exist so that identifier detection is a *validated* match rather than a shape match. The
 * difference is not cosmetic: "any twelve digits" matches a phone number, an account balance and
 * a date range, so a bare shape match either floods the document with false redactions — which
 * destroys the analysis — or gets loosened until it misses the real identifiers.
 *
 * Where a published check digit exists, it is used. Where one does not (PAN has no checksum), the
 * detector says so rather than implying a validation it cannot perform.
 */

/** Luhn, for payment card numbers. */
export function isValidLuhn(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let value = clean.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff tables, as published. Used by Aadhaar.
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Verhoeff, for a 12-digit Aadhaar number. */
export function isValidVerhoeff(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length !== 12) return false;
  // Aadhaar never begins 0 or 1.
  if (clean.startsWith('0') || clean.startsWith('1')) return false;

  let checksum = 0;
  const reversed = [...clean].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number.parseInt(reversed[i] ?? '0', 10);
    const permuted = VERHOEFF_P[i % 8]?.[digit] ?? 0;
    checksum = VERHOEFF_D[checksum]?.[permuted] ?? 0;
  }
  return checksum === 0;
}

/** Compute a Verhoeff check digit, used to build valid test fixtures. */
export function verhoeffCheckDigit(elevenDigits: string): number {
  let checksum = 0;
  const reversed = [...`${elevenDigits}0`].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number.parseInt(reversed[i] ?? '0', 10);
    const permuted = VERHOEFF_P[i % 8]?.[digit] ?? 0;
    checksum = VERHOEFF_D[checksum]?.[permuted] ?? 0;
  }
  return VERHOEFF_INV[checksum] ?? 0;
}

const NRIC_WEIGHTS = [2, 7, 6, 5, 4, 3, 2] as const;
const NRIC_ST_CHECK = 'JZIHGFEDCBA';
const NRIC_FG_CHECK = 'XWUTRQPNMLK';

/** Singapore NRIC / FIN check letter. */
export function isValidNric(value: string): boolean {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[STFGM][0-9]{7}[A-Z]$/.test(clean)) return false;

  const prefix = clean[0] ?? '';
  const digits = clean.slice(1, 8);
  const check = clean[8] ?? '';

  let sum = prefix === 'T' || prefix === 'G' ? 4 : prefix === 'M' ? 3 : 0;
  for (let i = 0; i < 7; i += 1) {
    sum += (Number.parseInt(digits[i] ?? '0', 10)) * (NRIC_WEIGHTS[i] ?? 0);
  }

  const table = prefix === 'S' || prefix === 'T' ? NRIC_ST_CHECK : NRIC_FG_CHECK;
  const expected = table[sum % 11];
  return expected === check;
}

/**
 * UK National Insurance number.
 *
 * No check digit exists, so this validates the published *format* rules instead: the prefix may
 * not be one of the reserved combinations, neither of the first two letters may be D, F, I, Q, U
 * or V, the second may not be O, and the suffix is A to D.
 */
export function isValidNino(value: string): boolean {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{2}[0-9]{6}[A-D]$/.test(clean)) return false;

  const first = clean[0] ?? '';
  const second = clean[1] ?? '';
  if ('DFIQUV'.includes(first) || 'DFIQUVO'.includes(second)) return false;
  return !['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ'].includes(`${first}${second}`);
}

/** Indian PAN. Format only — PAN publishes no check digit, and the detector says so. */
export function isValidPanFormat(value: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

/** Indian IFSC bank branch code. Format only. */
export function isValidIfscFormat(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}
