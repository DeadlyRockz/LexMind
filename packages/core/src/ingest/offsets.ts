import { sha256, shortId } from '../util/hash.ts';
import { collapseWhitespace, normalizeText } from '../util/text.ts';
import { assertTextSize } from './guards.ts';
import type {
  Block,
  DocumentMeta,
  NormalizedDocument,
  PositionedItem,
  SourceKind,
} from './types.ts';

/** Paragraphs are separated by exactly this in the canonical text. */
const BLOCK_SEPARATOR = '\n\n';

/**
 * Assemble the canonical document from parsed blocks.
 *
 * The invariant this function exists to guarantee:
 *
 *     document.text.slice(item.charStart, item.charEnd) === item.text
 *
 * It holds *by construction* because the text is built from the items, in one pass, rather than
 * produced separately and then indexed. Every highlight, citation, comparison anchor and
 * "jump to clause" interaction in LexMind is an offset into this string, so the cheapest way to
 * make them all correct is to make it impossible for them to disagree.
 */
export function buildDocument(
  blocks: readonly Block[],
  options: {
    readonly sourceKind: SourceKind;
    readonly pageCount: number;
    readonly meta?: DocumentMeta;
    readonly warnings?: readonly string[];
  },
): NormalizedDocument {
  const items: PositionedItem[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const block of blocks) {
    // Normalize first, then flatten to one line: a paragraph is a unit of meaning, and internal
    // line breaks are an artefact of the page it was printed on.
    const text = collapseWhitespace(normalizeText(block.text));
    if (text.length === 0) continue;

    if (items.length > 0) {
      parts.push(BLOCK_SEPARATOR);
      cursor += BLOCK_SEPARATOR.length;
    }

    parts.push(text);
    items.push({
      text,
      charStart: cursor,
      charEnd: cursor + text.length,
      page: block.page,
      ...(block.headingLevel === undefined ? {} : { headingLevel: block.headingLevel }),
      ...(block.fontSize === undefined ? {} : { fontSize: block.fontSize }),
    });
    cursor += text.length;
  }

  const text = parts.join('');
  assertTextSize(text);

  const hash = sha256(text);
  return {
    id: shortId(text),
    sha256: hash,
    text,
    items,
    pageCount: Math.max(1, options.pageCount),
    sourceKind: options.sourceKind,
    meta: options.meta ?? {},
    warnings: options.warnings ?? [],
  };
}

/** Assert the offset invariant. Called at every boundary that could shift offsets. */
export function assertOffsetInvariant(document: NormalizedDocument): void {
  for (const item of document.items) {
    const sliced = document.text.slice(item.charStart, item.charEnd);
    if (sliced !== item.text) {
      throw new Error(
        `Offset invariant broken at ${item.charStart}..${item.charEnd}: ` +
          `expected ${JSON.stringify(item.text.slice(0, 40))}, ` +
          `got ${JSON.stringify(sliced.slice(0, 40))}`,
      );
    }
  }
}

/** The 1-based page an offset falls on. Used to put a page number next to every citation. */
export function pageAtOffset(document: NormalizedDocument, offset: number): number {
  let page = 1;
  for (const item of document.items) {
    if (item.charStart > offset) break;
    page = item.page;
  }
  return page;
}
