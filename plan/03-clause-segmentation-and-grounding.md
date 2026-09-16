# Phase 03 — Clause Segmentation & the Grounding Index

**Goal:** cut a normalized lease into addressable clauses with exact character offsets, and build the
retrieval index that makes every later answer citable. This phase is what makes "grounded in your
document" true rather than a marketing line.

**Depends on:** 02 (NormalizedDocument with offsets).
**Blocks:** 06 (analysis), 07 (Q&A), 08 (comparison).

**Judged axes earned here:** Problem Alignment (citations are the whole trust story),
Code Quality (deterministic, pure, heavily testable), Efficiency (retrieval beats stuffing).

---

## Deliverables

```
packages/core/src/segment/
  headings.ts        numbering + heading detection (deterministic)
  clauses.ts         Clause[] with charStart/charEnd/page/heading/path
  outline.ts         hierarchical document outline (ARTICLE > Section > sub-clause)
  index.ts           retrieval index over clauses
  lexical.ts         BM25-style lexical scoring (no model, no network)
  embed.ts           optional semantic layer via the model port
  locate.ts          quote -> offsets resolver used by citation verification
  *.test.ts
```

## Tasks

### Deterministic segmentation first

- [ ] **Segment with rules, not a model.** Leases are highly structured: numbered clauses,
      `ARTICLE`/`SECTION`/`CLAUSE` keywords, ALL-CAPS headings, indentation, and — for DOCX — real
      heading levels from mammoth's `<h1>`–`<h6>`. A deterministic segmenter is faster, free,
      reproducible, and unit-testable. Use the model only to *label* clauses (Phase 06), never to
      find their boundaries.
- [ ] Numbering schemes to handle, in one table-driven matcher rather than a pile of regexes:
      `1.` · `1.1` · `1.1.1` · `(a)` · `(i)` · `(A)` · `Article 5` · `Section 5.2` · `Clause 5` ·
      `5.` followed by an ALL-CAPS run. Roman numerals must not swallow the word `I` at a line start.
- [ ] Build a **hierarchical outline**, not a flat list. "Section 8.3 — Deductions from Deposit"
      inherits meaning from "Article 8 — Security Deposit"; a flat list loses that, and the answer
      quality drops with it.
- [ ] Every `Clause` carries `{ id, path, heading, text, charStart, charEnd, pageStart, pageEnd }`.
      **`document.text.slice(charStart, charEnd) === clause.text` must hold exactly** — assert it for
      every clause in every test. That invariant is what every highlight and citation rests on.
- [ ] Handle the awkward realities: preamble and recitals before clause 1, definitions sections,
      schedules and annexures, signature blocks, page headers/footers repeating on every page
      (detect and exclude by repetition across pages), and tables.

### Retrieval — lexical first, semantic only if measured to help

- [ ] **Start with lexical retrieval (BM25-style) over clauses.** It needs no API call, no network,
      and no embedding cost; it is deterministic, so tests are stable; and on a single document of
      20–80 clauses it is often simply sufficient. Ship this first and measure it.
- [ ] Add the semantic layer only if the golden-set retrieval score says lexical is inadequate.
      If added: `gemini-embedding-2` via the model port, `outputDimensionality: 768` (the range is
      128–3072, default 3072 — 768 is plenty for tens of clauses and a quarter of the storage).
      **Never mix vectors from `gemini-embedding-001` and `gemini-embedding-2`; the spaces are
      incompatible.** Batch by passing an array of texts in one call.
- [ ] **Hybrid scoring** if both exist: lexical catches exact legal terms ("lock-in", "indemnify",
      a specific sum), semantic catches paraphrase ("can they kick me out early?"). Legal language
      is unusually keyword-dense, so do not assume semantic wins.
- [ ] Always retrieve **whole clauses with their heading path**, never arbitrary character windows.
      A half-sentence of a lease is worse than useless — it is misleading, and it cannot be cited.

### The locator — small, and load-bearing

- [ ] `locate.ts` resolves a model-returned quote back to exact offsets. This is the function the
      citation verifier (Phase 07) depends on, so it must be conservative:
      1. Exact match on the raw normalized text.
      2. Normalized match (NFKC, collapse whitespace, case-fold) — needed because PDF extraction
         introduces whitespace and ligature drift the model will not reproduce byte-for-byte.
      3. **Fail.** Return `null`. Do **not** fuzzy-match on edit distance — a loose threshold
         manufactures citations that look verified and are not, which is worse than no citation.
- [ ] Return **all** occurrences, not the first. A phrase like "thirty (30) days" appears many times
      in a lease; a citation pinned to the wrong occurrence points the user at the wrong clause.
      Disambiguate using the clause the model claimed, and fail if it cannot be resolved uniquely.

### Chunking for the model

- [ ] Whole document in context is usually correct — `gemini-2.5-flash` has a 1M-token window and a
      lease is typically well under 50k. **Do not build a RAG pipeline for a document that fits.**
      Retrieval exists here for *citation and targeting*, not because of a context limit.
- [ ] For genuinely long documents, chunk on **clause boundaries with heading context prepended**,
      never on a fixed token count mid-sentence.
- [ ] Order every prompt as **[stable system instruction] + [document] + [varying task]** so the
      implicit prefix cache (on by default for Gemini 2.5+) actually hits. See Phase 12.

## Design notes

- **Why deterministic segmentation is a scoring decision, not just an engineering one.** It makes
  the core unit-testable without a network, which is what lets the Testing axis reach 90% coverage
  on real logic. A model-based segmenter would make every test an integration test.
- **The offset invariant is the spine of the product.** Highlights, citations, comparison anchors,
  and the "jump to clause" interaction are all offsets. Phase 02 produces them, Phase 03 preserves
  them, Phase 07 verifies them. If any layer silently re-normalizes text, every citation shifts.
  Enforce it with an invariant test at each boundary.
- Retrieval has a security dimension too: returning whole clauses with provenance keeps the
  document in a structurally separate, labelled channel rather than concatenated into instructions
  (Phase 05).

## Acceptance criteria

- For every clause in every fixture, `text.slice(charStart, charEnd) === clause.text`.
- A lease using `ARTICLE`/`Section`/`(a)`/`(i)` numbering produces a correct nested outline, asserted
  against a hand-written expected tree.
- Repeated page headers and footers do not appear as clauses.
- `locate()` returns `null` for a quote that is not in the document, and a test asserts it never
  invents an offset.
- `locate()` on a phrase occurring five times returns five occurrences, not one.
- Retrieval quality is measured on the golden set: for each seeded question, the correct clause is
  in the top-3 at a stated rate, reported in `reports/retrieval.md`.
- Segmentation runs with **zero** network calls and is covered by unit tests at ≥ 90%.

## Risks

- **Over-fitting the segmenter to fixtures.** Leases vary wildly across producers and jurisdictions.
  Keep the numbering matcher table-driven so a new scheme is a data change, and build fixtures from
  several distinct drafting styles rather than variations on one.
- **Silent offset drift.** Any later change to `normalize.ts` invalidates every stored offset. Guard
  with the invariant tests above, and treat normalization as frozen once Phase 03 lands.
- **Reaching for embeddings too early.** They add cost, network dependence, and test flakiness. The
  golden set decides, not intuition.
