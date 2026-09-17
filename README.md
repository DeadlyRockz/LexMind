# LexMind

[![CI](https://github.com/DeadlyRockz/LexMind/actions/workflows/ci.yml/badge.svg)](https://github.com/DeadlyRockz/LexMind/actions/workflows/ci.yml)

**Challenge theme:** AI for Legal Assistance & Access.
**Chosen vertical:** the tenant facing a residential lease or rental agreement.

LexMind reads a lease and reports what it actually says: the clauses that are risky or
one-sided, what you owe and when, and what the law in your jurisdiction says about specific
clauses — every legal rule backed by a citation, and every AI-generated sentence checked in code
against a verbatim quote from your own document before it is ever shown.

## What this is not

**LexMind gives legal information, not legal advice.** It does not tell you whether to sign,
predict what a court will do, draft a document for you, or compare its output to a lawyer's. It
exists to help someone prepare for a conversation with a professional, not replace one.

## Limitations, stated up front

Calibration is worth more than confidence here, so these are stated before anything else:

- **AI hallucination is the default failure mode of this category of tool.** Purpose-built legal
  AI (Lexis+ AI, Westlaw AI-Assistant Research) hallucinates in **17–33%** of tested queries;
  general-purpose LLMs on legal questions hallucinate **58–88%** of the time. LexMind's response is
  architectural, not aspirational: every clause explanation and summary sentence must carry a
  quote that is verified word-for-word against the source document in plain TypeScript — a claim
  that fails verification is dropped, never shown with a caveat.
- **Jurisdiction rules are current only as of when they were written into the rule set.** England's
  Renters' Rights Act 2025 replaced assured shorthold tenancies with periodic tenancies and
  abolished Section 21 on 1 May 2026; California's security-deposit cap changed on 1 July 2024.
- **India's Model Tenancy Act 2021 is a model, not a law** — only a handful of states have adopted
  it. For most Indian tenants, the governing regime is their State Rent Act plus the Transfer of
  Property Act plus the lease contract itself, and LexMind's jurisdiction resolver is built around
  that distinction rather than assuming the Model Act applies nationwide.
- **Automated PII redaction, applied before any text reaches the AI provider, is roughly 87–90%
  F1** — a real mitigation, not a guarantee.
- **Prompt-injection defenses are mitigated, not solved.** Published defenses are defeated by
  adaptive attacks over 90% of the time in the literature; LexMind detects and neutralises
  embedded instructions it can find, and is guarded so an injected "verdict" in the document text
  cannot override the real analysis output, but this is a mitigated risk, not an eliminated one.
- **Sample leases in this repo are synthetic.** No real personal data is committed.

## 1. Chosen vertical

**AI for Legal Assistance & Access → the tenant facing a residential lease.** This persona was
chosen deliberately: residential leases are near-universal, tenants routinely face severe
information asymmetry against a landlord or agent who has seen the document form before, access to
a lawyer for a one-off lease review is rare, and — unlike open-ended legal questions — a lease is a
bounded, checkable document with clauses that can be typed, extracted, and matched against a known
body of tenancy law. That boundedness is what makes citation-verified, rather than merely
plausible-sounding, output achievable at all.

## 2. Approach and logic

The architectural thesis, because it is also the answer to most of the judged criteria at once:

> All legal logic lives in a framework-free `packages/core` library with **zero UI imports**. The
> model extracts and explains; **TypeScript concludes.** Every legal assertion — a deposit cap, a
> notice-period minimum, a prohibited clause — is a row in a versioned data file with a citation,
> evaluated in code. Every AI-generated claim about the document carries a quote that is verified
> against the source text; unverified claims are dropped, not shown.

Concretely:

- **Ingest** (`packages/core/src/ingest`) — PDF/DOCX/plain-text parsing with layout-aware character
  offsets, so every downstream quote and citation can point back to an exact span in the original.
- **Segment** (`packages/core/src/segment`) — deterministic clause boundaries and a hierarchical
  outline, built without a model call.
- **Analyse** (`packages/core/src/analyse`) — rule-based fact extraction (amounts, dates,
  obligations), a versioned jurisdiction rule set, and an AI pass that produces plain-English
  clause explanations and a one-page summary — each sentence checked against the document before
  it reaches the reader.
- **Safety** (`packages/core/src/safety`) — PII redaction with consistent surrogates before any
  text leaves the process (Google's Gemini free tier is trained on submissions; this is why
  redaction happens before transmission, not as an afterthought), plus prompt-injection detection
  so text in the document that reads as instructions to an AI system cannot pass itself off as
  LexMind's own output.
- **Model layer** (`packages/core/src/model`) — a `LlmPort` interface with a Gemini adapter and a
  deterministic offline replay adapter, so the entire test suite runs with no API key and no
  network access, and the AI provider can fail, be rate-limited, or be absent without taking down
  the rest of the analysis.

The rule-based layer is the product's floor: with no API key, or with `LEXMIND_OFFLINE=1`, every
deposit, notice-period, entry-rights and prohibited-clause check still runs, fully offline.

## 3. How the solution works

```
  PDF / DOCX / pasted text
          │
          ▼
   ingest → segment → rule-based analysis (findings, obligations, jurisdiction)
          │                                              │
          └──────────────────────┬───────────────────────┘
                                  ▼
                   AI pass (Gemini): clause explanations + summary
                   — every sentence quote-verified against the source
                                  ▼
                        CLI report  /  web JSON response
```

Commands — the first one works with no API key and no network access:

```bash
pnpm install
LEXMIND_OFFLINE=1 pnpm test          # full suite, 1015 tests, no key, no network
pnpm lexmind analyse ./lease.pdf     # CLI: full rule-based report, offline
pnpm dev                             # web UI at localhost:3000 — needs GEMINI_API_KEY for the AI pass
```

The CLI's `analyse` command is the fully implemented surface today: `pnpm lexmind analyse <file>
[--jurisdiction <id>] [--json]`. `ask` (grounded Q&A), `compare` (clause-by-clause lease
comparison), `pack` (the lawyer-prep checklist) and `eval` (the scoring harness) are designed —
their jurisdiction data, schemas and safety plumbing already exist and are shared with `analyse` —
but not yet wired to a command; `pnpm lexmind --help` marks each one explicitly rather than
presenting a stub as a feature.

The web app (`apps/web`) exposes the same engine through `/api/analyse` and a live test page at
`/try`; the home page at `/` documents both entry points.

## 4. Assumptions made

- A user has, or can obtain, the lease as a PDF, DOCX, or plain text — not a photo of a printed
  page (OCR is out of scope).
- The jurisdiction rule set covers India (Model Tenancy Act states, general state rent law), the
  US (URLTA, California, New York), and England; a lease outside those is still segmented and
  explained, but fewer numeric rules apply.
- "Plain English" targets roughly an eighth-grade reading level, because consumer contracts
  measure around Flesch–Kincaid grade 14.7 in practice, and *Cognition* (2022) found legal
  difficulty comes largely from sentence structure — long-distance dependencies, centre-embedded
  clauses — rather than specialised vocabulary, which restructuring genuinely fixes.
- The Gemini free tier's terms state that human reviewers may read API input and output, and that
  sensitive or personal information should not be submitted to it. LexMind's answer is to redact
  PII before any request leaves the process and to use synthetic documents for its own demos and
  tests, not to avoid disclosing the trade-off.

## Gen AI usage

**Google Gemini**, via the official `@google/genai` SDK, is the only Gen AI service used, and it is
optional throughout — every code path above degrades to deterministic rule-based analysis if it is
absent, rate-limited, or fails.

| Task | Model | Where |
|---|---|---|
| Structured extraction (clauses, obligations, amounts) — temperature 0, for reproducibility | `gemini-3.5-flash-lite` | `packages/core/src/analyse`, `packages/core/src/model` |
| Plain-English clause explanations and the one-page lease summary | `gemini-3.5-flash` | `packages/core/src/analyse/explain.ts` |

Both are reached by end users through the CLI (`lexmind analyse`) and the web UI (`/try` →
`/api/analyse`). Model IDs are read from the environment (`LEXMIND_MODEL_ANALYSIS`,
`LEXMIND_MODEL_EXTRACT`) rather than hardcoded, which is what made it a one-line fix rather than a
redeploy when Google deprecated `gemini-2.5-flash-lite` for new users during this project's own
development.

## Quality gates (verified locally, reproducible with the commands shown)

- **Tests:** 1015/1015 passing — `pnpm test`. The core engine's suite runs fully offline
  (`LEXMIND_OFFLINE=1`, no API key, no network); the web project runs the two live pages through
  `jest-axe` against the WCAG 2.2 AA tag set (`pnpm vitest run --project web`).
- **Coverage:** 97.6% statements / 91.0% branches / 98.4% functions on `packages/core` —
  `pnpm coverage`. Scoped to the core engine deliberately: coverage on the legal logic is a
  signal, coverage chased across JSX is not.
- **Types and lint:** `pnpm typecheck` and `pnpm lint` both clean, strict TypeScript
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no implicit `any`) throughout.
- **Accessibility:** the home page and the live engine test page pass automated `axe` checks
  against `['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']` — the tag set needed to actually
  run axe's WCAG 2.2 rule, which a default `.analyze()` never does. Both also carry a skip link,
  `lang="en"`, a single `<h1>`, and a live region for asynchronous status rather than a silent
  state change. Colour contrast is a manual/browser concern outside jsdom's reach and is not yet
  automated in CI.
- **Security:** no secrets are committed (`.env` and `.env.local` are gitignored and untracked);
  every AI-bound request is redacted before transmission; prompt-injection guards are unit- and
  end-to-end-tested against adversarial cassettes, including a fixed case where an injected
  "verdict" in document text could otherwise have overridden the real analysis output. The web
  API route returns a provider's own `userMessage` on model failure, never the raw vendor error
  text a caught exception carries; it rejects an oversized upload against the same limit
  `packages/core` enforces before spending a parse attempt on it; and a request the platform
  cannot read as form data returns a 400, not an unhandled 500.

## Status

Implemented: ingest, segmentation, rule-based analysis (findings, obligations, jurisdiction
resolution for India/US/England), the AI explanation-and-summary pass with citation verification,
safety guardrails, the CLI, and a minimal web bridge (`/try`, `/api/analyse`).

Not yet implemented: grounded Q&A (`ask`), lease-to-lease comparison (`compare`), the
lawyer-prep checklist (`pack`), the automated evaluation harness (`eval`), performance
benchmarking, and the full accessible web interface — `/` and `/try` are functional but
intentionally minimal, not the final UI.

No licence file has been added yet.
