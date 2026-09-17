/**
 * The ingest boundary is also the trust boundary: untrusted bytes go in, a validated
 * `NormalizedDocument` comes out, and nothing downstream ever sees the raw file.
 */

export type SourceKind = 'pdf' | 'docx' | 'text';

export type IngestErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_DOCUMENT'
  | 'TEXT_TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'ZIP_BOMB'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_MALFORMED'
  | 'SCANNED_PDF'
  | 'ENCRYPTED_PDF'
  | 'NOT_UTF8'
  | 'PARSE_FAILED';

/**
 * A typed failure, never a stack trace shown to a worried tenant. Every adversarial fixture in
 * the test suite asserts one of these codes — a crash or a hang is a test failure.
 */
export class IngestError extends Error {
  readonly code: IngestErrorCode;
  /** What the reader can do about it, in plain language. */
  readonly remedy: string;
  /** Populated for page-specific failures, e.g. which pages are scanned images. */
  readonly pages: readonly number[];

  constructor(
    code: IngestErrorCode,
    message: string,
    options?: {
      readonly remedy?: string;
      readonly pages?: readonly number[];
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IngestError';
    this.code = code;
    this.remedy = options?.remedy ?? '';
    this.pages = options?.pages ?? [];
  }
}

export function isIngestError(error: unknown): error is IngestError {
  return error instanceof IngestError;
}

/**
 * One paragraph-sized unit of the document, before offsets are assigned.
 *
 * Parsers produce blocks; `offsets.ts` assembles the canonical text *from* them. Building the
 * text from the blocks rather than alongside them is what makes the offset invariant hold by
 * construction instead of by careful bookkeeping.
 */
export interface Block {
  readonly text: string;
  /** 1-based. Text pasted in has no pages, so it is all page 1. */
  readonly page: number;
  /** 1-6 when this block is a heading, from DOCX heading styles or PDF font-size analysis. */
  readonly headingLevel?: number;
  readonly fontSize?: number;
}

/** A block with its offsets resolved. `document.text.slice(charStart, charEnd) === text`. */
export interface PositionedItem {
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly page: number;
  readonly headingLevel?: number;
  readonly fontSize?: number;
}

export interface DocumentMeta {
  /** Reported by pdf.js, never acted on. pdf.js does not execute embedded PDF JavaScript. */
  readonly hasEmbeddedScripts?: boolean;
  readonly producer?: string;
  readonly title?: string;
}

export interface NormalizedDocument {
  /**
   * Content-derived identity. LexMind never echoes the uploaded filename and never writes the
   * file to disk, so this hash — not a user-supplied name — is what identifies a document.
   */
  readonly id: string;
  readonly sha256: string;
  /** The canonical normalized text. Every offset in the system indexes this string. */
  readonly text: string;
  readonly items: readonly PositionedItem[];
  readonly pageCount: number;
  readonly sourceKind: SourceKind;
  readonly meta: DocumentMeta;
  /** Non-fatal observations worth showing the reader, e.g. dropped repeating page headers. */
  readonly warnings: readonly string[];
}
