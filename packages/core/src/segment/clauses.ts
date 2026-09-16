import type { Clause } from '../domain/types.ts';
import type { NormalizedDocument, PositionedItem } from '../ingest/types.ts';
import { headingTitle, looksLikeHeading, parseNumbering } from './headings.ts';

/**
 * Cut a normalized document into addressable clauses.
 *
 * The invariant, asserted for every clause in every fixture:
 *
 *     document.text.slice(clause.charStart, clause.charEnd) === clause.text
 *
 * It holds because `clause.text` is *taken from* that slice rather than reassembled from the
 * items it spans. Reassembling would be the obvious implementation and would silently drop the
 * paragraph separators, putting every citation one or two characters out.
 */

const SIGNATURE_BLOCK =
  /^(?:in witness whereof|signed (?:and )?(?:sealed|delivered)|signature|witnesses?:|for and on behalf of)\b/i;

/** A schedule or annexure after the signatures still carries real terms, so collection resumes. */
const RESUMES_AFTER_SIGNATURES = /^(?:schedule|annexure|appendix|exhibit)\b/i;

interface HeadingFrame {
  readonly level: number;
  readonly text: string;
}

function isClauseStart(item: PositionedItem): boolean {
  if (item.headingLevel !== undefined) return true;
  if (parseNumbering(item.text) !== null) return true;
  return looksLikeHeading(item.text);
}

/** Depth from the heading stack and the numbering scheme together. */
function levelFor(item: PositionedItem, trailDepth: number): number {
  if (item.headingLevel !== undefined) return item.headingLevel;
  const numbering = parseNumbering(item.text);
  if (numbering !== null) return trailDepth + numbering.depth;
  return trailDepth + 1;
}

export function segmentClauses(document: NormalizedDocument): readonly Clause[] {
  const clauses: Clause[] = [];
  const stack: HeadingFrame[] = [];

  // A group is a run of items belonging to one clause: its opening line plus its body.
  let group: PositionedItem[] = [];
  let groupTrail: readonly string[] = [];

  const flush = (): void => {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) {
      group = [];
      return;
    }

    const charStart = first.charStart;
    const charEnd = last.charEnd;
    const numbering = parseNumbering(first.text);
    const heading =
      first.headingLevel !== undefined || looksLikeHeading(first.text)
        ? headingTitle(first.text)
        : null;

    clauses.push({
      id: `c${clauses.length + 1}`,
      path: numbering?.path ?? [],
      headingTrail: groupTrail,
      heading: heading !== null && heading.length > 0 ? heading : null,
      // Taken from the document, never rebuilt: this is what makes the invariant hold.
      text: document.text.slice(charStart, charEnd),
      charStart,
      charEnd,
      pageStart: first.page,
      pageEnd: last.page,
      level: levelFor(first, groupTrail.length),
    });
    group = [];
  };

  // Everything from the attestation clause onward is execution matter — names, dates, witness
  // lines — carrying no obligations. Matching only its opening line is not enough: "Landlord
  // signature" on the following line matches no attestation phrase and would otherwise be cited
  // as a term of the tenancy.
  let inSignatureBlock = false;

  for (const item of document.items) {
    if (SIGNATURE_BLOCK.test(item.text)) {
      flush();
      inSignatureBlock = true;
      continue;
    }
    if (inSignatureBlock) {
      if (!RESUMES_AFTER_SIGNATURES.test(item.text)) continue;
      inSignatureBlock = false;
    }

    if (isClauseStart(item) && group.length > 0) flush();

    if (group.length === 0) {
      // Maintain the heading stack so "Section 8.3" inherits "ARTICLE 8 - SECURITY DEPOSIT".
      // A flat clause list loses that context, and answer quality drops with it.
      if (item.headingLevel !== undefined) {
        while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= item.headingLevel) {
          stack.pop();
        }
      }
      groupTrail = stack.map((frame) => frame.text);
      if (item.headingLevel !== undefined) {
        stack.push({ level: item.headingLevel, text: item.text });
      }
    }

    group.push(item);
  }
  flush();

  return clauses;
}

/** Assert the clause offset invariant. Called at the segmentation boundary. */
export function assertClauseInvariant(
  document: NormalizedDocument,
  clauses: readonly Clause[],
): void {
  for (const clause of clauses) {
    const sliced = document.text.slice(clause.charStart, clause.charEnd);
    if (sliced !== clause.text) {
      throw new Error(
        `Clause ${clause.id} offsets do not match its text: ` +
          `expected ${JSON.stringify(clause.text.slice(0, 40))}, got ${JSON.stringify(sliced.slice(0, 40))}`,
      );
    }
  }
}

export function clauseById(clauses: readonly Clause[], id: string): Clause | undefined {
  return clauses.find((c) => c.id === id);
}

/** The clause containing an offset, for "which clause is this quote in?". */
export function clauseAtOffset(clauses: readonly Clause[], offset: number): Clause | undefined {
  return clauses.find((c) => offset >= c.charStart && offset < c.charEnd);
}

/** A human-readable reference, e.g. "ARTICLE 8 - SECURITY DEPOSIT > 8.3" or "page 2". */
export function clauseReference(clause: Clause): string {
  const parts: string[] = [];
  const trail = clause.headingTrail[clause.headingTrail.length - 1];
  if (trail !== undefined) parts.push(trail);
  if (clause.path.length > 0) parts.push(`Clause ${clause.path.join('.')}`);
  else if (clause.heading !== null) parts.push(clause.heading);
  if (parts.length === 0) parts.push(`Page ${clause.pageStart}`);
  return parts.join(' › ');
}
