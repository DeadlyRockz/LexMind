/**
 * The public API of `@lexmind/core` — the whole legal engine, framework-free.
 *
 * This barrel is the contract between the engine and its two consumers: the `lexmind` CLI in
 * `./cli.ts` and the Next.js demo skin in `apps/web`. Both go through this file and neither
 * reaches into a subpath, which is what keeps the boundary in `plan/README.md` §6 enforceable:
 * nothing here imports `react`, `next`, or anything under `apps/`, so every rule in the product
 * is reachable headlessly and therefore testable without a browser.
 *
 * Each line below re-exports a module's own deliberate barrel rather than a hand-picked subset.
 * The submodules decide what is public; this file only decides that it *is* public — which is
 * why adding an export to a submodule is a deliberate act and never an accident of this file.
 *
 * The pipeline runs domain → ingest → segment → safety → model → analyse → qa; the lines below
 * are in the alphabetical order Biome enforces, not that order. Every exported name across those
 * modules is verified distinct, so `export *` here is unambiguous rather than a silent-shadowing
 * hazard: with a collision, TypeScript would drop *both* names without an error.
 */

/** The analysis pipeline: rules first, model second, TypeScript concluding. */
export * from './analyse/index.ts';
/** The taxonomy, the jurisdiction rules and the citation table — data, with sources. */
export * from './domain/index.ts';
/** Untrusted bytes in, an offset-anchored `NormalizedDocument` out. The trust boundary. */
export * from './ingest/index.ts';
/** The `LlmPort` abstraction, the budget meter, and adapter selection from the environment. */
export * from './model/index.ts';
/** Citation verification — the check that decides whether a claim is shown at all. */
export * from './qa/verify.ts';
/** Redaction, the document channel, and the no-advice boundary. The only path to the model. */
export * from './safety/index.ts';
/** Deterministic clause boundaries, the outline, and the lexical retrieval index. */
export * from './segment/index.ts';

/** Hashing, text normalisation and readability, shared by every layer above. */
export * from './util/index.ts';
