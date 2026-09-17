import { describe, expect, it } from 'vitest';
import { buildDocx, buildZip } from '../../../../test/fixtures/zip.ts';
import {
  assertFileSize,
  assertNotZipBomb,
  assertPageCount,
  assertTextSize,
  decodeUtf8Strict,
  formatBytes,
  LIMITS,
  readZipCentralDirectory,
} from './guards.ts';
import { type IngestErrorCode, isIngestError } from './types.ts';

/**
 * The resource guards, one control at a time.
 *
 * `test/adversarial.test.ts` proves a real bomb is refused end to end. This file pins each branch
 * of the central-directory reader against a hand-corrupted archive, because every one of them is
 * reachable by an attacker who writes the bytes directly — and the requirement for each is the
 * same: a typed refusal before anything is decompressed, never a crash and never a hang.
 */

function codeOf(run: () => unknown): IngestErrorCode | 'no error' {
  try {
    run();
    return 'no error';
  } catch (error) {
    if (isIngestError(error)) return error.code;
    throw error;
  }
}

/** Offset of the n-th central directory record, read from the end-of-central-directory record. */
function centralRecord(bytes: Uint8Array, index = 0): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = view.getUint32(bytes.byteLength - 22 + 16, true);
  for (let i = 0; i < index; i += 1) {
    cursor += 46 + view.getUint16(cursor + 28, true);
  }
  return cursor;
}

function patched(bytes: Uint8Array, write: (view: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  write(new DataView(copy.buffer));
  return copy;
}

const EOCD_DIRECTORY_OFFSET = 16;

describe('readZipCentralDirectory', () => {
  const docx = buildDocx([{ text: 'The tenant shall pay rent monthly.' }]);

  it('lists every entry with its declared sizes, without inflating any of them', () => {
    const entries = readZipCentralDirectory(docx);
    expect(entries.map((e) => e.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    for (const entry of entries) {
      expect(entry.uncompressedSize).toBeGreaterThan(0);
      expect(entry.compressedSize).toBeGreaterThan(0);
    }
  });

  it('refuses a directory offset that points past the end of the file', () => {
    const corrupt = patched(docx, (view) =>
      view.setUint32(docx.byteLength - 22 + EOCD_DIRECTORY_OFFSET, docx.byteLength + 10, true),
    );
    expect(codeOf(() => readZipCentralDirectory(corrupt))).toBe('ZIP_MALFORMED');
  });

  it('refuses a record whose signature is wrong', () => {
    const corrupt = patched(docx, (view) =>
      view.setUint32(centralRecord(docx, 1), 0xdeadbeef, true),
    );
    expect(codeOf(() => readZipCentralDirectory(corrupt))).toBe('ZIP_MALFORMED');
  });

  it('refuses a record whose declared lengths run past the end of the file', () => {
    // The first record's name length pushes the cursor for the next record off the buffer.
    const corrupt = patched(docx, (view) =>
      view.setUint16(centralRecord(docx, 0) + 28, 60_000, true),
    );
    expect(codeOf(() => readZipCentralDirectory(corrupt))).toBe('ZIP_MALFORMED');
  });

  it('fails closed on a ZIP64 size sentinel instead of trusting a 4 GB entry', () => {
    for (const field of [20, 24]) {
      const corrupt = patched(docx, (view) =>
        view.setUint32(centralRecord(docx, 2) + field, 0xffff_ffff, true),
      );
      expect(
        codeOf(() => readZipCentralDirectory(corrupt)),
        `offset ${field}`,
      ).toBe('ZIP_BOMB');
    }
  });

  it('refuses bytes with no end-of-central-directory record at all', () => {
    expect(codeOf(() => readZipCentralDirectory(new Uint8Array(64)))).toBe('ZIP_MALFORMED');
  });
});

describe('assertNotZipBomb', () => {
  it('accepts an ordinary document and returns its entries', () => {
    expect(assertNotZipBomb(buildDocx([{ text: 'Rent is due monthly.' }]))).toHaveLength(3);
  });

  it('accepts an empty entry, which has no ratio to speak of', () => {
    const zip = buildZip([
      { name: 'word/document.xml', content: '<w:document/>', store: true },
      { name: 'word/empty.xml', content: '', store: true },
    ]);
    const entries = assertNotZipBomb(zip);
    expect(entries.find((e) => e.name === 'word/empty.xml')?.compressedSize).toBe(0);
  });

  it('refuses an entry that declares a ratio above the limit, naming the entry', () => {
    const zip = buildZip([{ name: 'word/document.xml', content: 'x'.repeat(1000), store: true }]);
    const bomb = patched(zip, (view) =>
      view.setUint32(centralRecord(zip) + 24, 1000 * (LIMITS.maxZipRatio + 1), true),
    );
    try {
      assertNotZipBomb(bomb);
      expect.unreachable('a declared 101:1 entry must be refused');
    } catch (error) {
      expect(isIngestError(error) && error.code).toBe('ZIP_BOMB');
      expect(isIngestError(error) && error.message).toMatch(
        /"word\/document\.xml" expands 101 times/,
      );
    }
  });

  it('refuses an archive whose entries together expand past the total ceiling', () => {
    // Each entry stays under the per-entry ratio, so only the total can catch this one.
    const each = 4_000_000;
    const zip = buildZip(
      Array.from({ length: 14 }, (_, i) => ({
        name: `word/part${i}.xml`,
        content: 'x'.repeat(100),
        store: true,
      })),
    );
    const inflated = patched(zip, (view) => {
      for (let i = 0; i < 14; i += 1) {
        const record = centralRecord(zip, i);
        view.setUint32(record + 20, each / 50, true);
        view.setUint32(record + 24, each, true);
      }
    });
    try {
      assertNotZipBomb(inflated);
      expect.unreachable('56,000,000 declared bytes must be refused');
    } catch (error) {
      expect(isIngestError(error) && error.code).toBe('ZIP_BOMB');
      expect(isIngestError(error) && error.message).toMatch(
        /expands to 53\.4 MB, above the 47\.7 MB limit/,
      );
    }
  });
});

describe('decodeUtf8Strict', () => {
  it('returns valid UTF-8 text unchanged, including non-Latin scripts', () => {
    const text = 'किराया ₹25,000 प्रति माह — rent £1,200.';
    expect(decodeUtf8Strict(new TextEncoder().encode(text))).toBe(text);
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(codeOf(() => decodeUtf8Strict(new Uint8Array([0x52, 0xff, 0xfe, 0x6e])))).toBe(
      'NOT_UTF8',
    );
  });

  it('refuses text carrying a NUL byte, which is a binary file wearing a .txt name', () => {
    const bytes = new Uint8Array([0x52, 0x65, 0x6e, 0x74, 0x00, 0x21]);
    expect(codeOf(() => decodeUtf8Strict(bytes))).toBe('NOT_UTF8');
  });
});

describe('size and page ceilings', () => {
  it('accepts a file at the byte limit and refuses one byte more', () => {
    expect(codeOf(() => assertFileSize(LIMITS.maxFileBytes))).toBe('no error');
    expect(codeOf(() => assertFileSize(LIMITS.maxFileBytes + 1))).toBe('FILE_TOO_LARGE');
    expect(codeOf(() => assertFileSize(0))).toBe('EMPTY_DOCUMENT');
  });

  it('accepts a PDF at the page limit and refuses one page more', () => {
    expect(codeOf(() => assertPageCount(LIMITS.maxPages))).toBe('no error');
    expect(codeOf(() => assertPageCount(LIMITS.maxPages + 1))).toBe('TOO_MANY_PAGES');
  });

  it('refuses whitespace-only text as empty', () => {
    expect(codeOf(() => assertTextSize(' \n\t '))).toBe('EMPTY_DOCUMENT');
    expect(codeOf(() => assertTextSize('Rent is due.'))).toBe('no error');
  });
});

describe('formatBytes', () => {
  it('uses the unit a reader expects at each scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(LIMITS.maxFileBytes)).toBe('3.8 MB');
  });
});
