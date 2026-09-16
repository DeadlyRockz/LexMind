import { normalizeText } from '../util/text.ts';
import { buildDocument } from './offsets.ts';
import type { Block, NormalizedDocument } from './types.ts';

/**
 * The paste and plain-text path.
 *
 * Routed around type sniffing entirely: text has no binary signature, so a sniffer returns
 * "unknown" for it by design and would reject every pasted lease. Validation is instead
 * "decodes as strict UTF-8, contains no NUL bytes", which `guards.ts` does.
 *
 * This path matters more than it looks. It is the one route that involves no parser at all, so it
 * is the honest answer for a scanned document, and it is how someone pastes the three clauses
 * they are worried about instead of uploading a document with their address in it.
 */

const HEADING_KEYWORD = /^(?:article|section|clause|schedule|annexure|appendix|part)\b/i;
const NUMBERED = /^\(?\d+(?:\.\d+)*\)?[.)]?\s/;

function headingLevelFor(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 90) return undefined;

  const allCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed);
  if (HEADING_KEYWORD.test(trimmed)) return allCaps ? 1 : 2;
  if (allCaps) return 2;
  // A short numbered line with no sentence-ending punctuation reads as a clause heading.
  if (NUMBERED.test(trimmed) && trimmed.length < 70 && !/[.;:]$/.test(trimmed)) return 3;
  return undefined;
}

/** Split pasted text into blocks on blank lines, keeping markdown headings as headings. */
export function textToBlocks(input: string): readonly Block[] {
  const normalized = normalizeText(input);
  const blocks: Block[] = [];

  for (const chunk of normalized.split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;

    const markdown = /^(#{1,6})\s+(.*)$/s.exec(trimmed);
    if (markdown !== null) {
      blocks.push({
        text: (markdown[2] ?? '').trim(),
        page: 1,
        headingLevel: (markdown[1] ?? '#').length,
      });
      continue;
    }

    const headingLevel = headingLevelFor(trimmed);
    blocks.push({
      text: trimmed,
      page: 1,
      ...(headingLevel === undefined ? {} : { headingLevel }),
    });
  }

  return blocks;
}

export function parseText(input: string): NormalizedDocument {
  return buildDocument(textToBlocks(input), { sourceKind: 'text', pageCount: 1 });
}
