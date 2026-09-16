/**
 * Clause numbering, as a table rather than a pile of regexes.
 *
 * Segmentation is deterministic on purpose. Leases are highly structured — numbered clauses,
 * ARTICLE/SECTION keywords, ALL-CAPS headings, and real heading levels from Word — so a rule-based
 * segmenter is faster, free, reproducible and unit-testable. The model is used to *label* clauses,
 * never to find their boundaries, which is what keeps the core testable with no network.
 *
 * Adding a drafting style someone has not seen before is a row in `SCHEMES`, not a code change.
 */

export interface Numbering {
  /** The matched label, e.g. "8.3", "(a)", "ARTICLE 8". */
  readonly label: string;
  /** Numbering components, e.g. ['8','3'] or ['a']. */
  readonly path: readonly string[];
  /** How many characters of the line the label occupies. */
  readonly length: number;
  /** Nesting depth implied by the scheme itself. */
  readonly depth: number;
  readonly scheme: string;
}

const ROMAN = /^(?:x{0,3})(?:ix|iv|v?i{1,3})$/i;

interface Scheme {
  readonly id: string;
  readonly pattern: RegExp;
  readonly depth: number;
  readonly path: (match: RegExpExecArray) => readonly string[];
}

const SCHEMES: readonly Scheme[] = [
  // "ARTICLE 8", "Section 5.2", "Clause 12", "Schedule A", "Annexure II", "Part III"
  {
    id: 'keyword',
    // The `i` flag is load-bearing: leases write "ARTICLE 8", not "Article 8".
    pattern:
      /^(article|section|clause|schedule|annexure|appendix|part)\s+([0-9]+(?:\.[0-9]+)*|[ivxl]+|[a-z])\b[.:—-]?\s*/i,
    depth: 1,
    path: (m) => (m[2] ?? '').split('.'),
  },
  // "8.3.1", "8.3", each dotted component a level deeper
  {
    id: 'dotted',
    pattern: /^(\d+(?:\.\d+)+)[.)]?\s+/,
    depth: 2,
    path: (m) => (m[1] ?? '').split('.'),
  },
  // "8." or "8)" — top level
  { id: 'numeric', pattern: /^(\d{1,3})[.)]\s+/, depth: 1, path: (m) => [m[1] ?? ''] },
  // "(a)" or "a)" — a lettered sub-clause
  { id: 'alpha', pattern: /^\(?([a-z])\)\s+/, depth: 3, path: (m) => [m[1] ?? ''] },
  // "(A)" — an upper-case sub-clause
  { id: 'alpha-upper', pattern: /^\(([A-Z])\)\s+/, depth: 3, path: (m) => [m[1] ?? ''] },
  // "(iv)" — roman only in parentheses, so the pronoun "I" at a line start is never swallowed
  {
    id: 'roman',
    pattern: /^\(([ivxIVX]{1,6})\)\s+/,
    depth: 4,
    path: (m) => [(m[1] ?? '').toLowerCase()],
  },
];

export function parseNumbering(line: string): Numbering | null {
  for (const scheme of SCHEMES) {
    const match = scheme.pattern.exec(line);
    if (match === null) continue;

    // A roman-looking token is only roman if it parses as one; "(v)" is, "(vv)" is not.
    if (scheme.id === 'roman' && !ROMAN.test(match[1] ?? '')) continue;

    const whole = match[0];
    return {
      label: whole.trim(),
      path: scheme.path(match).filter((p) => p.length > 0),
      length: whole.length,
      depth: scheme.depth,
      scheme: scheme.id,
    };
  }
  return null;
}

/** True for a line that reads as a heading even without a numbering token. */
export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 90) return false;
  if (/[.;]$/.test(trimmed)) return false;

  const allCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed);
  const keyword = /^(?:article|section|clause|schedule|annexure|appendix|part)\b/i.test(trimmed);
  return allCaps || keyword;
}

/** Strip the numbering label so a heading reads as its title. */
export function headingTitle(line: string): string {
  const numbering = parseNumbering(line);
  const body = numbering === null ? line : line.slice(numbering.length);
  return body.replace(/^[\s—:-]+/, '').trim();
}
