# Phase 08 — Lease Comparison

**Goal:** put two leases side by side and answer the question a tenant actually has — *"which of
these is worse for me, and exactly where?"* — rather than producing a text diff.

**Depends on:** 03 (segmentation), 06 (analysis).
**Blocks:** 09, 10.

**Judged axes earned here:** Problem Alignment (an explicitly listed use case), Accessibility
(side-by-side is the hardest layout to get right at 320px).

---

## Deliverables

```
packages/core/src/compare/
  align.ts            clause alignment across two documents
  diff.ts             semantic differences, not textual ones
  verdict.ts          per-dimension "better for tenant" with reasons
  compare-types.ts    Comparison, AlignedPair, Divergence
  *.test.ts
```

## Tasks

- [ ] **Align by clause *type*, not by position or text similarity.** Two leases put the deposit
      clause in different places and word it differently; they are still the same clause. Use the
      Phase 01 taxonomy as the join key, then fall back to lexical similarity within a type when a
      document has several clauses of one type.
- [ ] Produce four alignment outcomes, and treat them all as findings:
      **matched** (both have it) · **only in A** · **only in B** · **ambiguous**.
      **An absent clause is often the most important result** — Lease B having no maintenance clause
      at all is a bigger fact than a wording difference, and a text diff buries it.
- [ ] **Compare extracted facts, not strings.** "two months' rent" vs "₹50,000" against ₹25,000 rent
      are *the same deposit*. Diff the normalised numbers from Phase 06, then explain the delta.
      This is what makes it a comparison rather than a diff.
- [ ] **Per-dimension verdicts** across the dimensions a tenant cares about — deposit, lock-in,
      notice symmetry, entry rights, maintenance burden, termination, penalties, renewal,
      dispute resolution. Each verdict states **which document is more favourable to the tenant and
      why**, citing the clause in each.
- [ ] **Never produce an overall "pick this one" recommendation.** That is advice — it applies law
      and judgement to the user's specific situation and recommends a course of action, which is the
      line Phase 05 enforces. Per-dimension comparisons with reasons are information; a
      recommendation is not. Present a scorecard, let the person decide, and offer the lawyer-prep
      pack.
- [ ] Support the second most common real case: **the same lease before and after negotiation**.
      Alignment is near-perfect there, and the diff becomes "here is exactly what changed and
      whether it moved toward or away from you" — which is genuinely valuable and easy to get right.
- [ ] Every divergence carries verified citations into **both** documents (Phase 07's verifier).

## Design notes

- The comparison is where the "compare contracts, agreements, or policies" bullet in the brief is
  earned, and the differentiator is doing it **semantically**. Any text editor can diff two files;
  the value is in "Lease B's deposit is 50% higher, its notice period is asymmetric where A's is
  not, and it has no repair-and-deduct right."
- Keep the model's role narrow: align and explain. The *comparisons* — which number is larger, which
  notice period is shorter, which party bears a cost — are computed in TypeScript.
- Accessibility constrains the design from the start: **SC 1.4.10 Reflow requires the whole thing to
  work at 320 CSS px with no two-dimensional scrolling.** Design the stacked, per-dimension
  presentation first and treat two columns as the wide-screen enhancement — not the reverse.

## Acceptance criteria

- Two structurally different leases with equivalent deposit terms align on deposit and report **no**
  material difference.
- A clause present in one document and absent in the other is reported as a **finding**, not
  silently skipped.
- Every per-dimension verdict cites a verified quote in each document.
- No output contains an overall recommendation — asserted by a test over the golden comparison set.
- The before/after negotiation case produces a clean changed-clause list.
- The compare view does not scroll horizontally at 320 CSS px (Playwright, Phase 10/11).

## Risks

- **Mis-alignment producing nonsense comparisons** — comparing A's deposit clause to B's termination
  clause is worse than not comparing. When confidence is low, report `ambiguous` and show both
  clauses rather than forcing a pair.
- **Scope creep.** Two documents, one persona. Do not build n-way comparison.
- **The side-by-side layout is the most likely WCAG failure in the project.** Budget real time for
  the responsive work, not a last-day media query.
