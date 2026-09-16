# Phase 02 — Document Ingest & Parsing

**Goal:** turn an untrusted PDF, DOCX, or pasted text into one normalized string plus per-item
position data — page, coordinates, font size, and **character offsets** — because every citation,
highlight, and clause anchor downstream is an offset into that string.

**Depends on:** 00 (scaffold), 01 (domain types).
**Blocks:** 03 (segmentation), and therefore everything.

**Judged axes earned here:** Security (untrusted file handling), Efficiency (bounded resources),
Code Quality (one clean boundary between bytes and meaning).

---

## Deliverables

```
packages/core/src/ingest/
  detect.ts            magic-byte type detection + allowlist
  guards.ts            size/page/ratio/entry/timeout ceilings
  pdf.ts               unpdf -> PositionedItem[]
  docx.ts              zip pre-flight + mammoth -> structured blocks
  text.ts              paste/markdown path
  normalize.ts         NFKC + quote/dash folding + de-hyphenation
  offsets.ts           builds the canonical text + offset index
  scanned.ts           two-signal scanned-PDF detection
  worker.ts            isolated parse with memory + wall-clock caps
  types.ts             NormalizedDocument, PositionedItem, IngestError
  *.test.ts
test/fixtures/generate.ts   builds every fixture PROGRAMMATICALLY
```

## Tasks

### Library choices — decided, with reasons

- [ ] **PDF: `unpdf@^1.8.1`.** It is a serverless-oriented repackaging of Mozilla's pdf.js with
      **zero runtime dependencies**, it installs at **2.5 MB vs pdfjs-dist's 35 MB**, it has no
      CVEs, and — decisively — its `extractTextItems()` returns `StructuredTextItem` with
      `{ str, x, y, width, height, fontSize, fontFamily, dir, hasEOL }`, i.e. it **pre-computes
      `fontSize`**, which raw pdf.js does not expose at all.
- [ ] Keep `pdfjs-dist` as an optional direct dependency **only** if we need
      `getOperatorList` (we do, for scanned detection) or `getJSActions`. If used:
      - **Import `pdfjs-dist/legacy/build/pdf.mjs`.** The modern build **throws at import time on
        Node 24** with `hashOriginal.toHex is not a function`. This is verified, not theoretical.
      - Require **`pdfjs-dist >= 6.2.108`** — CVE-2026-16633 (CVSS 8.6) affects 5.6.83–6.2.107.
      - `isEvalSupported` **no longer exists** in v6. Passing it is silently ignored; do not
        document it as a hardening measure.
- [ ] **DOCX: `mammoth@^1.12.3`.** Not lower: 1.12.3 fixed a **ReDoS**, 1.12.2 fixed a
      **prototype-pollution bug that could flip `externalFileAccess` back to true**, 1.12.1 fixed a
      path traversal, and 1.11.0 fixed CVE-2025-11849.
- [ ] **Use `convertToHtml`, not `extractRawText`.** `extractRawText` gives paragraph breaks
      (exactly `\n\n`) but discards heading level — and we need "ARTICLE 5 — SECURITY DEPOSIT" to
      register as a heading for clause segmentation. Mammoth's default style map handles
      `p.Heading1`, `p[style-name='Heading 1']`, the lowercase variant, and Apple Pages' `p.Heading`,
      with `:fresh` guaranteeing one block element per Word paragraph.
- [ ] **Type detection: `file-type@^22.1.0`** (ESM-only; requires Node ≥ 22). Note **21.3.2 fixed
      CVE-2026-32630**, a zip-decompression bomb in its own `[Content_Types].xml` handling.
- [ ] **`.npmrc`: `omit=optional`.** `@napi-rs/canvas` — **27 MB of native binaries** — is an
      optional dependency of *both* `pdfjs-dist` and `unpdf`. It is only needed for rendering, and
      we never render. Omitting it is a third of our install footprint.
- [ ] **Pin transitive floors via `overrides`:** `@xmldom/xmldom >= 0.8.15` (it carries **12 OSV
      advisories**, 10 of them CVEs published in 2026; mammoth only declares `^0.8.6`) and
      `pdfjs-dist >= 6.2.108`.

### Security — the measured threats

- [ ] **DOCX zip bomb is the #1 must-fix, and it is worse than it sounds.** A bomb placed in an
      *unreferenced* entry is harmless (mammoth only decompresses what it needs), **but a bomb
      inside `word/document.xml` itself is severe: a measured 238 KB upload expanded to 61 MB of
      XML and consumed 2.2 GB of RSS in 2.5 seconds.** Fifty concurrent uploads OOM any container.
- [ ] **The fix costs ~1 ms.** `JSZip.loadAsync()` reads the ZIP central directory **without
      decompressing anything**, exposing per-entry `uncompressedSize` and `compressedSize`. Reject
      before parsing:
      | Guard | Limit | Why this number |
      |---|---|---|
      | Compression ratio, per entry | **100:1** | Real `document.xml` measures 1–2×; bombs measured **258×** and **1029×**. Enormous separation. |
      | Total decompressed bytes | **50 MB** | The 61 MB bomb hit 2.2 GB RSS. |
      | ZIP entry count | **512** | A real lease DOCX has fewer than 30; `file-type` itself uses 1024. |
      **Note `zip.files[name]._data` is private JSZip API** — pin the version and cover it with a
      test, or use `fflate`'s documented `unzip(data, { filter })` equivalent.
- [ ] **PDF page-count guard before any page work.** `doc.numPages` is available ~28 ms after
      `getDocument`, before touching a single page. Reject above **300 pages** there.
- [ ] **Isolate parsing in a worker with hard caps** — `resourceLimits: { maxOldGenerationSizeMb:
      512 }` plus a 30 s wall-clock timeout. Mammoth's own README recommends exactly this:
      "running Mammoth in a separate thread with a timeout." An OOM then becomes a contained,
      typed failure instead of a dead container.
- [ ] **XXE and billion-laughs are structurally impossible** with mammoth + `@xmldom/xmldom` —
      verified: the parser has no `fs`/`http`/`fetch` imports at all, skips the DOCTYPE internal
      subset entirely, and uses a fixed entity map, so custom entities are never registered. Both
      attacks fail in ~1–6 ms with `entity not found`. **Document this in `docs/SECURITY.md` as a
      verified property**, and add regression tests so a future library swap cannot silently
      reintroduce it.
- [ ] **pdf.js does not execute embedded PDF JavaScript.** Verified with a tripwire: `/OpenAction`,
      a `/Names /JavaScript` tree, and page `/AA` actions were all *reported* by `getJSActions()`
      but never run; `build/pdf.mjs` contains zero occurrences of `eval(` or `new Function`. The
      scripting sandbox lives only in the *viewer* bundle, which we never import. Use
      `hasJSActions()` as a **signal to surface to the user**, not as a danger to us.
- [ ] **Never trust the client `Content-Type`** — OWASP: "trivial to spoof." Detect by magic bytes
      (`%PDF-` = `25 50 44 46 2D`; `PK\x03\x04` = `50 4B 03 04`) and allowlist explicitly.
- [ ] **Pass the complete buffer to `file-type`.** DOCX detection must reach `[Content_Types].xml`:
      4 bytes yields `zip`, 512 bytes yields `docx`. A truncated read silently under-detects.
- [ ] **Route the paste/`.txt`/`.md` path around `file-type` entirely** — it returns `undefined`
      for text by design, since text has no binary signature. Validate as "decodes as strict UTF-8
      and contains no NUL bytes" instead.
- [ ] **Never render mammoth's HTML unsanitised.** Its README is explicit: "Mammoth performs no
      sanitisation of the source document." Source documents can carry `javascript:` link targets.
- [ ] Set `externalFileAccess: false` explicitly (it is the default since 1.11.0, but state it) and
      `includeEmbeddedStyleMap: false` — we do not honour a style map supplied by the attacker.

### Extraction quality — where naive implementations fail

- [ ] **Copy the buffer on every call.** pdf.js **transfers ownership** of the typed array to the
      worker: after one call `buf.byteLength === 0`, and a second call throws `DataCloneError`.
      Always pass `new Uint8Array(raw)`.
- [ ] **Reading order is not guaranteed.** `getTextContent()` emits items in content-stream draw
      order, not human reading order — documented in mozilla/pdf.js issues #14493 and #17191. **A
      two-column lease will interleave columns unless sorted.** Implement the standard pipeline:
      1. Sort per page by `(-y, x)` with a y-tolerance band of ~0.5 × fontSize.
      2. **Detect columns before assembling lines** — cluster by x-range; if a page has ≥2
         well-separated clusters spanning most of its height, process each as its own stream.
         Skipping this is the single biggest source of garbled output.
      3. Insert a space when `next.x - (item.x + item.width) > 0.2 × fontSize`.
      4. Start a paragraph when `Δy` exceeds ~1.4× the median line delta, or on an indent change.
      5. De-hyphenate at line joins.
- [ ] **Do not use `getStructTree()` for reading order** — the tag tree's order is not required to
      match reading order, and it is absent from most real-world leases.
- [ ] **Treat `hasEOL` as one signal, never the sole line splitter**, and treat `height` as
      unreliable (issue #8276) — derive font size from the transform instead.
- [ ] **Normalization: hand-roll it, add no dependency.** `String.prototype.normalize('NFKC')`
      folds ligatures (ﬁ→fi, ﬃ→ffi) and NBSP, but **does not** fold curly quotes, en/em dashes, or
      soft hyphens — those are ~10 lines of `.replace()`. Every candidate npm package was rejected:
      `smartquotes` and `tipograph` convert in the *wrong direction*, `unidecode-plus` is
      destructive (it would mangle names and currency in a legal document), and `hyphen` *inserts*
      hyphenation points.
- [ ] **De-hyphenate only across a line break**, never within a line — a lease legitimately contains
      `co-tenant` and `month-to-month`. Require lowercase-hyphen-newline-lowercase so
      `LEASE-\nAGREEMENT` survives.
- [ ] `Intl.Segmenter` is built into Node 24 and gives locale-aware sentence segmentation free —
      but run a numbered-clause pre-pass first, since it splits `"1. "` and `"TERM. "` as sentences.

### Scanned PDFs

- [ ] **Two-signal detection**, not one: (a) non-whitespace characters per page below **~100**, and
      (b) ≥1 image paint op from `getOperatorList()` (`paintImageXObject`, `paintJpegXObject`,
      `paintInlineImageXObject`, `paintImageMaskXObject`). A bare `items.length === 0` test misses
      the common "scanner added a stray header" case. Measured separation on fixtures: 151.0
      chars/page + 0 image ops vs 0.0 chars/page + 1 image op.
- [ ] **Do not bundle OCR.** The smallest viable offline footprint is `tesseract.js-core` (**43 MB**)
      plus `eng.traineddata` (2–11 MB) ≈ **45 MB** — which blows the 10 MB repo limit outright if
      vendored, and `tesseract.js` resolves its core WASM and language data **from a CDN at
      runtime**, which breaks offline CI. `officeparser` is disqualified for the same reason
      (it depends on tesseract.js: **99 MB installed**).
- [ ] Instead return a typed `ScannedPdfError` naming the affected pages: *"Pages 3–7 are scanned
      images with no text layer. Re-export from the source document, or run OCR and re-upload."*
      This is also the **honest legal answer** — silently OCR-ing a lease and then citing clause
      positions from noisy OCR output would produce confidently wrong citations.

### Client-side path (the privacy story)

- [ ] Both libraries run fully in the browser, so "your lease never leaves your machine" is
      achievable for the parsing step. Costs, measured gzipped: `mammoth.browser.min.js` **136 KB**;
      pdf.js **~505 KB** (modern build + worker).
- [ ] **Use the *modern* build in browsers and *legacy* in Node** — the reverse of the intuitive
      mapping. Wire the worker with the officially shipped helper:
      `new Worker(new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url), { type: "module" })`.
- [ ] **Lazy-load with `await import()`** — 505 KB gzipped must never be in the initial bundle.
- [ ] Skip `cMapUrl` / `standardFontDataUrl` and set `useWasm: false`; those assets are for
      rendering only, not `getTextContent()`.
- [ ] Prefer `unpdf` on the server and real `pdfjs-dist` with a true `Worker` in the browser —
      unpdf inlines its worker and would run on the main thread, janking the UI.

### Fixtures

- [ ] **Generate every fixture programmatically in test setup.** A complete two-page lease PDF is
      ~1.3 KB of hand-written PDF syntax; a DOCX is ~3.8 KB from a tiny zip writer. Committing real
      lease PDFs is the fastest way to blow the 10 MB repo limit — and would put real personal data
      in a public repo.
- [ ] Fixtures required: clean text PDF, two-column PDF, scanned PDF, encrypted PDF, DOCX with real
      heading styles, zip-bomb DOCX, XXE DOCX, billion-laughs DOCX, invisible-Unicode PDF.

## Design notes

- **Offsets are the product.** Everything downstream — highlights, citations, comparison anchors —
  is an offset into one canonical normalized string. Build that index here, once, and make it the
  single source of truth. If normalization changes later, offsets shift and every citation breaks,
  so `normalize.ts` must be pure, deterministic, and heavily tested.
- The parse boundary is also the trust boundary: bytes go in, a validated `NormalizedDocument` comes
  out, and **nothing downstream ever sees the raw file**.

## Acceptance criteria

- A clean lease PDF and DOCX both produce a `NormalizedDocument` whose `text.slice(charStart,
  charEnd)` exactly equals each item's `str` — asserted for every item.
- The zip-bomb fixture is rejected in **under 50 ms** with `ZIP_BOMB`, and peak RSS stays flat.
- The XXE and billion-laughs fixtures are rejected without any file read or network access.
- The 301-page fixture is rejected before any page is parsed.
- The scanned fixture returns `ScannedPdfError` naming the exact pages.
- A two-column fixture produces column-ordered text, not interleaved.
- The same buffer can be parsed twice without `DataCloneError` (proves the copy).
- `pnpm test` runs fully offline; no fixture binary is committed.
- Total added install stays under budget with `omit=optional`; `pnpm ls @napi-rs/canvas` is empty.

## Risks

- **`hasEOL` reliability on real-world PDFs is the biggest unknown.** It was perfect on a synthetic
  fixture that used one explicit `Td` per line — the easiest possible case — while pdf.js issues
  document erratic item splitting on real documents (words split mid-token, missing spaces).
  **Validate against 5–10 genuine lease PDFs from different producers (Word, LaTeX, DocuSign,
  scanner-with-OCR-layer) before trusting it.** Budget time for this.
- **Multi-column reflow quality is unmeasured.** The failure mode is documented; the effectiveness
  of the sort-and-cluster heuristic on a real two-column lease is not.
- **Next.js bundling of `pdfjs-dist`** is a classic breakage (dynamic worker resolution). `unpdf`
  is dependency-free and bundles cleanly, which is another reason it is the default; if pdfjs-dist
  is needed server-side, expect to add `serverExternalPackages`.
- **Encrypted/DocuSign PDFs** throw `PasswordException` — handle it as a typed, user-facing message
  rather than a stack trace.
