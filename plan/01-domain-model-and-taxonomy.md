# Phase 01 — Domain Model, Clause Taxonomy & Jurisdiction Rules

**Goal:** encode what a residential lease *is* — clause types, tenant-adverse patterns, and
jurisdiction rules — as **typed data with citations**, not as prose inside prompts. This is the
phase that decides whether LexMind is a legal tool or a chatbot with a nice UI.

**Depends on:** 00 (scaffold).
**Blocks:** 05, 06, 07, 08, 09.

**Judged axes earned here:** Problem Alignment (the whole substance of it), Code Quality
(data-driven, no hardcoded per-document logic).

---

## The architectural rule this phase exists to enforce

**Every legal assertion in LexMind is a row in a versioned data file with a citation, never a
sentence inside a prompt.** A model that "knows" deposit caps is a model that will confidently
invent one. A rule that says `{ jurisdiction: 'IN-MTA', cap: '2 months', cite: 'Model Tenancy Act
2021 s.11(1)', verified: true }` cannot.

This also means the model is never the authority on *what the law says* — only on *what this
document says*. That split is the product.

---

## Deliverables

```
packages/core/src/domain/
  clause-types.ts        the 38 canonical clause types + alternate names
  risk-taxonomy.ts       31 tenant-adverse patterns, each with severity + citation
  jurisdictions/
    index.ts             detection + resolution + honest-abstention logic
    in.ts                India: MTA-adopted vs State Rent Act vs TPA fallback
    us.ts                US: URLTA non-waivables + per-state deposit/late-fee rules
    uk.ts                England: post-Renters' Rights Act 2025 position
    unknown.ts           the default — and it is not an error state
  severity.ts            severity model + scoring inputs
  types.ts               Clause, Finding, Obligation, Party, Citation
  citations.ts           every legal citation, with a `verified` flag
  *.test.ts
docs/LEGAL-SOURCES.md    every citation, its source, and its verification status
```

## Tasks

### Clause taxonomy — derived from model instruments, not invented

- [ ] Encode **38 canonical clause types** with their alternate names, derived from four primary
      model instruments so the taxonomy is defensible rather than made up:
      the **gov.uk Model Agreement for an AST** (sections A–I), the **HUD Model Lease form
      90105-a** (31 numbered clauses), the **Model Tenancy Act 2021** (Chapters II–V + both
      Schedules), and **URLTA** (Articles I–V), cross-indexed against **OFT356 Annexe C**.
- [ ] Alternate names matter more than the canonical ones for detection — "lock-in period" /
      "minimum term" / "no-exit period"; "security deposit" / "caution deposit" / "bond" /
      "pagdi". Store them as a synonym list per type.
- [ ] Group into: Formation & parties · Term · Money · Condition & repair · Use & control ·
      Risk, liability & remedies. The grouping drives UI ordering in Phase 10.

### Risk taxonomy — 31 patterns, every one with a citation

- [ ] Encode the tenant-adverse patterns with `{ id, clauseType, whyAdverse, severity,
      citations[], jurisdictionScope }`. The high-value ones and their anchors:
      | Pattern | Anchor |
      |---|---|
      | Excessive security deposit | MTA 2021 s.11(1) · URLTA §2.101(a) · Cal. Civ. Code §1950.5(c) · NY GOL §7-108 · Tenant Fees Act 2019 |
      | Non-refundable deposit | Tenant Fees Act 2019 (only listed payments permitted) · MTA s.11(2) |
      | Lock-in period | **No statutory rule in India** — tested as a penalty under Indian Contract Act **s.74** |
      | Unilateral termination | Consumer Protection Act 2019 **s.2(46)(iv)** |
      | Entry without notice | MTA **s.17** (≥24 hrs, none before sunrise/after sunset) · URLTA §3.103(c) |
      | Maintenance shifting | MTA **s.15(1)** *"notwithstanding any agreement to the contrary"* · URLTA §2.104(c)–(d) · LTA 1985 s.11 + **s.12 (contracting out void)** |
      | Waiver of legal rights | URLTA **§1.403(a)(1)** · Cal. Civ. Code **§1953(a)(1)–(5)** |
      | Attorney-fee shifting | URLTA **§1.403(a)(3)** |
      | Confession of judgment | URLTA **§1.403(a)(2)** |
      | Exculpation / indemnity | URLTA **§1.403(a)(4)** |
      | Forfeiture / lockout | Protection from Eviction Act 1977 **s.2** · URLTA §4.207 · MTA s.20 |
      | Arbitration + class waiver | CRA 2015 Sch 2 **para 20(a)** · Arbitration Act 1996 **s.91** (auto-unfair ≤ £5,000) · Cal. Civ. Code §1953(a)(4) |
      | Late fee magnitude | Md. Real Prop. §8-208(d)(3) (≤5%) · NRS 118A.210 · Tenant Fees Act (≤3% over base, after 14 days) |
      | Unintelligible drafting | CRA 2015 **s.68** · UCTD **Art. 5** · CPA 2019 s.2(46)(vi) |
- [ ] **URLTA §1.403(a) is the single highest-value rule in the set** — four clause types a lease
      *may not* contain (waiver of rights, confession of judgment, landlord's attorney's fees,
      exculpation/indemnity), with a statutory remedy of actual damages plus up to three months'
      rent. Four deterministic detectors, one citation, real legal weight.
- [ ] **Correct a common error:** `16 C.F.R. §444.2(a)(1)` (FTC Credit Practices Rule) bans
      confessions of judgment for *"a lender or retail installment seller"* extending consumer
      credit — **it does not reach residential leases.** Cite URLTA §1.403(a)(2) instead. Getting
      this wrong is exactly the kind of confidently-wrong legal claim the product exists to avoid.

### Jurisdiction — resolve before asserting anything

- [ ] **Jurisdiction resolution runs before any substantive statement.** This is not a nicety:
      - **India: the Model Tenancy Act 2021 is a *model*, not law.** Only about four States/UTs have
        adopted it. Telling a Bengaluru or Delhi tenant "your deposit is capped at two months" is
        **stating something false**. The honest Indian default is: *"unless your State has enacted
        the Model Tenancy Act, this is governed by your State's Rent Act, the Transfer of Property
        Act, and your contract."*
      - Tenancy is a **State subject in India** and state-level in the US. Delhi's Rent Control Act
        **s.3(c)** excludes tenancies above ₹3,500/month, so most modern Delhi tenancies fall
        *outside* rent control entirely. Maharashtra **s.55** mandates registration with **no
        duration exemption**, defeating the ubiquitous 11-month workaround.
      - Registration Act 1908 **s.17(1)(d)**: registration is compulsory for leases *"from year to
        year, or for any term exceeding one year, or reserving a yearly rent"* — this, not any rule
        about eleven months, is why the 11-month agreement is the Indian default. **s.49**: an
        unregistered document that required registration cannot be received as evidence of the
        transaction.
      - **England: assured shorthold tenancies no longer exist.** The Renters' Rights Act 2025 (c.26)
        converted most existing ASTs to **assured periodic tenancies on 1 May 2026** and **abolished
        Section 21**. Any "AST + s.21" model is out of date. Deposit caps survive (5 weeks' rent
        under £50k annual rent, 6 weeks at or above); the tenancy *type* does not.
      - **US: do not hardcode sexual orientation or gender identity as federal FHA classes.** The
        seven statutory classes in 42 U.S.C. §3604 are race, color, religion, sex, national origin,
        familial status, and disability/handicap. HUD's 2021 *Bostock*-based position rested on an
        executive order revoked in January 2025 and is contested. Many **state and local** laws do
        cover SOGI, source of income, and criminal record — jurisdiction-specific, so treat it so.
- [ ] `unknown.ts` is a **first-class outcome, not a failure**. When jurisdiction cannot be
      determined, the product still explains what the document says, flags structurally one-sided
      clauses, and says plainly which statements it cannot make. Abstention is a feature.
- [ ] Every jurisdiction rule carries `{ verified: boolean, source: string, retrievedOn: string }`.
      `docs/LEGAL-SOURCES.md` lists them, and **unverified rules are marked in the UI**, not
      silently presented as fact.

### Severity

- [ ] Severity is computed from inputs, not chosen by a model: `statutoryStatus` (void /
      unenforceable / restricted / permitted / unknown) × `financialExposure` ×
      `asymmetry` (does the landlord have the mirror right?) × `reversibility`.
- [ ] **Asymmetry is the most generalisable signal** and needs no jurisdiction data at all: a
      termination right one party has and the other does not, a notice period of 30 days one way and
      2 days the other, indemnity flowing only one direction. It works on any lease anywhere, which
      makes it the backbone of the `unknown` jurisdiction path.

### The no-advice boundary, as data

- [ ] Encode the **Judicial Council of California's "May I Help You?"** test, which is a court-
      published, literally string-level heuristic:
      - *"Most of these questions contain the words 'Can I?' or 'How do I?' Telling someone how to
        do something is almost always appropriate."*
      - *"Most of the questions that ask whether to take a particular course of action contain the
        words 'Should I?' So whenever you hear the word 'should,' the court user may be asking for
        advice that you cannot provide."*
      - *"Analyzing a litigant's particular fact situation and advising him or her to take a certain
        course of action based on the applicable law is a job for a lawyer."*
      Plus: never predict what a judge will do; never refer to a **specific** private attorney (a
      bar-association or legal-aid **list** is fine).
- [ ] Encode the **four behaviours that cross the line**: applying law to the user's specific facts ·
      recommending a course of action · drafting or selecting the document for the user ·
      predicting an outcome. Phase 05 consumes this table.
- [ ] Note for Phase 13's README wording: the **LegalZoom v. NC State Bar** consent judgment made
      lawful operation conditional on, among other things, **explicit non-substitution disclosure**
      and — strikingly — **not disclaiming liability and not imposing an out-of-state forum**. And
      the **FTC's DoNotPay order** establishes that the enforceable violation is the
      **unsubstantiated capability claim**, independent of product quality. Every capability
      sentence we write must be one we could evidence.

## Design notes

- **Why data over prompts, restated as a scoring argument:** it makes the legal layer unit-testable
  with no network (Testing), keeps the model from inventing law (Problem Alignment), makes adding a
  jurisdiction a data change rather than a code change (Code Quality), and gives every UI assertion
  a citation to render (Problem Alignment again).
- The taxonomy must never contain a per-document or per-landlord special case. If a rule cannot be
  expressed as data with a citation, it does not belong in the product.
- **Calibrate ambition honestly.** Purpose-built legal AI on proprietary corpora — Lexis+ AI,
  Westlaw AI-AR — still hallucinates **17–33%** of the time, and general LLMs on legal queries
  hallucinate **58–88%**. A tool built on a user's PDF has no basis for claiming better. That is the
  argument for citation-verified output and abstention, and it belongs in the README.

## Acceptance criteria

- All 38 clause types and 31 risk patterns are encoded, each with at least one citation.
- `docs/LEGAL-SOURCES.md` lists every citation with its verification status; a test asserts no rule
  ships with an empty `citations[]`.
- A rule marked `verified: false` renders with a visible caveat — asserted by a UI test.
- Jurisdiction detection returns `unknown` rather than guessing when signals conflict, and the
  `unknown` path still produces asymmetry-based findings — proven on a fixture with no jurisdiction
  markers.
- An Indian lease with no State adoption marker **does not** assert the MTA's two-month cap; a test
  asserts this exact non-claim.
- The four URLTA §1.403(a) prohibited clause types are each detected deterministically on fixtures.
- `grep -r "should I" packages/core/src/domain` finds the boundary classifier, and a fixture of
  advice-seeking questions is classified correctly with both positive and negative cases.

## Risks

- **Legal accuracy is the existential risk of this project.** A confidently wrong statutory claim is
  worse than no claim. Mitigations: `verified` flags on every citation, abstention as a first-class
  outcome, and jurisdiction resolution before assertion.
- **Taxonomy sprawl.** 38 types and 31 patterns is already ambitious. Depth on the ten that matter
  most to a tenant (deposit, lock-in, notice, entry, maintenance, termination, penalties, waivers,
  arbitration, auto-renewal) beats shallow coverage of all 38. Mark the priority set explicitly.
- **Rules going stale.** England's regime changed materially on 1 May 2026; California's deposit cap
  changed on 1 July 2024. Date-stamp every rule with `retrievedOn` and say in the README that rules
  are current as of a stated date.
