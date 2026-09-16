# Phase 09 — Actionable Outputs

**Goal:** end every session with something the tenant can *use* — a negotiation checklist, a
lawyer-prep pack, a plain-English summary — because "helping users understand their options and
potential next steps" is in the brief, and because a refusal without a redirect fails the user.

**Depends on:** 06 (findings), 07 (Q&A), 08 (comparison).
**Blocks:** 10 (UI), 13 (submission).

**Judged axes earned here:** Problem Alignment (three brief bullets at once), Accessibility
(exports must be accessible artifacts too).

---

## Deliverables

```
packages/core/src/outputs/
  summary.ts          plain-English lease summary, readability-checked
  checklist.ts        negotiation checklist, prioritised by severity
  lawyer-pack.ts      questions + facts + clause references for a professional
  obligations.ts      calendar-style "what you owe and when"
  resources.ts        jurisdiction-appropriate next-step resources
  render/
    markdown.ts       the canonical export format
    html.ts           printable, semantic, accessible
  *.test.ts
```

## Tasks

- [ ] **The lawyer-prep pack is the single most defensible feature in the product.** It is
      explicitly in the brief ("helping users prepare information or questions for a legal
      professional"), it is squarely on the *information* side of the advice line, and it turns
      every refusal into a useful hand-off. It contains:
      - the clauses that need professional review, with **verified quotes and locations**
      - the specific questions to ask, generated from the findings
      - a facts summary the tenant would otherwise pay a lawyer to extract (parties, term, rent,
        deposit, notice periods, key dates)
      - what the tenant still needs to find out, and which documents to bring
      **This is what saves a real person real money**, and it is the honest answer to every
      "should I?" question the system must refuse.
- [ ] **Negotiation checklist**, prioritised by severity, each item phrased as information plus a
      question — *"Clause 8.2 requires 30 days' notice from you and 2 days from the landlord. You
      could ask whether the notice periods can be made equal."* Never *"demand that they change
      this."* Suggesting a question is information; instructing a course of action is advice.
- [ ] **Plain-English summary** — one page, structured by what a tenant cares about (money, time,
      obligations, exit, risks). Readability-tested (Flesch–Kincaid ≤ 8), and the test runs over
      generated output in CI, not over a hand-written sample.
- [ ] **Obligations timeline** — rent dates, notice deadlines, renewal windows, inspection
      obligations. Derived from the Phase 06 obligations matrix. Offer an `.ics` export; it is
      cheap, genuinely useful, and demos well.
- [ ] **Jurisdiction-appropriate resources**, from the Phase 01 verified list — never invented URLs.
      NALSA and State/District Legal Services Authorities for India; LSC "find legal aid",
      LawHelp.org, and the state HUD tenant-rights pages for the US; Shelter England, Citizens
      Advice, the Housing Ombudsman and the First-tier Tribunal (Property Chamber) for England.
      **Never link a specific private law firm** — a bar-association or legal-aid *list* is
      permissible, a named practitioner is not.
      **Never link a generic "Rent Authority" for India** — those exist only in States that enacted
      the Model Tenancy Act, so resolve per State or say plainly that one may not exist there.
- [ ] **Exports: Markdown as canonical, plus a print-friendly semantic HTML view.** Markdown is
      diffable, accessible, tiny, and pastes into an email to a lawyer. Generating PDFs would add a
      heavy dependency and produce a *less* accessible artifact — do not.
      **Note the browser constraint:** a published-page sandbox blocks page-initiated downloads, so
      any in-app "download" must be a server response (a Route Handler with
      `Content-Disposition`), not an `<a download>` with a blob URL.
- [ ] Every export carries the AI disclosure, the "information, not advice" statement, the
      jurisdiction caveat, and the generation date. These travel with the document, because the
      export is what gets forwarded.
- [ ] Every claim in every output traces to a verified citation — the same verifier as Phase 07. An
      export is the most likely artifact to be relied on, so it gets the strictest grounding.

## Design notes

- **This phase is where refusal becomes service.** Phase 05 refuses "should I sign this?"; this
  phase makes that refusal genuinely helpful by handing over a prepared pack. A system that only
  refuses fails the brief's purpose as surely as one that over-advises.
- Keep outputs **derived, never re-generated**. Every item comes from an existing verified finding.
  Introducing a fresh model call at export time would introduce fresh hallucinations into the most
  trusted artifact.
- Legitimate comparators (LawHelp Interactive, A2J Author) are acceptable precisely because the
  software performs deterministic assembly from institutionally-authored content and does not decide
  *which* document the user needs. Our outputs follow the same shape: assembled from verified
  findings, never authored freely.

## Acceptance criteria

- Every checklist item and lawyer-pack entry links to a verified clause citation.
- Generated summaries score Flesch–Kincaid ≤ 8 across the golden set, asserted in CI.
- No output contains an instruction to take a course of action — asserted by a phrasing test over
  the golden set.
- Resource links resolve and are jurisdiction-appropriate; a test asserts no private law firm is
  linked and no generic Indian "Rent Authority" link is emitted for a non-adopting State.
- Markdown and HTML exports both carry disclosure, advice-boundary, jurisdiction caveat, and date.
- The `.ics` export imports cleanly into a standard calendar.
- Exports are produced with **zero** additional model calls, proven by a spy on the model port.

## Risks

- **Drifting into advice.** The checklist is the most likely place. Keep every item in the form
  "clause says X — you could ask Y", and test the phrasing.
- **Stale or dead resource links.** Verify at build time; a broken legal-aid link fails the user at
  the worst moment.
- **Export bloat.** Keep Markdown canonical. A PDF pipeline would cost repo size, build time, and
  accessibility for no gain.
