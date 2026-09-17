import { describe, expect, it } from 'vitest';
import { extractBlocks } from './docx.ts';

/**
 * `extractBlocks` is the only logic between mammoth's HTML and the canonical document text, and that
 * HTML is derived from an attacker-supplied file. So two properties are pinned: markup never survives
 * into text, and no entity — however malformed — turns into a crash.
 */

describe('extractBlocks', () => {
  it('keeps heading levels and reads paragraphs, list items and table cells', () => {
    const blocks = extractBlocks(
      '<h1>ARTICLE 5 — SECURITY DEPOSIT</h1><p>The deposit is two months rent.</p>' +
        '<ul><li>Refundable on vacating.</li></ul><table><tr><th>Rent</th><td>25,000</td></tr></table>',
    );
    expect(blocks).toEqual([
      { text: 'ARTICLE 5 — SECURITY DEPOSIT', page: 1, headingLevel: 1 },
      { text: 'The deposit is two months rent.', page: 1 },
      { text: 'Refundable on vacating.', page: 1 },
      { text: 'Rent', page: 1 },
      { text: '25,000', page: 1 },
    ]);
  });

  it('drops script and style content and every attribute, so no markup reaches the text', () => {
    const blocks = extractBlocks(
      '<script>alert(1)</script><style>p{}</style>' +
        '<p><a href="javascript:alert(1)">Clause 3</a> applies.</p>',
    );
    expect(blocks.map((b) => b.text)).toEqual([' Clause 3  applies.']);
    expect(JSON.stringify(blocks)).not.toMatch(/javascript|alert|<|>/);
  });

  it('skips a block that holds only whitespace or empty markup', () => {
    expect(extractBlocks('<p>   </p><p><span></span></p><h2>TERM</h2>')).toEqual([
      { text: 'TERM', page: 1, headingLevel: 2 },
    ]);
  });

  it('decodes named, decimal and hexadecimal entities', () => {
    expect(
      extractBlocks('<p>Rent &amp; deposit &lt;&gt; &quot;A&apos; &#x41;&#66;&nbsp;due</p>')[0]
        ?.text,
    ).toBe('Rent & deposit <> "A\' AB due');
  });

  it('leaves an unknown named entity exactly as written', () => {
    expect(extractBlocks('<p>&copy; &unknown;</p>')[0]?.text).toBe('&copy; &unknown;');
  });

  it('never decodes a name inherited from Object.prototype', () => {
    // Regression: `&constructor;` once decoded to "function Object() { [native code] }".
    const text = '&constructor; &toString; &hasOwnProperty; &valueOf;';
    expect(extractBlocks(`<p>${text}</p>`)[0]?.text).toBe(text);
  });

  it('leaves a numeric reference that names no character as written, instead of throwing', () => {
    // Regression: `String.fromCodePoint` throws a RangeError above U+10FFFF, so each of the first two
    // escaped as a raw exception from the ingest boundary.
    expect(extractBlocks('<p>&#x110000;</p>')[0]?.text).toBe('&#x110000;');
    expect(extractBlocks('<p>&#99999999;</p>')[0]?.text).toBe('&#99999999;');
    // "#abc" matches the entity shape but is not a decimal number.
    expect(extractBlocks('<p>&#abc;</p>')[0]?.text).toBe('&#abc;');
  });

  it('decodes the highest valid code point', () => {
    expect(extractBlocks('<p>&#x10FFFF;</p>')[0]?.text).toBe(String.fromCodePoint(0x10ffff));
  });
});
