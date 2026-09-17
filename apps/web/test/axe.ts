import { axe } from 'jest-axe';
import { expect } from 'vitest';

/**
 * The exact tag array matters: there is no `wcag22a`, and omitting `wcag22aa` silently drops
 * every WCAG 2.2 rule axe ships (measured on axe-core 4.13: 63 rules run with it, fewer without,
 * and `target-size` never runs at all without it).
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Run axe against a rendered component with LexMind's pinned WCAG 2.2 AA tag set.
 *
 * `color-contrast` is disabled here because jsdom has no layout engine and cannot produce a
 * reliable result for it — contrast is checked against a real browser instead (Playwright).
 * `incomplete` results (axe's "needs manual review") are printed rather than asserted on:
 * `target-size`, axe's only WCAG 2.2 AA rule, always lands there under jsdom.
 */
export async function checkAccessibility(container: Element): Promise<void> {
  const results = await axe(container, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });

  if (results.incomplete.length > 0) {
    const ids = results.incomplete.map((item) => item.id).join(', ');
    console.warn(`axe: needs manual review — ${ids}`);
  }

  expect(results).toHaveNoViolations();
}
