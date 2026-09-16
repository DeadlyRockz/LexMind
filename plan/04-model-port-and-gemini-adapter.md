# Phase 04 — Model Port, Gemini Adapter & Offline Replay

**Goal:** one narrow interface between LexMind's legal logic and any LLM, with a real Gemini adapter
behind it and a deterministic replay adapter beside it — so the entire test suite and CI run with
**no API key, no network, and no cost**, and so the model is a swappable detail rather than a
dependency baked through the codebase.

**Depends on:** 00 (scaffold), 01 (domain types — the schemas this phase validates against).
**Blocks:** 06 (analysis), 07 (Q&A), 08 (comparison), 09 (outputs).

**Judged axes earned here:** Efficiency (token budget, caching, model tiering),
Testing (offline determinism), Security (key never leaves the server), Code Quality (ports & adapters).

---

## Deliverables

```
packages/core/src/model/
  port.ts              LlmPort interface + request/response types. NO vendor imports.
  errors.ts            ModelError taxonomy: Blocked, RateLimited, QuotaExhausted, Malformed, Timeout
  schema.ts            Zod -> Gemini-safe JSON Schema conversion + the keyword allowlist guard
  budget.ts            token estimation, per-request caps, model tiering policy
  retry.ts             exponential backoff + jitter, retryable-error classification
  adapters/
    gemini.ts          the only file in the repo that imports @google/genai
    replay.ts          cassette-backed deterministic adapter
    recording.ts       wraps gemini.ts, writes cassettes
  adapters/gemini.test.ts
  adapters/replay.test.ts
  schema.test.ts
test/cassettes/        committed JSON cassettes (small, text-only, PII-free)
```

## Tasks

- [ ] **`port.ts` — the whole contract, deliberately small:**
      ```ts
      export interface LlmPort {
        generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
        generateTextStream(req: TextRequest): AsyncIterable<string>;
        embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
        countTokens(text: string): Promise<number>;
      }
      ```
      No vendor types cross this boundary. Everything above it is testable with a fake.
- [ ] **Install `@google/genai`** (current SDK, v2.x, requires Node ≥ 20).
      **Do NOT install `@google/generative-ai`** — that package was deprecated on 2025-11-30 and its
      repo renamed to `deprecated-generative-ai-js`. It carries **no npm deprecation flag**, so
      `pnpm install` will not warn you. This is the single most likely wrong turn in the project.
- [ ] **Use the `ai.models.*` surface, not `ai.interactions.*`.** The SDK ships two parallel
      generation APIs; current ai.google.dev docs show the newer `interactions` one, which uses
      snake_case and **has no `temperature`/`topP`/`topK`**. We need sampling control, so we use
      `ai.models.generateContent({ model, contents, config })`. Mixing the two casings silently
      no-ops — record this in a comment at the top of `gemini.ts`.
- [ ] **Read the response correctly.** `response.text` is a **getter property, not a method**.
      `response.text()` throws `TypeError: response.text is not a function`. It is also
      `string | undefined` — undefined when content was blocked. Every read goes through one
      helper that checks `promptFeedback?.blockReason` and `candidates[0].finishReason` first.
- [ ] **Model tiering — pin in env, default conservatively:**
      | Job | Model | Why |
      |---|---|---|
      | Clause analysis, Q&A, comparison | `gemini-2.5-flash` | confirmed free-tier, 1M context |
      | Deterministic extraction / classification | `gemini-2.5-flash-lite` | **thinking is off by default** — cheapest, most repeatable |
      | Embeddings | `gemini-embedding-2` | free tier, `outputDimensionality: 768` |
      Put every ID in `LEXMIND_MODEL_*` env vars. Do **not** hardcode `gemini-3.x` IDs: they were not
      execution-verified, and `gemini-3.1-pro-preview` is **not available on the free tier**.
      Never reference `gemini-2.0-flash`, `gemini-1.5-*`, or `gemini-pro` — all retired.
- [ ] **`schema.ts` — the Gemini-safe schema guard. This is the subtle one.**
      `responseJsonSchema` supports only: `$id $defs $ref $anchor type format title description enum
      items prefixItems minItems maxItems minimum maximum anyOf oneOf properties additionalProperties
      required propertyOrdering`.
      **Unsupported and silently ignored:** `pattern`, `const`, `minLength`, `maxLength`,
      `multipleOf`, `allOf`, `not`, `uniqueItems`, `if`/`then`/`else`, `patternProperties`.
      Consequences to encode:
      - There is **no runtime Zod integration** in the SDK (`zod` is a devDependency there only).
        Convert explicitly with `zod-to-json-schema` and pass the plain object.
      - `responseMimeType: 'application/json'` is **required** when `responseJsonSchema` is set,
        and `responseSchema` must then be omitted.
      - A top-level `$schema` key causes the SDK to silently re-route `responseSchema` →
        `responseJsonSchema`. Strip it deliberately rather than being surprised by it.
      - `additionalProperties` is **silently dropped** when converting to the OpenAPI form.
      - **Therefore: constraints like string length, regex, and enums-of-one must be validated in
        Zod *after* parsing, never relied upon in the model-side schema.** Write
        `assertGeminiSafeSchema()` that walks a converted schema and throws on any unsupported
        keyword, and unit-test it against every schema the app actually sends.
- [ ] **Two-stage validation, always:** `JSON.parse` → `ZodSchema.safeParse`. On failure, one
      repair retry that feeds the validation error back; on second failure **fail closed** and
      surface "could not analyse this section" rather than shipping a malformed result to a user
      reading it as legal information.
- [ ] **`errors.ts` + `retry.ts`.** The SDK exports `ApiError extends Error` with a numeric
      `status`. Classify: `429 rate_limit_exceeded` → back off and retry; **`429 quota_exceeded`
      → daily cap, do not retry** (retrying within the day is futile); `408`/`5xx` → retry;
      `400`/`401`/`403` → fail immediately. Exponential backoff with jitter, max 5 attempts.
      **Do not assume the JS SDK retries for you** — the documented auto-retry policy is the Python
      SDK's.
- [ ] **Blocked-content handling.** Safety defaults are `Off` for 2.5/3.x models, but blocks still
      happen. On block, `candidates` is empty and `response.text` is `undefined`. Map
      `BlockedReason` / `FinishReason.SAFETY` to a typed `ModelBlockedError`. Treat
      `FinishReason.MAX_TOKENS` specially: JSON will be truncated and `JSON.parse` will throw, so
      check it *before* parsing.
- [ ] **`replay.ts` + cassettes.** Key each cassette by a SHA-256 of
      `(model, systemInstruction, contents, schemaHash)`. `LEXMIND_OFFLINE=1` forces the replay
      adapter and makes any cache miss a **hard failure**, so a test can never silently reach the
      network. `recording.ts` regenerates cassettes via `pnpm cassettes:record` (a manual,
      key-required step — never part of CI).
- [ ] **`budget.ts`.** Estimate before sending (`ai.models.countTokens`); refuse requests over a
      configured ceiling with a typed error rather than letting a 300-page PDF silently cost a
      fortune. Record real usage from `response.usageMetadata` —
      `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`,
      `totalTokenCount` — and expose it so Phase 12 can report cost per analysis.
- [ ] **Caching.** Implicit caching is **on by default for 2.5+**; exploit it by putting the large,
      stable content (the lease text, the system instruction) at the **start** of every prompt and
      varying only the tail. Explicit `ai.caches` needs ≥ 2,048 tokens for 2.5-series — worth it
      when a user asks several questions about one lease. Measure hits via `cachedContentTokenCount`.
- [ ] **Key hygiene.** `GEMINI_API_KEY` is read in `gemini.ts` only. The web app imports the port
      through a `apps/web/lib/model.ts` wrapper that begins `import 'server-only'`. A Phase 11 test
      greps the client bundle for the key prefix and fails if found.
- [ ] Do **not** send whole PDFs to Gemini in the default path. Gemini bills PDFs at
      **258 tokens per page** regardless of text density; our own parser (Phase 02) produces the
      text plus the character offsets that citations depend on, which the PDF path cannot give us.
      Keep native-PDF input as an explicitly-flagged fallback for scanned documents only.

## Design notes

- **Why a port at all, in a hackathon?** Three judged axes pay for it at once: Testing (a fake
  satisfies the interface, so 90% coverage on legal logic needs no network), Security (exactly one
  file can see the API key), and Code Quality (the vendor SDK's quirks — getter-not-method, dual
  API surfaces, silently-dropped schema keywords — stay quarantined in ~150 lines instead of
  smearing across the codebase).
- **The offline adapter is the load-bearing piece.** A grader cloning this repo has no Gemini key.
  If `pnpm test` needs one, the Testing axis reads as zero. `LEXMIND_OFFLINE=1 pnpm test` passing
  on a fresh clone is the single most valuable property in this phase.
- Free-tier RPM/TPM/RPD figures are **no longer published by Google** — the docs redirect to the
  AI Studio dashboard, and third-party numbers conflict. Do not hardcode limits or build a
  client-side rate limiter around invented numbers; handle 429 properly instead.

## Acceptance criteria

- `LEXMIND_OFFLINE=1 pnpm test` passes on a clean clone **with no `GEMINI_API_KEY` set**, and a
  deliberately-removed cassette makes the relevant test fail loudly rather than hit the network.
- `assertGeminiSafeSchema()` rejects a schema containing `pattern` or `minLength`, with a test proving it.
- A malformed-JSON cassette drives exactly one repair retry, then a typed `ModelMalformedError`.
- A `429 quota_exceeded` cassette produces **zero** retries; a `429 rate_limit_exceeded` cassette
  produces backoff then success.
- `grep -rl "@google/genai" packages/core/src | wc -l` returns **1**.
- Every analysis run reports token usage and estimated cost in the CLI output.

## Risks

- **Model IDs drift.** The 2.5-series IDs are docs-verified but were not called live (no key was
  available during planning). First task on getting a key: run a one-line `ListModels` check and
  correct the env defaults. Everything else is insulated by the env var.
- **Cassette rot.** If prompts change, cassettes go stale and tests fail confusingly. Include the
  prompt hash in the cassette filename so a mismatch reads as "prompt changed, re-record" rather
  than "the model is broken."
- **Free-tier daily quota exhaustion mid-demo.** Mitigate with explicit caching, `flash-lite` for
  the deterministic passes, and a pre-recorded demo path that runs entirely from cassettes.
