import type { Clause } from '../domain/types.ts';
import { clauseReference } from './clauses.ts';

/**
 * The document outline as a tree, not a flat list.
 *
 * "Section 8.3 - Deductions from Deposit" inherits its meaning from "ARTICLE 8 - SECURITY
 * DEPOSIT". A flat list loses that, and both answer quality and the UI's navigability drop with
 * it — the outline is what the keyboard-navigable highlight index is built from.
 */

export interface OutlineNode {
  readonly clause: Clause;
  readonly label: string;
  readonly children: readonly OutlineNode[];
}

export function buildOutline(clauses: readonly Clause[]): readonly OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { level: number; children: OutlineNode[] }[] = [];

  for (const clause of clauses) {
    const node: OutlineNode = {
      clause,
      label: clause.heading ?? clauseReference(clause),
      children: [],
    };
    const mutableChildren = node.children as OutlineNode[];

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= clause.level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);

    stack.push({ level: clause.level, children: mutableChildren });
  }

  return roots;
}

/** Flatten an outline back to document order, for iteration and for the highlight index. */
export function flattenOutline(nodes: readonly OutlineNode[]): readonly OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);
}

export function outlineDepth(nodes: readonly OutlineNode[]): number {
  if (nodes.length === 0) return 0;
  return 1 + Math.max(...nodes.map((node) => outlineDepth(node.children)));
}
