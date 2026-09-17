import { describe, expect, it } from 'vitest';
import { LIMITS } from './guards.ts';
import { assertNotScanned, formatPageRanges, scannedPages, textPoorPages } from './scanned.ts';
import { type IngestError, isIngestError } from './types.ts';

/**
 * Scanned-PDF detection, tested on its thresholds directly rather than through a PDF fixture.
 *
 * The message matters as much as the verdict: "pages 3-7 are scanned images" tells a tenant which
 * part of the lease LexMind cannot read, and "this PDF is an image" tells them nothing they can act
 * on. Both halves are pinned here.
 */

function caught(run: () => void): IngestError {
  try {
    run();
  } catch (error) {
    if (isIngestError(error)) return error;
    throw error;
  }
  throw new Error('expected an IngestError');
}

const RICH = LIMITS.scannedMinCharsPerPage + 50;
const POOR = LIMITS.scannedMinCharsPerPage - 1;

describe('textPoorPages', () => {
  it('flags only pages under the character floor', () => {
    expect(
      textPoorPages([
        { page: 1, nonWhitespaceChars: RICH },
        { page: 2, nonWhitespaceChars: POOR },
        { page: 3, nonWhitespaceChars: 0 },
        { page: 4, nonWhitespaceChars: LIMITS.scannedMinCharsPerPage },
      ]),
    ).toEqual([2, 3]);
  });
});

describe('scannedPages', () => {
  it('needs both signals, so a blank page with no image is not called a scan', () => {
    const stats = [
      { page: 1, nonWhitespaceChars: 0 },
      { page: 2, nonWhitespaceChars: 0 },
      { page: 3, nonWhitespaceChars: RICH },
    ];
    // Page 3 paints an image too, but it has a text layer: a letterhead logo, not a scan.
    expect(scannedPages(stats, [2, 3])).toEqual([2]);
    expect(scannedPages(stats, [])).toEqual([]);
  });
});

describe('formatPageRanges', () => {
  it('is empty for no pages', () => {
    expect(formatPageRanges([])).toBe('');
  });

  it('writes a single page as itself', () => {
    expect(formatPageRanges([4])).toBe('4');
  });

  it('collapses consecutive pages into a range and keeps isolated pages apart', () => {
    expect(formatPageRanges([1, 2, 3, 5, 7, 8])).toBe('1-3, 5, 7-8');
  });

  it('sorts first, so the order pages were detected in does not matter', () => {
    expect(formatPageRanges([9, 3, 4, 1])).toBe('1, 3-4, 9');
  });
});

describe('assertNotScanned', () => {
  it('passes a document with no scanned pages', () => {
    expect(() => assertNotScanned([], 5)).not.toThrow();
  });

  it('says the whole PDF is a scan when every page is', () => {
    const error = caught(() => assertNotScanned([1, 2], 2));
    expect(error.code).toBe('SCANNED_PDF');
    expect(error.message).toBe(
      'This PDF is a scanned image with no text layer, so there is no text to read.',
    );
    expect(error.pages).toEqual([1, 2]);
    expect(error.remedy).toMatch(/paste the text/);
  });

  it('names one scanned page in the singular', () => {
    const error = caught(() => assertNotScanned([3], 10));
    expect(error.message).toBe('Page 3 is a scanned image with no text layer.');
    expect(error.pages).toEqual([3]);
  });

  it('names several scanned pages as ranges, in the plural', () => {
    const error = caught(() => assertNotScanned([3, 4, 5, 7], 10));
    expect(error.message).toBe('Pages 3-5, 7 are scanned images with no text layer.');
  });
});
