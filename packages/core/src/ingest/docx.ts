import { buildDocument } from './offsets.ts';
import { type Block, IngestError, type NormalizedDocument } from './types.ts';

/**
 * DOCX text extraction.
 *
 * `mammoth`, pinned at 1.12.3 or above, and the floor is a security floor rather than a taste:
 * 1.12.3 fixed a ReDoS, 1.12.2 fixed a prototype-pollution bug that could flip
 * `externalFileAccess` back to true, 1.12.1 fixed a path traversal, and 1.11.0 fixed
 * CVE-2025-11849.
 *
 * **`convertToHtml`, not `extractRawText`.** `extractRawText` gives paragraph breaks but discards
 * heading level, and "ARTICLE 5 — SECURITY DEPOSIT" must register as a heading for clause
 * segmentation to nest correctly. Mammoth's default style map covers `p.Heading1`,
 * `p[style-name='Heading 1']`, the lowercase variant and Apple Pages' `p.Heading`, with `:fresh`
 * guaranteeing one block element per Word paragraph.
 *
 * **The HTML is never rendered.** Mammoth's own README is explicit that it "performs no
 * sanitisation of the source document", and a lease is attacker-supplied, so a source document
 * can carry `javascript:` link targets. `extractBlocks` below reads text content out of the
 * markup and discards every tag and attribute, which makes the XSS path structurally absent
 * rather than filtered.
 *
 * XXE and billion-laughs are also structurally impossible with this parser — `@xmldom/xmldom` has
 * no `fs`, `http` or `fetch` import at all, skips the DOCTYPE internal subset, and uses a fixed
 * entity map, so custom entities are never registered. That is a verified property, recorded in
 * `docs/SECURITY.md` and pinned by a regression test so a future library swap cannot quietly
 * reintroduce it.
 */

const BLOCK_TAG = /<(h[1-6]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

/**
 * Read paragraph and heading blocks out of mammoth's HTML.
 *
 * Exported because it is the only interesting logic in this file and deserves its own tests —
 * including the one asserting that a `javascript:` href or an inline `<script>` cannot survive
 * into a block.
 */
export function extractBlocks(html: string): readonly Block[] {
  const withoutRaw = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const blocks: Block[] = [];

  for (const match of withoutRaw.matchAll(BLOCK_TAG)) {
    const tag = (match[1] ?? '').toLowerCase();
    const inner = match[2] ?? '';
    const text = decodeEntities(inner.replace(/<[^>]*>/g, ' '));
    if (text.trim().length === 0) continue;

    const headingLevel = tag.startsWith('h') ? Number.parseInt(tag.slice(1), 10) : undefined;
    blocks.push({
      text,
      page: 1,
      ...(headingLevel === undefined ? {} : { headingLevel }),
    });
  }

  return blocks;
}

interface MammothResult {
  readonly value: string;
  readonly messages: readonly { readonly type: string; readonly message: string }[];
}

interface MammothModule {
  convertToHtml(
    input: { readonly buffer: Buffer },
    options?: Record<string, unknown>,
  ): Promise<MammothResult>;
}

export async function parseDocx(bytes: Uint8Array): Promise<NormalizedDocument> {
  // Imported lazily so the CLI's text path, and the web app's initial bundle, never pay for it.
  const mammoth = (await import('mammoth')) as unknown as MammothModule;

  let result: MammothResult;
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // Never honour a style map supplied inside the document: it is attacker-controlled input.
        includeEmbeddedStyleMap: false,
        // Images are discarded outright. LexMind reads text and renders no remote content.
        convertImage: undefined,
      },
    );
  } catch (cause) {
    throw new IngestError('PARSE_FAILED', 'This Word document could not be read.', {
      remedy: 'Re-save it as .docx or export it as a PDF, then upload it again.',
      cause,
    });
  }

  const blocks = extractBlocks(result.value);
  const warnings = result.messages
    .filter((m) => m.type === 'warning')
    .slice(0, 3)
    .map((m) => `Word document note: ${m.message}`);

  return buildDocument(blocks, { sourceKind: 'docx', pageCount: 1, warnings });
}
