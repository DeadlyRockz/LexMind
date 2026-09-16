# Phase 12 — Performance, Token Budget & Cost

**Goal:** make LexMind fast enough to feel immediate and cheap enough to survive a public demo on a
free-tier key — and be able to *prove* both with numbers rather than adjectives.

**Depends on:** 04 (model port), 06 (analysis), 10 (UI).
**Blocks:** 13 (README reports these numbers).

**Judged axis earned here:** Efficiency — "optimal use of resources", which a grader reads as
*measured*, not *claimed*.

---

## Deliverables

```
packages/core/src/perf/
  budget.ts           token ceilings, per-stage caps, refusal above limits
  cache.ts            content-addressed analysis cache (hash of normalized text)
  chunk.ts            clause-aware chunking + prompt ordering for cache hits
  meter.ts            records usage + latency per stage, emits a report
  meter.test.ts
reports/perf.md       generated: latency, tokens, cost per document class
scripts/bench.ts      `pnpm bench` — runs the golden set, writes reports/perf.md
```

## Tasks

### Token budget — the dominant cost lever

- [ ] **Never send the PDF natively.** Gemini bills PDFs at a flat **258 tokens per page**
      regardless of text density. A 40-page lease costs ~10,300 tokens as a PDF; the same lease as
      extracted text is typically a fraction of that — and the PDF path cannot give us the character
      offsets citations depend on. Our own parser (Phase 02) is both cheaper and more capable.
- [ ] **Count before sending.** `ai.models.countTokens()` on the assembled prompt; refuse above a
      configured ceiling with a typed error rather than discovering the cost afterwards. This is
      also the OWASP **LLM06 Unbounded Consumption / "Denial of Wallet"** control.
- [ ] **Cap output explicitly** — `maxOutputTokens`, `candidateCount: 1`. An unbounded output cap on
      a schema-constrained call is free money for an attacker.
- [ ] **Tier the models by job**, not by habit:
      - `gemini-2.5-flash-lite` for deterministic extraction and classification — **thinking is off
        by default** on this model, which makes it both the cheapest and the most repeatable.
      - `gemini-2.5-flash` for analysis, Q&A, and comparison.
      Measure and report the split; a reviewer should see that we did not send every call to the
      biggest model available.
- [ ] Record real usage from `response.usageMetadata` — `promptTokenCount`, `candidatesTokenCount`,
      `thoughtsTokenCount`, `cachedContentTokenCount`, `totalTokenCount` — and surface
      **tokens and estimated cost per analysis** in both the CLI output and `reports/perf.md`.

### Caching — three layers, cheapest first

- [ ] **Exploit implicit caching.** It is **on by default for Gemini 2.5 and newer**, and it keys on
      a shared prompt *prefix*. So structure every prompt as **[stable system instruction] +
      [lease text] + [varying task/question]** — large and constant first, variable last. Getting
      this ordering backwards silently forfeits the discount. Verify it worked by reading
      `cachedContentTokenCount`, and report the hit rate.
- [ ] **Explicit context caching** for the multi-question case. A user who asks five questions about
      one lease should pay for that lease once. Minimum **2,048 tokens** for the 2.5-series, so gate
      it on document size; below that, implicit caching already covers it.
- [ ] **Content-addressed analysis cache.** Key on `sha256(normalizedText + analysisVersion +
      modelId)`. Re-analysing the same document is then free and instant — which also makes the demo
      reliable if the free-tier daily quota is exhausted mid-presentation.
- [ ] The cassette layer from Phase 04 doubles as the ultimate cache: the recorded demo path runs
      with **zero** API calls.

### Latency — where the user actually feels it

- [ ] **Stream everything the user reads.** Plain-English explanations and Q&A answers go out as
      `ReadableStream` from a Route Handler on the default **Node runtime** — streaming needs no
      `runtime = 'edge'`, which is deprecated in route segment config anyway.
- [ ] **Parallelise independent stages.** Clause segmentation is deterministic and local; risk
      detection per clause is independent. Fan out with a bounded concurrency limit (respecting
      rate limits), rather than a sequential loop over twenty clauses.
- [ ] **Do the deterministic work first and cheaply.** Rule-based detection (Phase 06) runs in
      microseconds with no API call; only genuinely ambiguous clauses escalate to the model. Report
      the escalation rate — a low one is the efficiency story in a single number.
- [ ] **Render progressively.** Structure, clause list, and rule-based findings appear while the
      model work is still in flight. Perceived latency is the metric that matters.
- [ ] Bundle discipline: lazy-load the PDF parser (**~505 KB gzipped**) only when a user actually
      picks a PDF; never in the initial bundle.

### Measurement

- [ ] `pnpm bench` runs the golden set and writes `reports/perf.md` with, per document class
      (1-page / 10-page / 40-page): parse time, segmentation time, rule-pass time, model latency,
      prompt/output/cached tokens, estimated cost, and cache hit rate.
- [ ] Commit `reports/perf.md`. Numbers in a README that a reviewer can regenerate are worth far
      more than claims.
- [ ] Add a CI guard on the **offline** path only — parse + segment + rule-pass must stay under a
      wall-clock budget — so a performance regression is caught without needing an API key.

## Design notes

- **Efficiency here is mostly architectural, not micro-optimisation.** The four decisions that
  dominate every constant factor are: extract text ourselves rather than paying per PDF page,
  order prompts so the cache prefix is stable, do deterministic work before model work, and cache
  by content hash. Everything else is noise beside those.
- Free-tier rate limits are **no longer published by Google** — the docs redirect to the AI Studio
  dashboard, and third-party figures conflict with each other. Do **not** build a client-side
  limiter around invented numbers or state them in the README; handle `429` correctly instead, and
  distinguish `rate_limit_exceeded` (back off) from `quota_exceeded` (daily cap — retrying is
  futile).
- Efficiency and Security overlap here: every token ceiling is simultaneously a cost control and a
  denial-of-wallet control. Say so once, in `docs/SECURITY.md`, and cross-reference it.

## Acceptance criteria

- `reports/perf.md` exists, is generated by `pnpm bench`, and reports tokens *and* estimated cost
  per document class.
- Implicit cache hits are demonstrable: a second analysis of the same lease shows a non-zero
  `cachedContentTokenCount`, asserted in a test against a cassette.
- Re-analysing an identical document makes **zero** API calls (content-addressed cache), proven by
  a spy on the model port.
- First visible output — document structure and rule-based findings — appears before any model call
  completes.
- The escalation rate (share of clauses needing a model call) is reported and is below 100%, i.e.
  the deterministic layer is genuinely doing work.
- The initial JS bundle does not contain the PDF parser, asserted by a bundle-content check.
- The offline pipeline stays within its CI time budget.

## Risks

- **Premature optimisation.** Everything here must be driven by `reports/perf.md`. Do not build the
  explicit cache before measuring that implicit caching is insufficient.
- **Cache-key staleness.** If the analysis version is left out of the key, a prompt change silently
  serves stale results. Include `analysisVersion` and `modelId`, and test that changing either
  misses the cache.
- **Over-parallelising into a 429.** Bounded concurrency, with backoff — an efficiency "win" that
  trips the rate limit is a loss.
