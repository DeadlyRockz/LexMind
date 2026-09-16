import { assertNotZipBomb } from './guards.ts';
import { IngestError, type SourceKind } from './types.ts';

/**
 * Type detection by content, never by the client.
 *
 * The `Content-Type` header and the file extension are both attacker-controlled — OWASP puts it
 * plainly: "cannot be trusted, as it is trivial to spoof" — so neither is a parameter of this
 * function. There is nothing to pass in but bytes.
 *
 * No library is used, for a specific reason. A generic sniffer answers "this is a zip"; what
 * LexMind needs to know is "this is a Word document, i.e. a zip containing `word/document.xml`",
 * and that answer comes from the ZIP central directory we are already reading for the zip-bomb
 * guard. One pass, one dependency fewer, and a more precise answer than a signature table gives.
 */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // "PK\x03\x04"

/** Other OOXML and OpenDocument members, so the refusal can name what was actually uploaded. */
const KNOWN_ZIP_DOCUMENTS: readonly { readonly entry: string; readonly label: string }[] = [
  { entry: 'xl/workbook.xml', label: 'an Excel spreadsheet' },
  { entry: 'ppt/presentation.xml', label: 'a PowerPoint presentation' },
  { entry: 'content.xml', label: 'an OpenDocument file' },
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

export interface Detection {
  readonly kind: SourceKind;
  /** Present for DOCX: the pre-flighted entry list, so the caller does not re-read it. */
  readonly zipEntries?: readonly { readonly name: string }[];
}

export function detectType(bytes: Uint8Array): Detection {
  if (startsWith(bytes, PDF_MAGIC)) return { kind: 'pdf' };

  if (startsWith(bytes, ZIP_MAGIC)) {
    // The bomb guard runs first: it reads only the central directory, so it is safe to consult
    // before we have decided we even want this file.
    const entries = assertNotZipBomb(bytes);
    const names = entries.map((e) => e.name);

    if (names.some((name) => name === 'word/document.xml')) {
      return { kind: 'docx', zipEntries: entries };
    }

    const known = KNOWN_ZIP_DOCUMENTS.find((candidate) => names.includes(candidate.entry));
    throw new IngestError(
      'UNSUPPORTED_TYPE',
      known === undefined
        ? 'This is a zip archive, not a document LexMind can read.'
        : `This looks like ${known.label}, not a tenancy agreement.`,
      { remedy: 'Upload a PDF or a Word (.docx) file, or paste the text.' },
    );
  }

  // Text has no binary signature, so the plain-text path is validated by decoding rather than by
  // sniffing: anything that decodes as strict UTF-8 with no NUL bytes is text.
  return { kind: 'text' };
}
