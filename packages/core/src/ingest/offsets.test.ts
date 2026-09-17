import { describe, expect, it } from 'vitest';
import { assertOffsetInvariant, buildDocument, pageAtOffset } from './offsets.ts';

/**
 * The canonical text and its offsets. Every citation is an offset into this string, and every page
 * number printed beside a citation comes from `pageAtOffset`, so both are pinned directly.
 */

describe('buildDocument', () => {
  it('drops blocks that normalise to nothing, without leaving a stray separator', () => {
    const document = buildDocument(
      [
        { text: 'First clause.', page: 1 },
        { text: '   \n\t ', page: 1 },
        { text: 'Second clause.', page: 2, headingLevel: 2, fontSize: 14 },
      ],
      { sourceKind: 'pdf', pageCount: 2 },
    );
    expect(document.text).toBe('First clause.\n\nSecond clause.');
    expect(document.items).toHaveLength(2);
    expect(document.items[1]).toMatchObject({ page: 2, headingLevel: 2, fontSize: 14 });
    expect(document.meta).toEqual({});
    expect(document.warnings).toEqual([]);
  });

  it('reports at least one page even when the source reports none', () => {
    const document = buildDocument([{ text: 'Rent is due.', page: 1 }], {
      sourceKind: 'text',
      pageCount: 0,
    });
    expect(document.pageCount).toBe(1);
  });
});

describe('assertOffsetInvariant', () => {
  it('throws, naming the offsets, when an item no longer slices out its own text', () => {
    const document = buildDocument([{ text: 'The tenant shall pay rent.', page: 1 }], {
      sourceKind: 'text',
      pageCount: 1,
    });
    const [item] = document.items;
    if (item === undefined) throw new Error('expected an item');
    const broken = { ...document, items: [{ ...item, charStart: 1, charEnd: item.charEnd + 1 }] };
    expect(() => assertOffsetInvariant(broken)).toThrow(/Offset invariant broken at 1\.\.27/);
  });
});

describe('pageAtOffset', () => {
  const document = buildDocument(
    [
      { text: 'Page one text.', page: 1 },
      { text: 'Page two text.', page: 2 },
      { text: 'Page four text.', page: 4 },
    ],
    { sourceKind: 'pdf', pageCount: 4 },
  );

  it('returns the page of the item an offset falls in', () => {
    const [, second, third] = document.items;
    expect(pageAtOffset(document, 0)).toBe(1);
    expect(pageAtOffset(document, second?.charStart ?? -1)).toBe(2);
    expect(pageAtOffset(document, (third?.charEnd ?? 0) - 1)).toBe(4);
  });

  it('keeps the earlier page for an offset in the separator before the next item', () => {
    const [first] = document.items;
    expect(pageAtOffset(document, (first?.charEnd ?? 0) + 1)).toBe(1);
  });
});
