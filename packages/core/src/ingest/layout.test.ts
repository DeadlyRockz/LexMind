import { describe, expect, it } from 'vitest';
import {
  assembleLines,
  detectColumns,
  groupIntoBlocks,
  type LayoutItem,
  layoutPages,
  removeRepeatedFurniture,
} from './layout.ts';

/** A text run at a position. PDF space, so y counts up from the bottom of the page. */
function item(
  str: string,
  x: number,
  y: number,
  options?: { readonly width?: number; readonly fontSize?: number },
): LayoutItem {
  const fontSize = options?.fontSize ?? 11;
  return {
    str,
    x,
    y,
    width: options?.width ?? str.length * fontSize * 0.5,
    fontSize,
    hasEOL: false,
  };
}

/** One text run per line, laid out top to bottom at a fixed left margin. */
function singleColumn(lines: readonly string[], startY = 700, step = 20): LayoutItem[] {
  return lines.map((text, i) => item(text, 72, startY - i * step));
}

describe('assembleLines', () => {
  it('orders lines top to bottom despite PDF space counting upward', () => {
    const items = [item('third', 72, 660), item('first', 72, 700), item('second', 72, 680)];
    expect(assembleLines(items).map((l) => l.text)).toEqual(['first', 'second', 'third']);
  });

  it('joins runs on the same baseline, left to right', () => {
    const items = [item('deposit', 200, 700), item('Security', 72, 700)];
    expect(assembleLines(items)[0]?.text).toBe('Security deposit');
  });

  it('inserts the space the PDF did not encode when there is a gap', () => {
    const items = [item('thirty', 72, 700, { width: 30 }), item('days', 120, 700)];
    expect(assembleLines(items)[0]?.text).toBe('thirty days');
  });

  it('does not insert a space when runs abut, so a word is not split', () => {
    const items = [item('inden', 72, 700, { width: 30 }), item('mnify', 102, 700)];
    expect(assembleLines(items)[0]?.text).toBe('indenmnify');
  });

  it('treats baselines within half a font size as one line', () => {
    const items = [item('same', 72, 700), item('line', 140, 700.4)];
    expect(assembleLines(items)).toHaveLength(1);
  });

  it('ignores whitespace-only runs', () => {
    expect(assembleLines([item('   ', 72, 700), item('real', 72, 680)])).toHaveLength(1);
  });

  it('returns nothing for an empty page', () => {
    expect(assembleLines([])).toEqual([]);
  });
});

describe('detectColumns', () => {
  it('splits a genuine two-column page', () => {
    const items: LayoutItem[] = [];
    for (let i = 0; i < 12; i += 1) {
      items.push(item('left text here', 60, 700 - i * 20, { width: 180 }));
      items.push(item('right text here', 330, 700 - i * 20, { width: 180 }));
    }
    expect(detectColumns(items)).toHaveLength(2);
  });

  it('leaves a full-width page as one column — a false split would halve every paragraph', () => {
    const items = singleColumn(
      Array.from({ length: 12 }, (_, i) => `full width line number ${i} running across the page`),
    ).map((it) => ({ ...it, width: 460 }));
    expect(detectColumns(items)).toHaveLength(1);
  });

  it('does not treat a short sidebar as a column, because it does not span the page', () => {
    const items: LayoutItem[] = [];
    for (let i = 0; i < 12; i += 1) items.push(item('body text', 60, 700 - i * 20, { width: 180 }));
    for (let i = 0; i < 3; i += 1) items.push(item('stamp', 400, 700 - i * 20, { width: 80 }));
    expect(detectColumns(items)).toHaveLength(1);
  });

  it('does not attempt column detection on a sparse page', () => {
    expect(detectColumns(singleColumn(['a', 'b']))).toHaveLength(1);
  });

  it('still finds the gutter when pdf.js lays a synthetic space run across it', () => {
    // Measured, not theorised: pdf.js emits a whitespace item spanning the gap between two
    // distant text runs, so on a real two-column page a space item sits directly across the
    // gutter. Counting it as coverage hides the gutter and the page reads back interleaved.
    const items: LayoutItem[] = [];
    for (let i = 0; i < 12; i += 1) {
      const y = 700 - i * 20;
      items.push(item('left text here', 60, y, { width: 180 }));
      items.push(item(' ', 240, y, { width: 90 }));
      items.push(item('right text here', 330, y, { width: 180 }));
    }
    expect(detectColumns(items)).toHaveLength(2);
  });
});

describe('groupIntoBlocks', () => {
  it('starts a new block at each numbered clause', () => {
    const lines = assembleLines(
      singleColumn([
        '1. The tenant shall pay rent',
        'on the first day of each month.',
        '2. The landlord shall keep the structure in repair.',
      ]),
    );
    const blocks = groupIntoBlocks(lines, 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe('1. The tenant shall pay rent on the first day of each month.');
  });

  it('marks a larger-font line as a heading', () => {
    const lines = assembleLines([
      item('ARTICLE 8 - SECURITY DEPOSIT', 72, 700, { fontSize: 18 }),
      item('The deposit is two months rent.', 72, 670, { fontSize: 11 }),
      item('It is refundable on vacating.', 72, 650, { fontSize: 11 }),
    ]);
    const blocks = groupIntoBlocks(lines, 1);
    expect(blocks[0]?.headingLevel).toBe(1);
    expect(blocks[1]?.headingLevel).toBeUndefined();
  });

  it('marks an ALL-CAPS line as a heading even at body font size', () => {
    const lines = assembleLines(singleColumn(['SECURITY DEPOSIT', 'The deposit is refundable.']));
    expect(groupIntoBlocks(lines, 1)[0]?.headingLevel).toBe(3);
  });

  it('starts a new block on a large vertical jump', () => {
    const lines = assembleLines([
      item('first paragraph text', 72, 700),
      item('continues here', 72, 680),
      item('a new paragraph after a gap', 72, 590),
    ]);
    expect(groupIntoBlocks(lines, 1)).toHaveLength(2);
  });

  it('records the page number on every block', () => {
    const blocks = groupIntoBlocks(assembleLines(singleColumn(['text'])), 7);
    expect(blocks[0]?.page).toBe(7);
  });

  it('returns nothing for no lines', () => {
    expect(groupIntoBlocks([], 1)).toEqual([]);
  });
});

describe('layoutPages', () => {
  it('reads a two-column page column by column, not row by row', () => {
    const items: LayoutItem[] = [];
    // Interleaved on purpose: this is how a PDF content stream actually emits two columns.
    for (let i = 0; i < 10; i += 1) {
      items.push(item(`left line ${i} of the first column`, 60, 700 - i * 20, { width: 180 }));
      items.push(item(`right line ${i} of the second column`, 330, 700 - i * 20, { width: 180 }));
    }
    const text = layoutPages([items])
      .blocks.map((b) => b.text)
      .join(' ');

    const lastLeft = text.lastIndexOf('left line 9');
    const firstRight = text.indexOf('right line 0');
    expect(lastLeft).toBeGreaterThan(-1);
    expect(firstRight).toBeGreaterThan(-1);
    expect(lastLeft, 'the whole left column must precede the right').toBeLessThan(firstRight);
  });

  it('drops a repeating header and footer so they are not read as clauses', () => {
    const pages = Array.from({ length: 4 }, (_, p) =>
      assembleLinesInput([
        'RESIDENTIAL TENANCY AGREEMENT',
        `Clause ${p + 1}: the tenant shall pay rent monthly.`,
        `Page ${p + 1} of 4`,
      ]),
    );
    const result = layoutPages(pages);
    const joined = result.blocks.map((b) => b.text).join('\n');

    expect(joined).not.toMatch(/RESIDENTIAL TENANCY AGREEMENT/);
    expect(joined).not.toMatch(/Page \d of 4/);
    expect(joined).toMatch(/Clause 1/);
    expect(result.warnings[0]).toMatch(/repeating page header or footer/);
  });

  it('keeps a heading that appears on only one page', () => {
    const pages = [
      assembleLinesInput(['RESIDENTIAL TENANCY AGREEMENT', 'Clause 1: rent is due monthly.']),
      assembleLinesInput(['Clause 2: the deposit is refundable.']),
      assembleLinesInput(['Clause 3: notice is thirty days.']),
    ];
    const joined = layoutPages(pages)
      .blocks.map((b) => b.text)
      .join('\n');
    expect(joined).toMatch(/RESIDENTIAL TENANCY AGREEMENT/);
  });

  it('does not attempt furniture removal on a short document', () => {
    const pages = [assembleLinesInput(['HEADER', 'body']), assembleLinesInput(['HEADER', 'body'])];
    expect(layoutPages(pages).warnings).toEqual([]);
  });
});

function assembleLinesInput(lines: readonly string[]): LayoutItem[] {
  return lines.map((text, i) => item(text, 72, 740 - i * 40));
}

describe('layout on degenerate geometry', () => {
  it('does not split a page whose items have no horizontal extent', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item(`line ${i}`, 72, 700 - i * 20, { width: 0 }),
    );
    expect(detectColumns(items)).toEqual([items]);
  });

  it('does not treat a lone item across a gutter as a column', () => {
    const items: LayoutItem[] = [];
    for (let i = 0; i < 12; i += 1) items.push(item('body text', 60, 700 - i * 20, { width: 180 }));
    items.push(item('initials', 400, 400, { width: 100 }));
    expect(detectColumns(items)).toHaveLength(1);
  });

  it('splits a single-row page with a clear gutter, since there is no height to measure', () => {
    const items: LayoutItem[] = [];
    for (let i = 0; i < 5; i += 1) {
      items.push(item(`L${i}`, 40 + i * 30, 700, { width: 25 }));
      items.push(item(`R${i}`, 400 + i * 30, 700, { width: 25 }));
    }
    const columns = detectColumns(items);
    expect(columns).toHaveLength(2);
    expect(columns[0]?.map((i) => i.str)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('assumes a nominal font size when the PDF reports none, so baselines still group', () => {
    const lines = assembleLines([
      item('Security', 72, 700, { fontSize: 0, width: 40 }),
      item('deposit', 130, 703, { fontSize: 0, width: 40 }),
      item('Refundable', 72, 680, { fontSize: 0, width: 50 }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Security deposit', 'Refundable']);
    expect(groupIntoBlocks(lines, 1).map((b) => b.text)).toEqual(['Security deposit Refundable']);
  });
});

describe('removeRepeatedFurniture', () => {
  const line = (text: string) => ({ text, x: 72, y: 700, fontSize: 11 });

  it('removes nothing when no edge line repeats, and survives a blank page', () => {
    const pages = [[line('Clause one.')], [], [line('Clause two.')], [line('Clause three.')]];
    const result = removeRepeatedFurniture(pages);
    expect(result.removed).toEqual([]);
    expect(result.pages).toBe(pages);
  });

  it('never counts an edge line with no text as furniture', () => {
    const pages = [
      [line(' '), line('Clause one.')],
      [line(' '), line('Clause two.')],
      [line(' '), line('Clause three.')],
    ];
    expect(removeRepeatedFurniture(pages).removed).toEqual([]);
  });

  it('warns in the singular when one repeating line was dropped', () => {
    const pages = Array.from({ length: 3 }, (_, p) =>
      assembleLinesInput([`Clause ${'ABC'[p]}: the tenant shall pay rent.`, `Page ${p + 1} of 3`]),
    );
    const result = layoutPages(pages);
    expect(result.warnings).toEqual([
      'Removed 1 repeating page header or footer line so they are not read as clauses.',
    ]);
    expect(result.blocks.map((b) => b.text).join(' ')).not.toMatch(/Page \d of 3/);
  });
});
