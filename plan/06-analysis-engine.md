# Phase 06 — Analysis Engine

**Goal:** turn a segmented lease into findings a worried tenant can act on — what each clause means
in plain English, which clauses are one-sided or risky and why, and what each party actually owes —
with the deterministic and model-driven parts cleanly separated.

**Depends on:** 01 (taxonomy), 03 (clauses), 04 (model port), 05 (guardrails).
**Blocks:** 08, 09, 10.

**Judged axes earned here:** Problem Alignment (this is the product), Efficiency (rules before
model), Testing (the rule layer is fully testable offline).

---

## The rules/model split — decided explicitly

| Job | Owner | Why |
|---|---|---|
| Is there a clause of type X? | **Rules** first, model to confirm | Synonym lists + numbering are reliable |
| Does the deposit exceed the cap? | **Rules only** | Arithmetic against a cited statute. A model must never do this. |
| Is notice asymmetric between parties? | **Rules only** | Structural comparison, jurisdiction-free |
| Does URLTA §1.403(a) prohibit this clause? | **Rules only** | Four enumerated types, deterministic |
| What does this clause *mean* in plain English? | **Model** | Genuine language work |
| Is this clause unusual in context? | **Model**, schema-constrained, citation-verified | Requires judgement |
| How severe is it? | **Rules**, from model-extracted inputs | Severity must be reproducible |

**The rule: anything numeric, statutory, or comparative is computed in TypeScript. The model
explains and classifies; it never calculates and never cites law.**

---

## Deliverables

```
packages/core/src/analyse/
  detect/               one detector per clause type (deterministic)
  extract.ts            model pass: structured facts per clause (amounts, periods, parties)
  explain.ts            model pass: plain-English explanation per clause
  rules.ts              statutory + asymmetry rule engine over extracted facts
  obligations.ts        who-owes-what matrix, per party
  score.ts              severity computation
  pipeline.ts           orchestration, concurrency, partial-failure handling
  *.test.ts
```

## Tasks

- [ ] **Run the deterministic pass first and report it immediately.** Clause typing, amount and
      period extraction by pattern, asymmetry detection, and the four URLTA prohibitions all run in
      microseconds with no API call. The UI can render real findings before any model call returns
      (Phase 12), and these findings are the ones that survive if the model is unavailable.
- [ ] **Escalate to the model only for genuinely ambiguous clauses.** Track and report the
      escalation rate — a low number is the efficiency story in one figure.
- [ ] **Structured extraction, then rules.** The model returns facts —
      `{ depositAmount, depositMonths, noticeDaysLandlord, noticeDaysTenant, lockInMonths,
      lateFeePercent, entryNoticeHours, ... }` — under a Gemini-safe schema, Zod-validated after
      parse. Then **TypeScript** compares those numbers to the jurisdiction rules from Phase 01.
      The model never sees a statutory number and never decides compliance.
- [ ] **Amounts are hard; treat them as such.** `₹50,000`, `Rs. 50,000/-`, `fifty thousand rupees
      only`, `$2,450.00`, `two (2) months' rent`. Parse deterministically with a tested normaliser,
      and when the deposit is expressed as a multiple of rent, resolve it against the extracted rent
      rather than asking the model to multiply.
- [ ] **Asymmetry detection is the backbone of the `unknown`-jurisdiction path** — it needs no
      statute at all. Compare: termination rights, notice periods each way, cure periods, indemnity
      direction, fee-shifting direction, entry rights, and who bears repair categories. A 30-day/
      2-day notice split is a finding in any jurisdiction on earth.
- [ ] **Obligations matrix.** For each party: what they must do, by when, and what happens if they
      do not. This is what a tenant actually needs and it feeds the Phase 09 checklist directly.
- [ ] **Plain-English explanations, with a measured target.** Aim for Flesch–Kincaid ≤ 8 /
      Reading Ease ≥ 60. Justify it honestly in the README as the **state-regulatory and
      health-literacy convention** (e.g. S.C. Code Ann. §37-4-201 at 7th grade; 27 R.I. Gen. Laws
      §27-74-11(c)(1) at ≤8th grade), **not** with the widely-repeated but unsupported claim that
      "the average American reads at an 8th-grade level" — PIAAC explicitly discourages grade-level
      translation, and the outlet that popularised that figure retracted it.
      The real justification is stronger anyway: consumer contracts measure at **Flesch–Kincaid
      14.67 / Reading Ease 34.86**, with **498 of 500** major sites' terms failing both thresholds,
      and *Cognition* (2022) found legal difficulty comes **largely from poor writing — centre-
      embedded clauses and long-distance dependencies — not specialised concepts**, impairing recall
      *even for experienced readers*. Restructuring genuinely helps; it is not dumbing down.
- [ ] **Every model-produced finding carries a verbatim quote plus offsets, and is dropped if the
      quote does not verify** (Phase 07's verifier). A finding without a verified anchor is not
      shown — fail closed.
- [ ] **Partial failure is normal, not exceptional.** One clause failing schema validation must not
      lose the other nineteen. Return per-clause status and render what succeeded, with an explicit
      "could not analyse this section" for the rest.
- [ ] Bounded concurrency across clauses, with the Phase 04 backoff. Never an unbounded fan-out.

## Design notes

- **Why the model never calculates:** "your deposit is 3× the legal cap" must be arithmetic against
  a cited statute, or it is a hallucination with a number in it. Given that purpose-built legal AI
  still hallucinates 17–33% of the time, the only defensible architecture is one where the model
  cannot make a legal claim at all — it extracts and explains, TypeScript concludes.
- **The deterministic layer is also the demo's insurance policy.** If the free-tier quota is
  exhausted mid-presentation, clause detection, asymmetry findings, the obligations matrix, and the
  URLTA prohibitions all still work. That is worth designing for deliberately.
- Findings are **information, not advice**: "this clause requires 30 days' notice from you and 2
  days from the landlord" — never "you should refuse to sign."

## Acceptance criteria

- On the golden set, deterministic detection achieves a stated precision/recall per clause type,
  reported in `reports/scorecard.md`.
- A deposit stated as "two months' rent" with rent of ₹25,000 yields `depositAmount: 50000` and,
  under an MTA-adopted jurisdiction, **no** cap violation — while three months' rent does flag one,
  citing s.11(1).
- With jurisdiction `unknown`, a lease with 30-day/2-day asymmetric notice still produces an
  asymmetry finding and **no** statutory claim.
- All four URLTA §1.403(a) clause types are detected on fixtures with correct citations.
- Every model-produced finding has a verified quote; a fixture with a fabricated quote produces
  **zero** findings rather than an unverified one.
- One clause failing validation does not fail the analysis — asserted with an injected failure.
- Plain-English explanations across the golden set score Flesch–Kincaid ≤ 8.
- The full pipeline runs offline from cassettes with no API key.

## Risks

- **Over-flagging.** A tool that marks every clause high-risk is noise, and a tenant learns nothing.
  Calibrate severity on the golden set and measure the false-positive rate explicitly; a normal,
  fair lease should produce few or no high-severity findings — make that a test.
- **Under-flagging the unusual.** Rules catch known patterns; genuinely novel one-sided drafting
  needs the model. Keep the escalation path, and treat a missed seeded red flag as a test failure.
- **Amount-parsing brittleness** across currencies, word-forms and lakh/crore notation. Fixture it
  heavily; it is cheap to test and expensive to get wrong.
