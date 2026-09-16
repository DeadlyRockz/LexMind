/**
 * A minimal PDF writer for fixtures.
 *
 * A complete two-page lease PDF is about 1.3 KB of hand-written PDF syntax, which is why LexMind
 * generates its fixtures instead of committing them: real lease PDFs would blow the 10 MB
 * repository limit and put real personal data in a public repository.
 *
 * The writer emits uncompressed content streams and a correct cross-reference table, so the
 * output is a genuine PDF that pdf.js parses through its normal path rather than its recovery
 * path.
 */

export interface TextLine {
  readonly text: string;
  /** PDF user space, origin bottom-left. */
  readonly x: number;
  readonly y: number;
  readonly fontSize?: number;
}

export interface PdfPage {
  readonly lines: readonly TextLine[];
  /** Emit an inline image, which is what makes a page look like a scan. */
  readonly withImage?: boolean;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

function escapePdfString(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(page: PdfPage): string {
  const text = page.lines
    .map(
      (line) =>
        `BT /F1 ${line.fontSize ?? 11} Tf ${line.x} ${line.y} Td (${escapePdfString(line.text)}) Tj ET`,
    )
    .join('\n');

  // An inline image produces a `paintInlineImageXObject` operator, which is the second signal the
  // scanned-page detector looks for. ASCIIHexDecode keeps the fixture pure ASCII.
  const image =
    page.withImage === true
      ? '\nq 400 0 0 500 100 200 cm\nBI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 00FF7F40> EI\nQ'
      : '';

  return `${text}${image}`;
}

export function buildPdf(pages: readonly PdfPage[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = Math.max(1, pages.length);

  // Object 1 catalog, 2 page tree, 3 font, then per page: a page object and a contents stream.
  const firstPageObject = 4;
  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${firstPageObject + i * 2} 0 R`,
  ).join(' ');

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < pageCount; i += 1) {
    const page = pages[i] ?? { lines: [] };
    const contentsRef = firstPageObject + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentsRef} 0 R >>`,
    );
    const stream = contentStream(page);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** A single-column text PDF, one line per entry, laid out top to bottom. */
export function buildTextPdf(lines: readonly string[], options?: { readonly headings?: readonly number[] }): Uint8Array {
  const headings = new Set(options?.headings ?? []);
  return buildPdf([
    {
      lines: lines.map((text, i) => ({
        text,
        x: 72,
        y: PAGE_HEIGHT - 72 - i * 20,
        fontSize: headings.has(i) ? 16 : 11,
      })),
    },
  ]);
}

/**
 * A two-column PDF. Content-stream order deliberately interleaves the columns, which is exactly
 * how a real two-column document behaves: `getTextContent()` emits draw order, not reading order.
 */
export function buildTwoColumnPdf(
  left: readonly string[],
  right: readonly string[],
): Uint8Array {
  const lines: TextLine[] = [];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    const y = PAGE_HEIGHT - 72 - i * 20;
    const l = left[i];
    const r = right[i];
    if (l !== undefined) lines.push({ text: l, x: 60, y });
    if (r !== undefined) lines.push({ text: r, x: 330, y });
  }
  return buildPdf([{ lines }]);
}

/** A PDF whose only content is an image: no text layer at all. */
export function buildScannedPdf(pageCount = 2): Uint8Array {
  return buildPdf(Array.from({ length: pageCount }, () => ({ lines: [], withImage: true })));
}

/** A scan with a stray text header, the case a bare `items.length === 0` test misses. */
export function buildScannedPdfWithHeader(): Uint8Array {
  return buildPdf([
    { lines: [{ text: 'Scanned by OfficeScan', x: 72, y: 760 }], withImage: true },
  ]);
}

export function buildManyPagePdf(pageCount: number): Uint8Array {
  return buildPdf(
    Array.from({ length: pageCount }, (_, i) => ({
      lines: [{ text: `Page ${i + 1} of the agreement.`, x: 72, y: 700 }],
    })),
  );
}

/** Pages sharing a repeating header and footer, to exercise furniture removal. */
export function buildPdfWithRunningHeaders(bodyPerPage: readonly string[]): Uint8Array {
  return buildPdf(
    bodyPerPage.map((body, i) => ({
      lines: [
        { text: 'RESIDENTIAL TENANCY AGREEMENT', x: 72, y: 760 },
        { text: body, x: 72, y: 600 },
        { text: `Page ${i + 1} of ${bodyPerPage.length}`, x: 72, y: 60 },
      ],
    })),
  );
}
