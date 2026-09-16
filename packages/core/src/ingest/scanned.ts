import { LIMITS } from './guards.ts';
import { IngestError } from './types.ts';

/**
 * Scanned-PDF detection, as pure functions so the thresholds can be tested directly.
 *
 * **Two signals, not one.** A bare `items.length === 0` test misses the common case where a
 * scanner adds a text header above an image-only body. The measured separation on fixtures was
 * stark — 151.0 characters per page with zero image operators for a real text PDF, against
 * 0.0 characters per page with an image operator for a scan — so combining the two is reliable.
 *
 * **LexMind deliberately does not bundle OCR.** The smallest viable offline footprint is
 * `tesseract.js-core` at 43 MB plus language data, which blows the 10 MB repository limit
 * outright, and `tesseract.js` fetches its WASM core and language data from a CDN at runtime,
 * which would break offline CI.
 *
 * It is also the honest legal answer. Silently OCR-ing a lease and then citing clause positions
 * from noisy OCR output would produce citations that look verified and point at text the document
 * does not contain.
 */

export interface PageTextStat {
  /** 1-based. */
  readonly page: number;
  readonly nonWhitespaceChars: number;
}

/** Pages with too little text to be a text-layer page. Signal one. */
export function textPoorPages(stats: readonly PageTextStat[]): readonly number[] {
  return stats
    .filter((s) => s.nonWhitespaceChars < LIMITS.scannedMinCharsPerPage)
    .map((s) => s.page);
}

/** Pages that are text-poor *and* paint an image. Both signals, so a scan rather than a blank. */
export function scannedPages(
  stats: readonly PageTextStat[],
  pagesWithImages: readonly number[],
): readonly number[] {
  const images = new Set(pagesWithImages);
  return textPoorPages(stats).filter((page) => images.has(page));
}

export function formatPageRanges(pages: readonly number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0] ?? 0;
  let previous = start;

  for (const page of sorted.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(', ');
}

/**
 * Throw when the document is a scan. The message names the exact pages, because "this PDF is an
 * image" is useless advice and "pages 3-7 are scanned images" is actionable.
 */
export function assertNotScanned(pages: readonly number[], totalPages: number): void {
  if (pages.length === 0) return;
  const allPages = pages.length >= totalPages;
  throw new IngestError(
    'SCANNED_PDF',
    allPages
      ? 'This PDF is a scanned image with no text layer, so there is no text to read.'
      : `Page${pages.length === 1 ? '' : 's'} ${formatPageRanges(pages)} ${pages.length === 1 ? 'is a scanned image' : 'are scanned images'} with no text layer.`,
    {
      pages,
      remedy:
        'Re-export the PDF from the original document, ask the sender for the original file, or paste the text of the clauses you want reviewed.',
    },
  );
}
