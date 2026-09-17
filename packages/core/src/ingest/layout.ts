import { collapseWhitespace } from '../util/text.ts';
import type { Block } from './types.ts';

/**
 * Turn PDF text items into paragraph blocks.
 *
 * Kept as a pure function over geometry, with no PDF library in sight, because this is the
 * hardest logic in the ingest layer and it deserves unit tests rather than fixtures.
 *
 * The problem it solves: `getTextContent()` emits items in content-stream draw order, not human
 * reading order (mozilla/pdf.js #14493, #17191). **A two-column lease interleaves its columns**
 * unless the items are clustered and sorted first, and interleaved legal text is not merely ugly
 * — it produces clause boundaries that do not exist and citations that point at nothing.
 */

/** The minimum an item needs to be laid out. Matches unpdf's `StructuredTextItem` subset. */
export interface LayoutItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  readonly hasEOL: boolean;
}

interface Line {
  readonly text: string;
  readonly y: number;
  readonly x: number;
  readonly fontSize: number;
}

/** Insert a space when the horizontal gap exceeds this share of the font size. */
const SPACE_GAP_RATIO = 0.2;
/** Two items are on the same line when their baselines differ by less than this share. */
const LINE_TOLERANCE_RATIO = 0.5;
/** A vertical jump larger than this multiple of the median line spacing starts a paragraph. */
const PARAGRAPH_GAP_RATIO = 1.4;
/** A run of empty bins this wide, mid-page, is a column gutter. */
const GUTTER_MIN_SHARE = 0.06;
/** Each column must hold at least this share of the page's items. */
const COLUMN_MIN_ITEM_SHARE = 0.15;
/** A repeated first or last line on this share of pages is furniture, not content. */
const FURNITURE_PAGE_SHARE = 0.6;

const NUMBERING_START =
  /^(?:\(?\d+(?:\.\d+)*\)?[.)]?\s|\(?[a-z]\)\s|\(?(?:x{0,3})(?:ix|iv|v?i{1,3})\)\s|(?:article|section|clause|schedule|annexure|appendix|part)\b)/i;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function isBlank(item: LayoutItem): boolean {
  return item.str.trim().length === 0;
}

/**
 * Split a page into columns by finding an empty vertical gutter.
 *
 * Deliberately conservative: it requires a single clear gutter with substantial content on both
 * sides. A false positive here would split a full-width paragraph in half, which is worse than
 * failing to detect a column.
 */
export function detectColumns(all: readonly LayoutItem[]): readonly (readonly LayoutItem[])[] {
  // Blank runs must go first, and not only for tidiness. pdf.js synthesises a whitespace item
  // spanning the gap between two distant text runs, so on a real two-column page there is a
  // space item lying directly across the gutter. Counting it as coverage hides the gutter
  // completely and the page reads back interleaved — measured on a fixture, not theorised.
  const items = all.filter((i) => !isBlank(i));
  if (items.length < 8) return [all];

  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  const span = maxX - minX;
  if (span <= 0) return [all];

  const binCount = 100;
  const covered = new Array<boolean>(binCount).fill(false);
  for (const item of items) {
    const from = Math.floor(((item.x - minX) / span) * binCount);
    const to = Math.ceil(((item.x + item.width - minX) / span) * binCount);
    for (let b = Math.max(0, from); b < Math.min(binCount, Math.max(to, from + 1)); b += 1) {
      covered[b] = true;
    }
  }

  const gutters: { start: number; end: number }[] = [];
  let runStart: number | null = null;
  for (let b = 0; b < binCount; b += 1) {
    if (covered[b] === false) {
      if (runStart === null) runStart = b;
    } else if (runStart !== null) {
      gutters.push({ start: runStart, end: b });
      runStart = null;
    }
  }

  const interior = gutters.filter(
    (g) => g.start > 0 && g.end < binCount && (g.end - g.start) / binCount >= GUTTER_MIN_SHARE,
  );
  if (interior.length !== 1) return [all];

  const gutter = interior[0];
  if (gutter === undefined) return [all];

  const splitX = minX + ((gutter.start + gutter.end) / 2 / binCount) * span;
  const left = items.filter((i) => i.x + i.width / 2 < splitX);
  const right = items.filter((i) => i.x + i.width / 2 >= splitX);

  const minItems = items.length * COLUMN_MIN_ITEM_SHARE;
  if (left.length < minItems || right.length < minItems) return [all];

  // Both columns must run down most of the page; a sidebar or a stamp is not a column.
  const pageHeight = Math.max(...items.map((i) => i.y)) - Math.min(...items.map((i) => i.y));
  const spansPage = (group: readonly LayoutItem[]): boolean => {
    if (pageHeight <= 0) return true;
    const height = Math.max(...group.map((i) => i.y)) - Math.min(...group.map((i) => i.y));
    return height / pageHeight >= 0.5;
  };
  if (!spansPage(left) || !spansPage(right)) return [all];

  return [left, right];
}

/** Assemble items into lines, inserting the spaces the PDF did not encode. */
export function assembleLines(items: readonly LayoutItem[]): readonly Line[] {
  const present = items.filter((i) => !isBlank(i));
  if (present.length === 0) return [];

  const fontSize = median(present.map((i) => i.fontSize)) || 10;
  const tolerance = fontSize * LINE_TOLERANCE_RATIO;

  // PDF space has its origin bottom-left, so reading order is descending y then ascending x.
  const sorted = [...present].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  let group: LayoutItem[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let text = '';
    let previous: LayoutItem | undefined;
    for (const item of ordered) {
      if (previous !== undefined) {
        const gap = item.x - (previous.x + previous.width);
        const needsSpace = gap > previous.fontSize * SPACE_GAP_RATIO;
        if (needsSpace && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
      }
      text += item.str;
      previous = item;
    }
    const first = ordered[0];
    lines.push({
      text: collapseWhitespace(text),
      y: first?.y ?? 0,
      x: first?.x ?? 0,
      fontSize: Math.max(...ordered.map((i) => i.fontSize)),
    });
    group = [];
  };

  for (const item of sorted) {
    const current = group[0];
    if (current !== undefined && Math.abs(current.y - item.y) > tolerance) flush();
    group.push(item);
  }
  flush();

  return lines.filter((line) => line.text.length > 0);
}

function headingLevelFor(line: Line, medianFontSize: number): number | undefined {
  const ratio = medianFontSize === 0 ? 1 : line.fontSize / medianFontSize;
  const short = line.text.length <= 90;
  const allCaps = short && line.text === line.text.toUpperCase() && /[A-Z]{3}/.test(line.text);
  const keyword = /^(?:article|section|clause|schedule|annexure|part)\b/i.test(line.text);

  if (ratio >= 1.5) return 1;
  if (ratio >= 1.2) return 2;
  if (allCaps || (keyword && short)) return 3;
  return undefined;
}

/**
 * Group lines into paragraph blocks.
 *
 * A new block starts on a vertical jump, on a clause number, or at a heading — the three signals
 * that actually mark a clause boundary in a lease. `hasEOL` is consulted as one input among
 * several and never as the sole line splitter: it was perfect on a synthetic fixture that emitted
 * one `Td` per line, which is the easiest possible case, while pdf.js issues document erratic item
 * splitting on real documents.
 */
export function groupIntoBlocks(lines: readonly Line[], page: number): readonly Block[] {
  if (lines.length === 0) return [];

  const medianFontSize = median(lines.map((l) => l.fontSize)) || 10;
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1];
    const current = lines[i];
    if (previous !== undefined && current !== undefined) deltas.push(previous.y - current.y);
  }
  const medianDelta = median(deltas.filter((d) => d > 0)) || medianFontSize * 1.2;

  const blocks: Block[] = [];
  let buffer: Line[] = [];
  let bufferHeading: number | undefined;

  const flush = (): void => {
    if (buffer.length === 0) return;
    blocks.push({
      text: buffer.map((l) => l.text).join(' '),
      page,
      ...(bufferHeading === undefined ? {} : { headingLevel: bufferHeading }),
      fontSize: Math.max(...buffer.map((l) => l.fontSize)),
    });
    buffer = [];
    bufferHeading = undefined;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const previous = lines[i - 1];
    const heading = headingLevelFor(line, medianFontSize);

    const verticalBreak =
      previous !== undefined && previous.y - line.y > medianDelta * PARAGRAPH_GAP_RATIO;
    const numberedBreak = NUMBERING_START.test(line.text);
    const headingBreak = heading !== undefined || bufferHeading !== undefined;

    if (buffer.length > 0 && (verticalBreak || numberedBreak || headingBreak)) flush();

    if (buffer.length === 0) bufferHeading = heading;
    buffer.push(line);
  }
  flush();

  return blocks;
}

/**
 * Drop page headers and footers.
 *
 * Detected by repetition rather than by position: a line that is the first or last line on most
 * pages is furniture. Left in, each repetition becomes a spurious clause, and "Page 3 of 12"
 * ends up cited as a term of the tenancy.
 */
export function removeRepeatedFurniture(pages: readonly (readonly Line[])[]): {
  readonly pages: readonly (readonly Line[])[];
  readonly removed: readonly string[];
} {
  if (pages.length < 3) return { pages, removed: [] };

  const counts = new Map<string, number>();
  const bump = (line: Line | undefined): void => {
    if (line === undefined) return;
    const key = normaliseFurniture(line.text);
    if (key.length === 0) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const lines of pages) {
    bump(lines[0]);
    bump(lines[lines.length - 1]);
  }

  const threshold = Math.ceil(pages.length * FURNITURE_PAGE_SHARE);
  const furniture = new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key),
  );
  if (furniture.size === 0) return { pages, removed: [] };

  const cleaned = pages.map((lines) =>
    lines.filter((line, index) => {
      const edge = index === 0 || index === lines.length - 1;
      return !(edge && furniture.has(normaliseFurniture(line.text)));
    }),
  );
  return { pages: cleaned, removed: [...furniture] };
}

/** Fold the page number out so "Page 3 of 12" and "Page 4 of 12" compare equal. */
function normaliseFurniture(text: string): string {
  return collapseWhitespace(text.toLowerCase().replace(/\d+/g, '#'));
}

export interface LayoutResult {
  readonly blocks: readonly Block[];
  readonly warnings: readonly string[];
}

/** The whole pipeline: items per page in, paragraph blocks out. */
export function layoutPages(pages: readonly (readonly LayoutItem[])[]): LayoutResult {
  const perPageLines: (readonly Line[])[] = pages.map((items) =>
    detectColumns(items).flatMap((column) => assembleLines(column)),
  );

  const { pages: cleaned, removed } = removeRepeatedFurniture(perPageLines);
  const blocks = cleaned.flatMap((lines, index) => groupIntoBlocks(lines, index + 1));

  const warnings =
    removed.length === 0
      ? []
      : [
          `Removed ${removed.length} repeating page header or footer line${removed.length === 1 ? '' : 's'} so they are not read as clauses.`,
        ];

  return { blocks, warnings };
}
