import { IngestError } from './types.ts';

/**
 * Resource ceilings, enforced before any parsing and long before any model call.
 *
 * Every number here is simultaneously a cost control and a security control — OWASP LLM06 names
 * the failure mode "Denial of Wallet" — so they are documented once, here, and cross-referenced
 * from `docs/SECURITY.md`.
 */
export const LIMITS = {
  /** Vercel caps request bodies at 4.5 MB, so accepting more would fail later and less clearly. */
  maxFileBytes: 4_000_000,
  /** `numPages` is available from the PDF header before any page is touched. */
  maxPages: 300,
  /** A real lease DOCX has fewer than 30 entries; `file-type` itself works to 1024. */
  maxZipEntries: 512,
  /**
   * Per-entry compression ratio. Real `word/document.xml` measures 1-2x. Measured zip bombs
   * reach 258x and 1029x, so 100:1 sits in a very wide gap between the two populations.
   */
  maxZipRatio: 100,
  /** Total decompressed bytes. A measured 61 MB bomb consumed 2.2 GB of RSS. */
  maxZipTotalBytes: 50_000_000,
  /** Roughly a 300-page lease. Above this we refuse rather than silently truncate. */
  maxTextChars: 1_500_000,
  /** Below this many non-whitespace characters per page, a PDF page looks like a scan. */
  scannedMinCharsPerPage: 100,
} as const;

export function assertFileSize(byteLength: number): void {
  if (byteLength === 0) {
    throw new IngestError('EMPTY_DOCUMENT', 'The file is empty.', {
      remedy: 'Check the file saved correctly, then upload it again.',
    });
  }
  if (byteLength > LIMITS.maxFileBytes) {
    throw new IngestError(
      'FILE_TOO_LARGE',
      `The file is ${formatBytes(byteLength)}. The limit is ${formatBytes(LIMITS.maxFileBytes)}.`,
      { remedy: 'Upload a smaller file, or paste the text of the clauses you want reviewed.' },
    );
  }
}

export function assertTextSize(text: string): void {
  if (text.trim().length === 0) {
    throw new IngestError('EMPTY_DOCUMENT', 'No readable text was found in the document.', {
      remedy: 'If this is a scan or a photo, re-export it from the source document.',
    });
  }
  if (text.length > LIMITS.maxTextChars) {
    throw new IngestError(
      'TEXT_TOO_LARGE',
      `The document holds ${text.length.toLocaleString('en')} characters, above the ${LIMITS.maxTextChars.toLocaleString('en')} limit.`,
      { remedy: 'Upload the tenancy agreement on its own, without its appendices.' },
    );
  }
}

/**
 * Reject text that is not valid UTF-8, or that carries NUL bytes.
 *
 * The paste and `.txt` path is routed around `file-type` entirely: text has no binary signature,
 * so `file-type` returns `undefined` for it by design, and treating that as "unknown type" would
 * reject every pasted lease.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new IngestError('NOT_UTF8', 'The text could not be read as UTF-8.', {
      remedy: 'Save the file as UTF-8 plain text, or paste the text directly.',
      cause,
    });
  }
  if (text.includes(NUL_BYTE)) {
    throw new IngestError('NOT_UTF8', 'The text contains NUL bytes, so it is not plain text.', {
      remedy: 'Upload the original PDF or DOCX instead.',
    });
  }
  return text;
}

/** Built rather than written as a literal: a raw NUL in source breaks grep, diffs and awk. */
const NUL_BYTE = String.fromCharCode(0);

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const ZIP64_SENTINEL = 0xffff_ffff;

/**
 * Read a ZIP central directory without decompressing a single byte.
 *
 * This is the whole zip-bomb defence, and it costs about a millisecond. The central directory
 * records each entry's compressed and uncompressed size, so the ratio is knowable *before* any
 * inflate call. It is implemented here rather than through a library because the sizes are the
 * only thing needed and because reaching into a zip library's private entry data — which is the
 * usual shortcut — breaks silently on a version bump.
 *
 * A DOCX zip bomb is not theoretical: a measured 238 KB upload expanded to 61 MB of XML and
 * 2.2 GB of RSS in 2.5 seconds, and fifty concurrent uploads would take down any container. The
 * severe case is a bomb inside `word/document.xml` itself, because that is the one entry the
 * parser must decompress.
 */
export function readZipCentralDirectory(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (entryCount > LIMITS.maxZipEntries) {
    throw new IngestError(
      'ZIP_TOO_MANY_ENTRIES',
      `The document contains ${entryCount} internal entries; the limit is ${LIMITS.maxZipEntries}.`,
      { remedy: 'Re-save the document from your word processor and upload it again.' },
    );
  }
  if (directoryOffset >= bytes.byteLength) {
    throw malformed();
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.byteLength) throw malformed();
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw malformed();

    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);

    // A ZIP64 sentinel means the real size lives in an extra field. Rather than parse it, fail
    // closed: a 4 GB entry inside a 4 MB upload is not a document we want to open.
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new IngestError('ZIP_BOMB', 'The document declares a ZIP64 entry size.', {
        remedy: 'Re-save the document from your word processor and upload it again.',
      });
    }

    entries.push({
      name: new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      compressedSize,
      uncompressedSize,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Reject a zip bomb from its declared sizes alone. Called before mammoth ever sees the bytes.
 */
export function assertNotZipBomb(bytes: Uint8Array): readonly ZipEntry[] {
  const entries = readZipCentralDirectory(bytes);

  let total = 0;
  for (const entry of entries) {
    total += entry.uncompressedSize;

    const ratio = entry.compressedSize === 0 ? 0 : entry.uncompressedSize / entry.compressedSize;
    if (ratio > LIMITS.maxZipRatio) {
      throw new IngestError(
        'ZIP_BOMB',
        `Internal entry "${entry.name}" expands ${Math.round(ratio)} times, above the ${LIMITS.maxZipRatio}:1 limit.`,
        { remedy: 'This document is not safe to open. Ask the sender for a PDF instead.' },
      );
    }
  }

  if (total > LIMITS.maxZipTotalBytes) {
    throw new IngestError(
      'ZIP_BOMB',
      `The document expands to ${formatBytes(total)}, above the ${formatBytes(LIMITS.maxZipTotalBytes)} limit.`,
      { remedy: 'This document is not safe to open. Ask the sender for a PDF instead.' },
    );
  }

  return entries;
}

export function assertPageCount(pageCount: number): void {
  if (pageCount > LIMITS.maxPages) {
    throw new IngestError(
      'TOO_MANY_PAGES',
      `The PDF has ${pageCount} pages; the limit is ${LIMITS.maxPages}.`,
      { remedy: 'Upload the tenancy agreement on its own, without its appendices.' },
    );
  }
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // The EOCD record is at the end, but a trailing comment can push it up to 64 KB back.
  const earliest = Math.max(0, length - 0x1_0000 - 22);
  for (let i = length - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw malformed();
}

function malformed(): IngestError {
  return new IngestError('ZIP_MALFORMED', 'The document is not a readable Word file.', {
    remedy: 'Re-save it as .docx or .pdf and upload it again.',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
