# Phase 11 — Test & Evaluation Harness

**Goal:** prove the thing works. Not "we wrote some tests" — a golden set with known answers, a
scorecard with real numbers, and a suite that runs green on a fresh clone with **no API key and no
network**.

**Depends on:** every phase it measures.
**Blocks:** 13 (the README quotes these numbers).

**Judged axis earned here:** Testing — and it is the axis most often lost to tests that only prove
the code runs.

---

## Deliverables

```
test/
  golden/
    generate.ts          builds every fixture PROGRAMMATICALLY (repo-size rule)
    leases/*.spec.ts     ~15 synthetic leases, each with seeded, annotated defects
    annotations.json     ground truth: expected findings, severities, citations
    questions.json       seeded Q&A with known correct clause anchors
    comparisons.json     lease pairs with known material differences
  adversarial/           injection, invisible-unicode, PII, zip-bomb, XXE fixtures
  boundary/              advice-seeking vs information-seeking prompts, both labelled
e2e/                     Playwright: journeys + accessibility
scripts/eval.ts          `pnpm eval` -> reports/scorecard.md
reports/scorecard.md     committed, regenerable
```

## Tasks

### The golden set — the thing that makes evaluation possible

- [ ] **~15 synthetic leases, written by us, with defects deliberately seeded and annotated.** Cover:
      a clean fair lease (the false-positive control), an Indian 11-month agreement, a
      Maharashtra leave-and-licence, a US lease with the four URLTA §1.403(a) prohibited clauses, a
      California lease with an over-cap deposit, a post-Renters'-Rights-Act England tenancy, a
      heavily one-sided lease, a lease with no jurisdiction markers at all, a two-column PDF, a
      scanned PDF, a DOCX with real heading styles, and before/after negotiation pairs.
- [ ] **Generate them programmatically.** A two-page lease PDF is ~1.3 KB of hand-written PDF syntax
      and a DOCX ~3.8 KB from a small zip writer. Committing real lease files would blow the
      **10 MB repo limit** and put real personal data in a public repo.
- [ ] **`annotations.json` is the ground truth**: for each lease, the expected findings with clause
      ids, severities, and expected citations — plus, critically, the findings that should **not**
      fire. A false-positive count is as important as a recall number.
- [ ] **The clean-fair-lease fixture is the most valuable one.** A tool that flags everything is
      useless; asserting that a normal lease produces few or no high-severity findings is what
      proves calibration.

### The scorecard

- [ ] `pnpm eval` produces `reports/scorecard.md`, committed to the repo, reporting:
      | Metric | Why it matters |
      |---|---|
      | Clause-detection precision / recall, per type | Core correctness |
      | Red-flag recall on seeded defects | Does it find what it should |
      | **False-positive rate on the clean lease** | Calibration |
      | **Citation verification rejection rate** | Honest model-reliability measure |
      | Q&A: correct-clause-in-top-3 | Retrieval quality |
      | Abstention rate, and abstention *correctness* | Over- and under-abstention |
      | Boundary classifier: refusal precision **and** recall | Over-refusal is a failure too |
      | Flesch–Kincaid of generated summaries | Plain-language target |
      | Tokens + estimated cost per document class | Efficiency |
      | Offline determinism: identical output across two runs | Reproducibility |
- [ ] **Report the failures too.** A scorecard that shows only wins reads as marketing. Stating
      "clause-type X recall is 0.62, and here is why" is more credible than silence, and the
      hackathon's own evaluation rewards honest engineering.

### The suites

- [ ] **Unit (`packages/core`, node env)** — every rule, parser, normaliser, detector, and the
      verifier. Coverage gate ≥ 90% lines on `packages/core/src`. This is where the number comes
      from, and it is meaningful because the logic lives here rather than in route handlers.
- [ ] **Invariant tests at every boundary** — `text.slice(charStart, charEnd) === quote` after
      ingest, after segmentation, after analysis, after export. Offset drift is the failure mode
      that silently corrupts every citation.
- [ ] **Adversarial suite** — prompt injection, invisible Unicode, PII leakage into the outbound
      prompt, zip bomb, XXE, billion laughs, oversized upload, scanned PDF, encrypted PDF.
      Each asserts a **typed failure**, never a crash.
- [ ] **Architecture tests** (cheap, and they catch real regressions):
      - no `react`/`next` import anywhere in `packages/core/src`
      - exactly one file imports `@google/genai`
      - no code path fetches a model-provided URL
      - the API key does not appear in the built client bundle
      - no `dangerouslySetInnerHTML` with model output
- [ ] **Accessibility** — `jest-axe` in Vitest per component, Playwright + `@axe-core/playwright`
      per page, with the exact tag array `['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']`.
      Assert on `violations` **and** surface `incomplete` (that is where `target-size` lands).
      Plus the manual checklist in `docs/ACCESSIBILITY.md` for the ~43% automation cannot reach.
- [ ] **E2E journeys** — upload → analyse → read risks → jump to clause → ask a question → compare →
      export. Run against cassettes so they need no key.
- [ ] **CI runs everything with `LEXMIND_OFFLINE=1`.** A recorded cassette removed from disk must
      make its test fail loudly rather than silently reach the network — assert that too.

## Design notes

- **The golden set is the deliverable, not the tests.** Anyone can write assertions; a set of
  annotated leases with known defects is what makes every later change measurable, and it is what
  lets the README state numbers instead of adjectives.
- **Offline determinism is what makes the Testing axis legible to a grader.** They will clone the
  repo, run `pnpm install && pnpm test`, and have no Gemini key. If that is not green, nothing else
  in this phase matters.
- Evaluation doubles as the calibration loop for Phase 06 severity and Phase 05 refusal tuning.
  Both are knobs that can only be set against measured data.

## Acceptance criteria

- `pnpm install --frozen-lockfile && pnpm test` passes on a clean clone, offline, **no API key**.
- `pnpm eval` regenerates `reports/scorecard.md`, and the committed copy matches.
- Coverage ≥ 90% lines on `packages/core/src`, enforced by the CI gate.
- The clean-fair-lease fixture produces zero high-severity false positives.
- Every adversarial fixture produces a typed error; none crashes or hangs.
- All five architecture tests pass.
- Zero axe violations across components and pages; `incomplete` results are surfaced.
- Two consecutive offline runs produce byte-identical analysis output.

## Risks

- **Golden-set bias.** We write both the leases and the analyser, so it can score well on its own
  fixtures and fail on a real lease. Mitigate by drafting fixtures from the *model instruments*
  (gov.uk Model AST, HUD 90105-a, MTA Schedules) rather than from our own detectors, and by
  hand-testing on at least a few genuine leases before submission.
- **Coverage theatre.** 90% on `packages/core` is meaningful; 90% chased across UI files is not.
  Scope the gate deliberately and say so in the README.
- **Fixture maintenance cost.** Every prompt change can invalidate cassettes. Hash prompts into
  cassette filenames so a mismatch reads as "re-record", not "broken".
