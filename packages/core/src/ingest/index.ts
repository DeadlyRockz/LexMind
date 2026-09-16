import { detectType } from './detect.ts';
import { parseDocx } from './docx.ts';
import { assertFileSize, decodeUtf8Strict } from './guards.ts';
import { assertOffsetInvariant } from './offsets.ts';
import { parsePdf } from './pdf.ts';
import { parseText } from './text.ts';
import type { NormalizedDocument } from './types.ts';

export { detectType } from './detect.ts';
export { extractBlocks } from './docx.ts';
export {
  assertFileSize,
  assertNotZipBomb,
  assertPageCount,
  assertTextSize,
  decodeUtf8Strict,
  formatBytes,
  LIMITS,
  readZipCentralDirectory,
  type ZipEntry,
} from './guards.ts';
export {
  assembleLines,
  detectColumns,
  groupIntoBlocks,
  type LayoutItem,
  layoutPages,
  removeRepeatedFurniture,
} from './layout.ts';
export { assertOffsetInvariant, buildDocument, pageAtOffset } from './offsets.ts';
export {
  assertNotScanned,
  formatPageRanges,
  type PageTextStat,
  scannedPages,
  textPoorPages,
} from './scanned.ts';
export { parseText, textToBlocks } from './text.ts';
export type {
  Block,
  DocumentMeta,
  IngestErrorCode,
  NormalizedDocument,
  PositionedItem,
  SourceKind,
} from './types.ts';
export { IngestError, isIngestError } from './types.ts';

/**
 * The single entry point for untrusted bytes.
 *
 * Order is load-bearing, cheapest and most decisive check first:
 *
 *   1. size ceiling — before anything is parsed or allocated
 *   2. type detection by magic bytes, with the zip-bomb pre-flight folded in
 *   3. the format parser
 *   4. the offset invariant, asserted before the document is handed to anything else
 *
 * The uploaded file is never written to disk. That single decision dominates every
 * storage-location control in the OWASP File Upload Cheat Sheet, and it is why a document is
 * identified by a content hash rather than by the name the user's computer gave it.
 */
export async function ingestBytes(bytes: Uint8Array): Promise<NormalizedDocument> {
  assertFileSize(bytes.byteLength);

  const detection = detectType(bytes);
  const document =
    detection.kind === 'pdf'
      ? await parsePdf(bytes)
      : detection.kind === 'docx'
        ? await parseDocx(bytes)
        : parseText(decodeUtf8Strict(bytes));

  assertOffsetInvariant(document);
  return document;
}

/** The paste path. Separate because it needs no sniffing and no parser. */
export function ingestPastedText(input: string): NormalizedDocument {
  const document = parseText(input);
  assertOffsetInvariant(document);
  return document;
}
