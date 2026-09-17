# Accessibility

## Conformance target

**WCAG 2.2 Level AA.** The pages that exist today (`/` and `/try`) are minimal — `/try` is
explicitly a scratch page for exercising the engine before the phase 10 designed interface lands,
and `/` documents the project rather than being the final upload flow. What follows is an honest
account of what has actually been checked on the pages that exist now, not a conformance claim
for a UI that has not been built yet.

## What is automated, and passing

`jest-axe` runs against both live pages (`apps/web/app/page.test.tsx`,
`apps/web/app/try/page.test.tsx`) with the tag set `['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa',
'wcag22aa']`. This exact set matters: there is no `wcag22a` tag, and axe's default `.analyze()`
call never runs any WCAG 2.2 rule at all — `wcag22aa` has to be requested explicitly, which is
what actually exercises `target-size`, axe's only WCAG 2.2 AA rule. **Zero violations** on both
pages as of this writing (`pnpm vitest run --project web`).

`color-contrast` is disabled in this check on purpose — jsdom has no layout engine and cannot
produce a reliable result for it. Contrast has not been verified in a real browser; see
"Not yet verified" below.

## Structural properties, built in rather than tested for

These are present by construction, and covered by non-axe assertions in the same test files
(heading count, labeled-control lookup by accessible name, live-region presence) rather than by
axe, since axe does not check most of them:

- **Skip link** (WCAG 2.4.1 Bypass Blocks), visible on focus, as the first focusable element.
- **`lang="en"`** on `<html>` (3.1.1 Language of Page).
- **A single `<h1>` per page**, with `<main id="main">` as the landmark the skip link targets.
- **A visible focus indicator on the skip link's target.** `main` previously suppressed its focus
  outline entirely (`outline: none`) when reached via the skip link — a keyboard user got no
  visual confirmation that focus had moved. This was found and fixed during this project's own
  development (now `outline: 3px solid Highlight` on `:focus-visible`, a real, non-suppressed
  indicator), which is exactly the documented failure pattern (F78) this project's own planning
  notes flagged as never to reintroduce.
- **A live region (`role="status"`, `aria-live="polite"`) for asynchronous state** — pending,
  error, and result-count messages are announced, rather than only changing visually — which is
  how `/try` meets 4.1.3 Status Messages without moving focus on every update.
- **No colour-only signal.** Finding severity is stated as text ("Critical", "High", ...) before
  the title, not conveyed by colour alone (1.4.1 Use of Colour).
- **Every form control has a programmatic label** (`<label htmlFor>`), checked by accessible-name
  lookup in the test suite, not by axe's `label` rule alone.

## The four new WCAG 2.2 AA criteria — assessed, not manually tested

None of these has been verified with a real assistive technology or device. What follows is an
engineering assessment of applicability, not a pass/fail from actual testing:

- **2.4.11 Focus Not Obscured (Minimum).** No sticky headers or overlays exist on either page that
  could cover a focused element — likely not applicable yet, unverified.
- **2.5.7 Dragging Movements.** Neither page has a drag interaction. Not applicable.
- **2.5.8 Target Size (Minimum).** Interactive elements are default browser-rendered form controls
  and text links, not custom-sized tap targets; axe's `target-size` rule (the only automated
  check for this criterion) reports **`incomplete`** rather than pass or fail under jsdom, which
  the test setup logs for triage (`apps/web/test/axe.ts`) rather than silently treating as green.
- **3.3.8 Accessible Authentication (Minimum).** Neither page has an authentication step. Not
  applicable.

## Not yet verified

Stated plainly, because a reviewer who finds an unstated gap discounts everything else in this
document:

- **Colour contrast**, in a real browser, at the actual rendered sizes and system colour-scheme
  combinations. jsdom cannot produce this; no browser-based check (Playwright or manual) has been
  run yet.
- **A real screen reader pass** (VoiceOver, NVDA, or JAWS) — reading order, how the live region is
  actually announced, and whether label/alt-text quality (not just presence) holds up.
- **A keyboard-only walkthrough** of the full page, including 320px-wide reflow.
- **Automated tools catch roughly 57% of accessibility issues by volume** (Deque, 2021, ~2,000
  audits / 13,000 pages) — and that figure is by issue count, not by criterion, so a clean axe run
  is meaningful evidence, not proof of conformance.

## Scope

This document covers `/` and `/try` as they exist today. It does not cover the root layout's
`<html>`/`<body>` structure directly with axe — `@testing-library/react`'s `render()` mounts into
`document.body`, and testing a component that itself renders `<html>`/`<body>` through that API
produces invalid nested markup that would not reflect how a browser actually renders the page — so
the skip-link and landmark properties on `apps/web/app/layout.tsx` are covered by manual code
review, not by an automated test, until a real end-to-end test (Playwright) exists.
