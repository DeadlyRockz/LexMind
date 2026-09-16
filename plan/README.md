# LexMind — AI for Legal Assistance & Access
## Implementation Plan

**Vertical:** AI for Legal Assistance & Access
**Persona:** the **tenant facing a residential lease or rental agreement**

**Goal:** given a lease a person is worried about, produce a plain-English explanation, the clauses
that are risky or one-sided **with verified citations**, answers to questions grounded only in that
document, a comparison against a second lease, and a pack they can take to a lawyer — while never
crossing from legal *information* into legal *advice*.

**Scoring context:** the leaderboard's top scores are 99.60 / 98.95 / 98.50. Every one of the six
judged axes has to be near-perfect, and each has to be *demonstrable* rather than claimed.

---

## 1. Recon — verified, not assumed

| Fact | Status |
|---|---|
| `LexMind/` contains **only `CLAUDE.md`** | verified — greenfield, not yet a git repo |
| Toolchain available | Node 24.12.0 · pnpm 10.28.1 · git 2.50.1 · gh 2.89.0 |
| No AI provider key in the environment | verified — nothing in `env` |
| House conventions (from the prior hackathon repo) | pnpm workspace `packages/*` + `apps/*`, TS strict with `noUncheckedIndexedAccess`, `submission/` folder |
| **That repo had no CI at all** | a gap worth closing — Testing and Code Quality are separate axes here |

### Decisions taken before planning (not re-litigated)

- **Persona:** tenant / residential lease.
- **Stack:** pnpm workspace · `packages/core` (framework-free TS + headless CLI, zero UI imports) ·
  `apps/web` (Next.js App Router) · Vitest.
- **Model:** **Google Gemini via an AI Studio key**, behind a thin `LlmPort` with a Gemini adapter
  and a deterministic offline replay adapter.

---

## 2. What the research changed

Six discovery agents verified APIs and law firsthand. Each row below is a wrong turn avoided.

| Finding | Consequence |
|---|---|
| **Gemini's free tier trains on submissions.** Google's terms: *"Do not submit sensitive, confidential, or personal information to the Unpaid Services"*; human reviewers may read API input and output | **PII redaction before transmission is the architecture**, not a feature ([05](05-safety-and-guardrails.md)) |
| **`@google/generative-ai` is EOL** (deprecated 2025-11-30) and carries **no npm deprecation flag** | Use `@google/genai`; nothing would have warned us ([04](04-model-port-and-gemini-adapter.md)) |
| The SDK ships **two parallel APIs**; current Google docs show the newer `interactions` surface, which has **no `temperature`/`topP`** | Pin `ai.models.*`. Mixing casings silently no-ops |
| `response.text` is a **getter, not a method** | `response.text()` throws `TypeError` — the single most common runtime error |
| `responseJsonSchema` **silently ignores** `pattern`, `minLength`, `const`, `allOf` | Length/regex constraints must be validated in Zod **after** parsing; ship an `assertGeminiSafeSchema()` guard |
| Gemini bills PDFs at **258 tokens/page** regardless of density | Never send PDFs natively — our parser is cheaper *and* yields the offsets citations need ([12](12-performance-and-token-budget.md)) |
| **A 238 KB DOCX expanded to 2.2 GB RSS** (measured) | Zip-bomb pre-flight from the ZIP central directory, ~1 ms, reject at 100:1 ([02](02-document-ingest-and-parsing.md)) |
| `pdfjs-dist` modern build **throws on import in Node 24** | Must use `legacy/build/pdf.mjs` |
| `vitest-axe`'s npm `latest` is **0.1.0 from 2022**, documenting an API only in an unreleased prerelease | Use `jest-axe@11` — verified working with Vitest 5 ([10](10-web-ui-and-accessibility.md)) |
| **Zero WCAG 2.2 coverage** unless `wcag22aa` is passed explicitly; Playwright's own docs omit it | Exact tag array pinned; `target-size` reports as `incomplete`, which `toEqual([])` ignores |
| Vitest **cannot test async Server Components** (documented) | Validates the core/web split — logic in route handlers would be untestable |
| **England's ASTs no longer exist** — Renters' Rights Act 2025 converted them to assured periodic tenancies on 1 May 2026 and abolished Section 21 | Any "AST + s.21" model is a year out of date ([01](01-domain-model-and-taxonomy.md)) |
| **The Model Tenancy Act 2021 is a model, not law** — only ~4 Indian States adopted it | Telling a Delhi or Bengaluru tenant "your deposit is capped at two months" **states something false**. Jurisdiction resolution must precede every assertion |
| `16 C.F.R. §444.2` (confession of judgment) covers **consumer credit, not leases** | Cite URLTA §1.403(a)(2) instead |
| Purpose-built legal AI hallucinates **17–33%**; general LLMs on legal queries **58–88%** | The honest basis for citation-verification and abstention ([07](07-grounded-qa-and-citations.md)) |

**Two of the planner's own premises were corrected:** WCAG 3.2.6 and 3.3.7 are **Level A**, not AA
(the new AA criteria are exactly 2.4.11, 2.5.7, 2.5.8, 3.3.8); and the claim that dropzones need a
Browse button for SC 2.5.7 has **no W3C source** — the correct justification is SC 2.1.1 Keyboard.

---

## 3. Architecture

```
  PDF / DOCX / paste
          │
          ▼
  ┌─────────────────────────────────────────────────────┐
  │ P02  Ingest — magic bytes · zip-bomb guard · worker  │
  │      isolation · normalise · CHARACTER OFFSETS       │
  └───────────────────────┬─────────────────────────────┘
                          │  NormalizedDocument
  ┌───────────────────────▼─────────────────────────────┐
  │ P03  Segmentation — deterministic clause boundaries, │
  │      hierarchical outline, lexical retrieval index   │
  └───────────────────────┬─────────────────────────────┘
                          │  Clause[] (offset-anchored)
  ┌───────────────────────▼─────────────────────────────┐
  │ P05  SAFETY — the ONLY path to the model             │
  │  redact PII → strip invisible Unicode → separate     │
  │  document channel → no-advice boundary               │
  └───────────────────────┬─────────────────────────────┘
                          │
  ┌───────────────────────▼─────────────────────────────┐
  │ P04  LlmPort ── Gemini adapter │ offline replay      │
  └───────────────────────┬─────────────────────────────┘
                          │
   P01 Taxonomy  ────────▶│  P06 Analysis     P07 Q&A     P08 Compare
   38 clause types        │  rules ∕ model    grounded    semantic,
   31 risk patterns       │  split            + verified  not textual
   jurisdiction rules     │                   citations
   (DATA, with citations) │
                          ▼
  ┌─────────────────────────────────────────────────────┐
  │ P09  Outputs — summary · checklist · LAWYER PACK     │
  └───────────────────────┬─────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────┐
  │ P10  Web UI — WCAG 2.2 AA, proven by axe + manual    │
  └─────────────────────────────────────────────────────┘

  P11 evaluation harness wraps everything.  P12 performance.  P00 scaffold/CI.  P13 submission.
```

### The three decisions everything else follows from

1. **All legal logic lives in `packages/core`, with zero UI imports.** Vitest cannot test async
   Server Components, so logic in route handlers would be effectively untestable. This single
   boundary is what makes 90% coverage on real logic achievable, keeps the API key in exactly one
   file, and gives the CLI parity with the web app.
2. **The model extracts and explains; TypeScript concludes.** Anything numeric, statutory, or
   comparative is computed in code against a cited rule. The model is never the authority on what
   the law says — only on what *this document* says.
3. **Nothing is shown without a citation verified in code.** The model returns a verbatim quote plus
   offsets; TypeScript asserts the quote exists in the source. Unverified claims are dropped. Since
   our corpus is one uploaded document, verification is a substring check rather than a retrieval
   problem — a genuine architectural advantage.

---

## 4. Phases

| # | Phase | Primary axes |
|---|---|---|
| [00](00-scaffold-and-ci.md) | Scaffold, toolchain & CI | Code Quality · Testing |
| [01](01-domain-model-and-taxonomy.md) | Domain model, clause taxonomy & jurisdiction rules | **Problem Alignment** |
| [02](02-document-ingest-and-parsing.md) | Document ingest & parsing | Security · Efficiency |
| [03](03-clause-segmentation-and-grounding.md) | Clause segmentation & grounding index | Problem Alignment · Code Quality |
| [04](04-model-port-and-gemini-adapter.md) | Model port, Gemini adapter & offline replay | Efficiency · Testing |
| [05](05-safety-and-guardrails.md) | Safety, privacy & responsible-AI guardrails | **Security** · Problem Alignment |
| [06](06-analysis-engine.md) | Analysis engine | **Problem Alignment** · Efficiency |
| [07](07-grounded-qa-and-citations.md) | Grounded Q&A & citation verification | Problem Alignment · Security |
| [08](08-lease-comparison.md) | Lease comparison | Problem Alignment |
| [09](09-actionable-outputs.md) | Actionable outputs | Problem Alignment |
| [10](10-web-ui-and-accessibility.md) | Web UI & accessibility engineering | **Accessibility** |
| [11](11-evaluation-harness.md) | Test & evaluation harness | **Testing** |
| [12](12-performance-and-token-budget.md) | Performance, token budget & cost | **Efficiency** |
| [13](13-readme-docs-and-submission.md) | README, docs & submission | all six |

### Minimum viable submission, if time runs short

**00 → 01 → 02 → 03 → 04 → 05 → 06 → 10 → 11 → 13.**

Cuttable, in this order, without breaking the deliverable:
**08** (comparison) → **09** (beyond the lawyer pack, which is too valuable to cut) →
**07** multi-turn (keep single-shot Q&A) → **12** (measure, don't optimise).

Never cut: the offline replay adapter, the citation verifier, the no-advice boundary, or the
accessibility work. Those four are what the score rests on.

---

## 5. How each judged axis is earned, and where

| Axis | Earned by | Proven by |
|---|---|---|
| **Problem Alignment** (High) | Tenant persona throughout; 38 clause types and 31 risk patterns as cited data; verified citations; **abstention as a feature**; lawyer-prep pack turning every refusal into a hand-off | `reports/scorecard.md`, `docs/LEGAL-SOURCES.md` |
| **Code Quality** (High) | `packages/core` with zero UI imports; ports & adapters around the model; taxonomy as data, never per-document branches; strict TS; Biome + ESLint | Architecture tests; CI |
| **Security** | PII redaction before transmission; **the lethal trifecta closed — no tool calls, no outbound fetch, no remote images**; injection defence treated as architecture; zip-bomb/XXE/page guards; key in one file | `docs/SECURITY.md`; adversarial suite |
| **Efficiency** | Rules before model; text over native PDF (258 tok/page); prompt ordering for implicit cache hits; content-addressed cache; model tiering | `reports/perf.md` |
| **Testing** | Golden set of ~15 annotated synthetic leases; **whole suite green offline with no API key**; ≥90% coverage on core; adversarial + architecture + a11y + e2e | `pnpm test`, `pnpm eval` |
| **Accessibility** | WCAG 2.2 AA; `<mark>` + navigable highlight index; correct streaming live-region pattern; 320px reflow; forced-colors; manual log | axe in Vitest + Playwright; `docs/ACCESSIBILITY.md` |

---

## 6. Non-negotiable rules

1. **Every legal assertion is a row in a versioned data file with a citation** — never a sentence in
   a prompt.
2. **The model never calculates, never cites law, never decides compliance.** It extracts and
   explains; TypeScript concludes.
3. **No claim is shown without a citation verified in code against the source text.** Fail closed.
4. **Jurisdiction is resolved before any substantive statement**, and `unknown` is a valid,
   first-class outcome — asymmetry findings still work with no statute at all.
5. **The model never sees raw PII**, and the surrogate map never leaves the process.
6. **No tool calls, no outbound fetch of model-provided URLs, no auto-rendered remote images.** The
   exfiltration leg of the lethal trifecta stays closed.
7. **Information, never advice.** *"Can I?"* and *"How do I?"* are answerable; *"Should I?"* is
   refused **and redirected** to the lawyer pack. Never predict outcomes; never draft binding
   documents; never name a private attorney.
8. **The whole test suite runs with no API key and no network.**
9. **Nothing is claimed that the scorecard cannot evidence.**

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **A confidently wrong statutory claim** | existential | Rules as cited data; `verified` flags; jurisdiction-before-assertion; abstention; the MTA-is-a-model rule |
| Free-tier data-use vs. real lease PII | high | Redact with consistent surrogates before transmission; synthetic demo docs; disclose in UI **and** README |
| Prompt injection from the uploaded document | high | Architectural defence: exfiltration channel closed entirely. Documented honestly — adaptive attacks beat published defences **>90%** of the time |
| Free-tier quota exhausted mid-demo | high | Cassette-backed demo path; content-addressed cache; deterministic layer works with no model at all |
| Comparison view failing SC 1.4.10 at 320px | medium | Design stacked-first; Playwright reflow test from the start |
| Redaction degrading analysis quality | medium | Consistent type-matched surrogates (landlord ≠ tenant); **measure the delta** on the golden set, don't assume it's zero |
| Over-flagging / over-refusal making it useless | medium | Clean-fair-lease control fixture; refusal fixtures with **both** labels; false positives are test failures |
| `hasEOL` unreliable on real PDFs | medium | Validate against 5–10 genuine leases from different producers before trusting it |
| Golden-set bias (we write both leases and analyser) | medium | Draft fixtures from the model instruments, not from our detectors; hand-test real leases |
| Repo >10 MB / multi-branch / leaked key | submission-fatal | `check-size.sh` in CI; gitleaks; push protection at repo level; clean-clone test **before** attempt #1 |

---

## 8. Open questions for the build

1. **Confirm the Gemini model IDs live.** The 2.5-series IDs are docs-verified but were never called
   (no key during planning). First task on getting a key: one `ListModels` check, then correct the
   env defaults. Everything else is insulated behind `LEXMIND_MODEL_*`.
2. **Free tier vs paid.** The plan assumes free-tier + redaction + disclosure. If a paid key is
   available, Google's terms stop applying training to submissions and the privacy posture improves
   materially — worth reconsidering before launch.
3. **Jurisdiction scope.** Depth on India + US + England is planned. Narrowing to one would raise
   accuracy per jurisdiction; breadth demos better. Decide before Phase 01 ships.
4. **CSP shape.** Nonce-based CSP forces fully dynamic rendering and is **incompatible with PPR**.
   Static headers is the pragmatic default; revisit only if strict CSP is worth losing static
   rendering.
