# Phase 13 — README, Docs & Submission

**Goal:** make the repository legible to someone who has fifteen minutes, no API key, and a rubric.
The README is a **judged artifact**, not an afterthought — the brief names its required contents
explicitly.

**Depends on:** everything.
**Blocks:** nothing. This is the last phase.

**Judged axes earned here:** all six — this is where they become visible.

---

## Deliverables

```
README.md                  the judged document
docs/
  ARCHITECTURE.md          the core/web split and why
  SECURITY.md              threat model, controls, residual risk
  ACCESSIBILITY.md         conformance statement + manual test log
  LEGAL-SOURCES.md         every citation + verification status
  EVALUATION.md            how to reproduce the scorecard
reports/
  scorecard.md             committed, regenerable via `pnpm eval`
  perf.md                  committed, regenerable via `pnpm bench`
SUBMISSION.md              the rules checklist, ticked
```

## Tasks

### README — structured to the brief's own four requirements

- [ ] **1. Chosen vertical.** AI for Legal Assistance & Access → **the tenant facing a residential
      lease**. State the persona in one paragraph and why it was chosen: high real-world incidence,
      severe information asymmetry, low access to professional help, and concrete, checkable
      document structure.
- [ ] **2. Approach and logic.** Lead with the architectural thesis, because it is the answer to
      four of the six judged axes at once:
      > All legal logic lives in a framework-free `packages/core` library with zero UI imports. The
      > model extracts and explains; **TypeScript concludes**. Every legal assertion is a row in a
      > versioned data file with a citation. Every model claim about the document carries a quote
      > that is verified in code against the source text — unverified claims are dropped, not shown.
- [ ] **3. How the solution works.** A short pipeline diagram and the commands. Make the very first
      thing a reader can run be the thing that works without a key:
      ```
      pnpm install --frozen-lockfile
      LEXMIND_OFFLINE=1 pnpm test        # full suite, no API key, no network
      pnpm eval                          # regenerates reports/scorecard.md
      pnpm dev                           # needs GEMINI_API_KEY
      ```
- [ ] **4. Assumptions made.** Be specific and unflattering where warranted:
      - Jurisdiction rules are current as of a stated date; England's regime changed on 1 May 2026
        and California's deposit cap on 1 July 2024.
      - **The Model Tenancy Act 2021 is a model, not law** — only a handful of Indian States have
        adopted it, so for most Indian users the governing regime is their State Rent Act plus the
        Transfer of Property Act plus the contract.
      - Sample leases are **synthetic**; no real personal data is in the repo.
      - Automated PII detection is imperfect — name detection is roughly 87–90% F1 at best.
      - Prompt injection is mitigated, **not solved**.
- [ ] **Quote real numbers from `reports/scorecard.md` and `reports/perf.md`**, not adjectives. Link
      both so a reader can regenerate them.
- [ ] **State the limitations prominently, near the top, not buried.** Calibration is a scoring
      asset: purpose-built legal AI (Lexis+ AI, Westlaw AI-AR) hallucinates **17–33%** of the time
      and general LLMs on legal queries **58–88%** — which is precisely why this system verifies
      citations in code and abstains rather than guessing. Saying this builds more trust than any
      claim of accuracy would.
- [ ] **Disclose the Gemini free-tier data-use trade-off in the README, not only in the UI.**
      Google's terms state *"Do not submit sensitive, confidential, or personal information to the
      Unpaid Services"* and that human reviewers may read API input and output. Document the
      mitigation — PII redaction with consistent surrogates before transmission, synthetic demo
      documents — as a deliberate, considered decision.
- [ ] **Watch every capability sentence.** The FTC's DoNotPay order establishes that the enforceable
      violation is the **unsubstantiated capability claim**, independent of product quality. Never
      compare output to a lawyer's; never imply substitution. Every capability sentence must be one
      we could evidence from the scorecard.
- [ ] CI badge, licence, and a short "what this is not" section.

### Supporting docs

- [ ] `docs/SECURITY.md` — the threat model (**the private data and the untrusted input are the same
      bytes**), the controls, the verified properties (XXE structurally impossible; pdf.js does not
      execute embedded JavaScript; no outbound fetch of model-provided URLs), and the residual risk
      stated plainly, including that adaptive attacks defeat published injection defenses **>90%** of
      the time.
- [ ] `docs/ACCESSIBILITY.md` — the conformance target (WCAG 2.2 AA), what was automated, what was
      tested by hand, and a manual result for each of the four new AA criteria (**2.4.11, 2.5.7,
      2.5.8, 3.3.8** — note 3.2.6 and 3.3.7 are Level A). Note honestly that automation catches
      roughly **57% of issues by volume** and that axe ships **one** partial WCAG 2.2 rule,
      disabled by default.
- [ ] `docs/LEGAL-SOURCES.md` — every citation with source and `verified` status. Unverified rules
      are marked in the UI too.
- [ ] `docs/ARCHITECTURE.md` — the core/web boundary, the ports-and-adapters model layer, and the
      offline replay design.

### Submission rules — mechanical, and each one is a fail if missed

- [ ] **Repository is public.**
- [ ] **Exactly one branch.** `git branch -a` shows only `main`.
- [ ] **Under 10 MB.** Run `scripts/check-size.sh`; no committed `node_modules`, no build output,
      no binary fixtures, no rendered deck at print resolution. *(The previous hackathon repo
      carried a multi-MB PDF in `submission/` — do not repeat that.)*
- [ ] **No secrets committed.** `git log -p | grep -i 'AIza'` is empty; `.env` is untracked;
      gitleaks is green; GitHub push protection is enabled at the **repository** level (it is on by
      default for users, but **off by default for repositories**).
- [ ] **CI green** on the final commit.
- [ ] Clean clone test, on a different machine or a fresh directory:
      `git clone && pnpm install --frozen-lockfile && LEXMIND_OFFLINE=1 pnpm test && pnpm build`.
- [ ] `SUBMISSION.md` with every rule ticked and the evidence command beside it.
- [ ] **Only three submission attempts exist.** Do the clean-clone test *before* the first one.

## Design notes

- **The README is the highest-leverage file in the repository.** A reviewer with a rubric reads it
  first and often decides most of the score there. Every one of the six axes should be findable in
  it within thirty seconds, with a link to the evidence.
- **Honesty outscores polish.** A stated limitation with a measured number reads as engineering
  maturity; a claim a reviewer can falsify discounts everything else in the document.
- Write it for a reviewer who will not run the app. Numbers, diagrams, and committed reports do the
  work that a live demo cannot.

## Acceptance criteria

- README answers all four required questions — vertical, approach and logic, how it works,
  assumptions — each under its own heading.
- Every number in the README appears in a committed report that `pnpm eval` / `pnpm bench`
  regenerates.
- All five `docs/*.md` exist and are non-trivial.
- `SUBMISSION.md` has every rule ticked with its verification command.
- Clean-clone test passes end to end with no API key.
- Packed repository is verified under 10 MB, single branch, public, CI green.

## Risks

- **Leaving the README to the last hour.** It is worth more per minute than any feature. Draft it at
  Phase 06 and keep it current.
- **Overclaiming.** One unsupported sentence ("as accurate as a lawyer") is both a scoring risk and,
  per the FTC's DoNotPay order, the exact shape of an enforceable violation.
- **Repo size creeping past 10 MB** from fixtures or a deck. Make `check-size.sh` a CI step, not a
  final-day discovery.
