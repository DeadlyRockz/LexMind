# Phase 10 — Web UI & Accessibility Engineering

**Goal:** a WCAG 2.2 AA interface that is *provably* accessible — automated scans in CI, a manual
checklist for what scans cannot reach, and design decisions that hold up for a screen reader user
reading a lease they are worried about.

**Depends on:** 06 (analysis), 07 (Q&A), 08 (comparison), 09 (outputs).
**Blocks:** 11 (e2e + a11y suite), 13 (submission).

**Judged axes earned here:** Accessibility (all of it), Problem Alignment (comprehension is the product).

---

## Deliverables

```
apps/web/
  app/layout.tsx              lang="en", skip link, always-present live region
  app/globals.css             tokens, focus rings, reduced-motion, forced-colors
  components/
    UploadDropzone.tsx        react-aria-components DropZone + FileTrigger
    DocumentViewer.tsx        <mark> clause highlights, severity in text
    HighlightIndex.tsx        keyboard-navigable list of every highlight
    RiskList.tsx              disclosure pattern, NO role="region" per panel
    SeverityBadge.tsx         text + shape + colour, never colour alone
    CompareView.tsx           tabs, manual activation, stacks at 320px
    AskPanel.tsx              streaming Q&A + polite status region + Stop control
    Announcer.tsx             the single visually-hidden role="status" region
  lib/a11y/announcer.ts       one announce() used by every async flow
  test/axe.ts                 configureAxe scoped to WCAG 2.2 AA tags
  vitest.d.ts                 toHaveNoViolations matcher augmentation
docs/ACCESSIBILITY.md         conformance statement + manual test log
```

## Tasks

### Component foundation

- [ ] **`react-aria-components` for the dropzone.** It is the only maintained primitive library that
      ships an accessible `DropZone`, and `FileTrigger` nests inside it to provide the keyboard
      path. Everything else (dialog, disclosure, tabs) may come from `@base-ui/react` or `radix-ui`.
      **Note the rename: `@base-ui-components/react` is deprecated → `@base-ui/react`.**
- [ ] A drag-and-drop upload **must** have a real `<input type="file">` / `FileTrigger` button.
      Justify it under **SC 2.1.1 Keyboard (Level A)** — that argument is airtight. Do *not* cite
      2.5.7 Dragging Movements for this: the W3C Understanding document contains no file-upload
      example, and the common "dropzones need a Browse button for 2.5.7" claim has no W3C source.
- [ ] **Modal dialogs via native `<dialog>` + `showModal()`.** That gives focus-in, Esc-to-close,
      top-layer, implicit `aria-modal="true"`, and automatic `inert` on the rest of the page — all
      from the browser. Using the `open` attribute or `.show()` gives **none** of it.
      **Focus return to the invoker is still your job** — the browser does not do it.
- [ ] **Risk list = the APG disclosure/accordion pattern**: trigger is a `<button>` inside a heading
      with the right `aria-level`, `aria-expanded`, `aria-controls`. Plain Tab, no arrow keys.
      **Do not put `role="region"` on each panel** — APG warns against it beyond ~six panels, and a
      lease can produce twenty. That would be landmark proliferation.
- [ ] **Comparison view = APG tabs with *manual* activation** (Space/Enter). Automatic activation is
      only appropriate when panels are preloaded, and ours fetch.

### Highlighted clauses — the hard part

- [ ] Use the **`<mark>` element**, not `role="mark"` (the role is WAI-ARIA 1.3, still a Working
      Draft). MDN: "Using the `<mark>` element will automatically communicate a node has a role of
      `mark`. If at all possible, prefer using it."
- [ ] **`aria-label` and `aria-labelledby` are PROHIBITED on `<mark>`** (WAI-ARIA 1.2 §5.2.8.6,
      "Authors MUST NOT…"). axe enforces this via `aria-prohibited-attr` → **SC 4.1.2 Level A**, so
      it fails the automated scan, not merely a manual review. Severity goes in **visually-hidden
      text inside the mark**, never an aria-label.
- [ ] **`<mark>` is not announced by most screen readers in their default configuration** (MDN).
      Apply MDN's own `::before`/`::after` + `content` remediation, selectively — a risky lease
      clause clears MDN's "would adversely affect understanding" bar comfortably.
- [ ] **Build `HighlightIndex.tsx`.** No browser or screen reader can navigate between highlights
      natively; the W3C DPUB IG explicitly states this navigation "should be provided" and does not
      exist yet. A keyboard-navigable list of every highlight, each targeting its `<mark id>`, is
      the fix — and the risk list already nearly is one.
- [ ] Severity must never be colour alone (**SC 1.4.1, Level A**): colour **+** a text label **+** a
      non-colour visual cue (icon or border style).
- [ ] If the DOM cost of thousands of `<mark>` nodes becomes a real measured problem, the CSS Custom
      Highlight API is the escape hatch — but MDN is explicit that custom highlights "do not
      inherently provide semantic meaning in the document structure." It would have to be paired
      with the accessible index. **Default to `<mark>`; only optimise against a measurement.**

### Streaming Q&A — where most AI UIs fail

- [ ] **The token sink is NOT a live region.** Stream into a plain node. A live region on the
      streaming node produces "a stream of partial, overlapping fragments" at 5–20 updates/second.
- [ ] Keep **one** always-present, visually-hidden `role="status"` region (implicit
      `aria-live="polite"`), rendered on mount — live regions must exist in the DOM *before* they
      are populated or AT will not register them.
- [ ] **Never `aria-live="assertive"`** for streaming; it interrupts every in-progress announcement.
      **Never `aria-atomic="true"`** on a streaming container; the whole accumulated response
      re-announces on every token. Leave `aria-relevant` at its default.
- [ ] Announce **state transitions**, not tokens: "Generating response…" → "Response complete."
      Same for analysis: "Analysis complete. 12 risks found." This is **SC 4.1.3 Status Messages
      (AA)** — the criterion that makes announcing-without-focus a conformance requirement.
- [ ] A focusable, named **"Stop generating"** control must be present while streaming.
- [ ] **One channel per event — never both.** Moving focus and firing a live region for the same
      event is self-defeating; the focus announcement wins and suppresses the live region.
      | Event | Channel |
      |---|---|
      | Parsing / analysing | `role="status"`, no focus move |
      | Analysis complete | `role="status"` with the risk count |
      | User clicks a risk → jumps to clause | **Move focus** to the clause (`tabindex="-1"`) — user-initiated |
      | Question submitted | Focus stays in the composer |
      | Tokens streaming | Silent |
      | Response complete | `role="status"` |
      | Upload error | `role="alert"` **or** focus the error, not both |
      | Modal close | Return focus to the invoker |

### Visual layer

- [ ] Contrast: **4.5:1** normal text, **3:1** large text (≥18pt / ≥14pt bold ≈ 24px / 18.5px bold),
      **3:1** for UI component boundaries and focus rings (**SC 1.4.11** — 3:1, not 4.5:1).
- [ ] **SC 1.4.10 Reflow — 320 CSS px wide, 256 CSS px tall, no two-dimensional scrolling.**
      The side-by-side comparison view is the direct risk: it **must** stack to one column at 320px.
      The "two-dimensional layout" exception is narrow and does not cover two stacked documents.
- [ ] **SC 1.4.12 Text Spacing** — verify nothing clips with line-height 1.5×, paragraph spacing 2×,
      letter-spacing 0.12×, word-spacing 0.16× applied over the top. This is a user-override
      resilience test, not a styling instruction.
- [ ] **SC 2.5.8 Target Size — 24×24 CSS px** for severity badges and disclosure triggers. Inline
      clause highlights inside running text are covered by the **Inline exception**; badges are not.
- [ ] **SC 2.4.11 Focus Not Obscured (AA)** — no sticky header or banner may leave a focused control
      *entirely* hidden. Tab the whole page with the header present.
- [ ] `prefers-reduced-motion: reduce`, `prefers-contrast`, and **`forced-colors: active`**.
      Forced colors is the one that will break things: it forces `box-shadow → none`,
      `text-shadow → none`, `background-image → none`, and ignores author `background-color`.
      **Severity badges built from background colour and focus rings built from box-shadow will
      vanish.** Use borders plus system colour keywords (`CanvasText`, `Highlight`, `ButtonText`).
- [ ] `:focus-visible` rings everywhere; never `outline: none` (**F78**, a documented failure of
      1.4.11, 2.4.7 and 2.4.13).
- [ ] Skip link, one `<h1>`, landmark regions, `lang="en"` on `<html>`.

### Testing

- [ ] **Do not use `vitest-axe`.** Its npm `latest` is **0.1.0, published 2022-10-21**, with no
      `exports` field — while its README documents subpaths that exist only in an unreleased
      prerelease. Use **`jest-axe@11`** with `expect.extend(toHaveNoViolations)` in a Vitest setup
      file; this combination is verified working with Vitest 5 + React 19 + RTL.
- [ ] **Type augmentation is required.** `@types/jest-axe` augments `jest`/`@jest/expect` only, so
      TypeScript errors with `TS2339` under Vitest. Hand-write `vitest.d.ts` with
      `declare module 'vitest' { interface Matchers<T = any> extends AxeMatchers<T> {} }`.
- [ ] **Use `jsdom`, not `happy-dom`** — happy-dom's `Node.prototype.isConnected` implementation
      breaks axe.
- [ ] **Disable `color-contrast` in the Vitest project** — jsdom has no canvas or layout, so the
      rule cannot produce reliable results there. Contrast is checked in Playwright against a real
      browser instead.
- [ ] **The exact axe tag array is `['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']`.**
      There is **no `wcag22a` tag**. Playwright's own documentation omits `wcag22aa` — do not copy
      their snippet.
- [ ] **You get zero WCAG 2.2 coverage unless you pass `wcag22aa` explicitly.** Measured on
      axe-core 4.13: with the tag → 63 rules run and `target-size` executes; without → it does not;
      a default `.analyze()` runs 89 rules and still never runs it.
- [ ] **`expect(violations).toEqual([])` is not enough.** `target-size` — the only WCAG 2.2 AA rule
      axe ships — is typed "needs review" and reports into **`incomplete`**, which that assertion
      silently ignores. Assert on `incomplete` too, or surface it for triage.
- [ ] Playwright specs for what unit tests cannot reach: focus return from modals, keyboard-only
      upload, 320px reflow, contrast, tab order.
- [ ] **`docs/ACCESSIBILITY.md` with a manual test log.** Automated tools catch roughly **57% of
      issues by volume** (Deque, 2021, ~2,000 audits / 13,000 pages) — and that figure is by issue
      count, not by criterion. Of the four *new* WCAG 2.2 AA criteria, axe has **one partial rule,
      disabled by default**. Record manual passes for: 2.4.11, 2.5.7, 2.5.8, 3.3.8, focus order and
      return, live-region behaviour with a real screen reader, label and alt-text *quality*, reflow,
      and text spacing.

## Design notes

- **Being honest about conformance is worth more than overclaiming.** `docs/ACCESSIBILITY.md` should
  state the standard, what was automated, what was tested by hand, and what is known-unfinished. A
  reviewer who finds an overclaim discounts everything; one who finds a candid, specific log trusts
  the rest.
- **Plain-language testing is voluntary rigor, not AA conformance.** SC 3.1.5 Reading Level is
  **AAA**, and the working group itself admits it "could not find a way to test whether this had
  been achieved." Assert Flesch–Kincaid ≤ 9.0 on generated summaries using
  `@lunarisapp/readability` (actively maintained, first-class TS types) and label it in the README
  as AAA-aligned extra effort. Claiming it as AA would be a factual error a reviewer could catch.
- For a tenant under stress reading about their own home, comprehension *is* the feature. Cognitive
  accessibility — short sentences, one idea per paragraph, no unexplained jargon, consistent
  ordering — is not decoration here.

## Acceptance criteria

- `pnpm test` runs axe against every component with the five WCAG tags; **zero violations**, and any
  `incomplete` results are printed for triage.
- Playwright: zero violations on upload, viewer, risk list, compare, and Q&A; modal returns focus to
  its invoker; the compare view does not scroll horizontally at 320 CSS px.
- Keyboard-only walkthrough of the full journey — upload → read risks → jump to a clause → ask a
  question → export — with no mouse and no trap.
- Every `<mark>` carries visually-hidden severity text and **no** `aria-label`.
- Severity is distinguishable in greyscale and survives `forced-colors: active`.
- Flesch–Kincaid grade ≤ 9.0 on every generated plain-English summary in the golden set.
- `docs/ACCESSIBILITY.md` lists each of the four new WCAG 2.2 AA criteria with a manual result.

## Risks

- **The comparison view is the most likely AA failure** — side-by-side layouts fight SC 1.4.10.
  Design it mobile-first as a stacked diff and treat the two-column form as the enhancement.
- **Streaming announcements are the second most likely failure**, and they fail *silently* for
  sighted developers. Test with a real screen reader at least once; the polite-region pattern is
  practitioner guidance, not a normative spec.
- **`forced-colors` breakage is invisible until tested.** Check in Windows High Contrast (or
  emulation in Edge/Chrome DevTools) before submission.
- Over-engineering the highlight layer. `<mark>` plus an index list is correct and simple; the
  Custom Highlight API is a performance optimisation to reach for only if profiling demands it.
