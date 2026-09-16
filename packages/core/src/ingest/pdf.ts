import { extractTextItems, getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { assertPageCount } from './guards.ts';
import { type LayoutItem, layoutPages } from './layout.ts';
import { buildDocument } from './offsets.ts';
import { assertNotScanned, type PageTextStat, scannedPages } from './scanned.ts';
import { IngestError, type NormalizedDocument } from './types.ts';

/**
 * PDF text extraction.
 *
 * `unpdf` rather than `pdfjs-dist` directly: it is a serverless-oriented repackaging of Mozilla's
 * pdf.js with **zero runtime dependencies**, installs at roughly 2.5 MB against pdfjs-dist's
 * 35 MB, bundles cleanly (pdfjs-dist's dynamic worker resolution is a classic Next.js breakage),
 * and — decisively — its `extractTextItems()` pre-computes `fontSize` from the transformation
 * matrix, which raw pdf.js does not expose at all. Heading detection needs that number.
 *
 * Two pdf.js behaviours are load-bearing here and easy to get wrong:
 *
 *  1. **pdf.js transfers ownership of the input array to its worker.** After one call the buffer
 *     has `byteLength === 0` and a second call throws `DataCloneError`, so every entry point
 *     copies the bytes first.
 *  2. **pdf.js does not execute embedded PDF JavaScript.** `/OpenAction`, a `/Names /JavaScript`
 *     tree and page `/AA` actions are all *reported* but never run; the scripting sandbox lives
 *     only in the viewer bundle, which is never imported. So an embedded script is a fact to
 *     surface to the reader, not a danger to us.
 */

interface ImageOpsModule {
  readonly OPS: Record<string, number>;
}

const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintJpegXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
] as const;

function isPasswordError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = 'message' in error ? String(error.message) : '';
  return name === 'PasswordException' || /password/i.test(message);
}

export async function parsePdf(bytes: Uint8Array): Promise<NormalizedDocument> {
  // Copy: pdf.js takes ownership of the array it is handed.
  const owned = new Uint8Array(bytes);

  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    proxy = await getDocumentProxy(owned);
  } catch (cause) {
    if (isPasswordError(cause)) {
      throw new IngestError('ENCRYPTED_PDF', 'This PDF is password-protected.', {
        remedy:
          'Open it in a PDF reader, save an unprotected copy, and upload that — or paste the text.',
        cause,
      });
    }
    throw new IngestError('PARSE_FAILED', 'This PDF could not be read.', {
      remedy: 'Re-export it from the original document, or paste the text.',
      cause,
    });
  }

  // Guard on the page count before touching a single page: `numPages` comes from the header.
  assertPageCount(proxy.numPages);

  const { totalPages, items } = await extractTextItems(proxy);

  const stats: PageTextStat[] = items.map((pageItems, index) => ({
    page: index + 1,
    nonWhitespaceChars: pageItems.reduce(
      (sum, item) => sum + item.str.replace(/\s/g, '').length,
      0,
    ),
  }));

  // Only text-poor pages are worth an operator-list scan, which keeps the second signal cheap.
  const suspicious = stats
    .filter((s) => s.nonWhitespaceChars < 100)
    .map((s) => s.page);
  const withImages = suspicious.length === 0 ? [] : await pagesPaintingImages(proxy, suspicious);
  assertNotScanned(scannedPages(stats, withImages), totalPages);

  const pages: LayoutItem[][] = items.map((pageItems) =>
    pageItems.map((item) => ({
      str: item.str,
      x: item.x,
      y: item.y,
      width: item.width,
      fontSize: item.fontSize,
      hasEOL: item.hasEOL,
    })),
  );

  const { blocks, warnings } = layoutPages(pages);
  const meta = await readMeta(proxy);

  return buildDocument(blocks, {
    sourceKind: 'pdf',
    pageCount: totalPages,
    meta,
    warnings: [...warnings, ...(meta.hasEmbeddedScripts === true ? [EMBEDDED_SCRIPT_NOTE] : [])],
  });
}

const EMBEDDED_SCRIPT_NOTE =
  'This PDF carries embedded JavaScript. LexMind reads only its text and never runs it, but a tenancy agreement has no reason to contain a script — worth asking the sender about.';

async function pagesPaintingImages(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  candidates: readonly number[],
): Promise<readonly number[]> {
  let imageOps: Set<number>;
  try {
    const pdfjs = (await getResolvedPDFJS()) as unknown as ImageOpsModule;
    imageOps = new Set(
      IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]).filter(
        (code): code is number => typeof code === 'number',
      ),
    );
  } catch {
    // Without the op codes the second signal is unavailable. Returning nothing means a text-poor
    // page is reported as empty rather than misreported as a scan.
    return [];
  }

  const found: number[] = [];
  for (const pageNumber of candidates) {
    try {
      const page = await proxy.getPage(pageNumber);
      const { fnArray } = await page.getOperatorList();
      if (fnArray.some((fn: number) => imageOps.has(fn))) found.push(pageNumber);
    } catch {
      // A page that will not yield an operator list tells us nothing either way.
    }
  }
  return found;
}

async function readMeta(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<{ hasEmbeddedScripts?: boolean; producer?: string; title?: string }> {
  const meta: { hasEmbeddedScripts?: boolean; producer?: string; title?: string } = {};
  try {
    const actions = await proxy.getJSActions();
    if (actions !== null && Object.keys(actions).length > 0) meta.hasEmbeddedScripts = true;
  } catch {
    // Not all documents answer this; absence is not a signal.
  }
  return meta;
}
