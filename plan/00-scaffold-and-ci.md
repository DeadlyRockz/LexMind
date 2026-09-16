# Phase 00 — Scaffold, Toolchain & CI

**Goal:** a runnable, typechecked, linted, tested, CI-green repo skeleton with zero business logic in
it — so every later phase lands inside a harness that already proves itself on every commit.

**Depends on:** nothing.
**Blocks:** everything.

**Judged axes earned here:** Code Quality (structure), Testing (harness + coverage gate),
Security (secret hygiene, dependency policy).

---

## Deliverables

```
package.json                      workspace root, private, type: module
pnpm-workspace.yaml               packages/* + apps/* + pnpm settings (NOT .npmrc — see notes)
tsconfig.base.json                strict compiler options, extended by every package
vitest.config.ts                  test.projects: "core" (node) + "web" (jsdom) + coverage gate
biome.json                        format + fast lint across the monorepo
.gitignore                        node_modules, .next, .env*, coverage, fixtures cache
.gitattributes                    LF normalisation
.env.example                      documents every var; contains NO real values
.github/
  workflows/ci.yml                typecheck -> lint -> test+coverage -> build
  workflows/gitleaks.yml          secret scan on every push/PR
  dependabot.yml                  weekly npm + github-actions updates
packages/core/
  package.json                    name @lexmind/core, exports ./src/index.ts
  tsconfig.json                   extends base, types: ["node"]
  src/index.ts                    public API barrel (empty for now)
  src/cli.ts                      `lexmind` CLI — arg parsing only, exits 0
  src/version.test.ts             one real test so the harness is proven green
apps/web/
  package.json                    name @lexmind/web, depends on @lexmind/core: workspace:*
  tsconfig.json                   extends base, jsx: preserve
  next.config.ts                  security headers
  eslint.config.mjs               eslint-config-next flat config
  app/layout.tsx                  root layout, lang="en", skip link
  app/page.tsx                    placeholder
```

## Tasks

- [ ] `pnpm init` at root. Set `"private": true`, `"type": "module"`,
      `"packageManager": "pnpm@10.34.5"`, `"engines": { "node": ">=24" }`.
- [ ] **`pnpm-workspace.yaml`** with `packages: ['apps/*', 'packages/*']`.
      **pnpm 10+ reads only auth/registry settings from `.npmrc`** — every other setting
      (`nodeLinker`, `hoistPattern`, …) must live in `pnpm-workspace.yaml`. Do not copy the
      old `.npmrc` `node-linker=hoisted` line from the previous hackathon repo; it is inert now.
- [ ] `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
      `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `moduleResolution: "Bundler"`,
      `target: "ES2023"`, `noEmit`. Every package extends it.
- [ ] **Pin `typescript@^5.9`.** Next 16.3 supports TS 7 for `next build`, but the
      `typescript-eslint` stack is not confirmed TS-7-ready. A graded deliverable does not
      experiment with its own compiler.
- [ ] `packages/core` — framework-free. **Hard rule, enforced in Phase 11 by a test:** no import of
      `react`, `next`, or anything under `apps/` may ever appear in `packages/core/src/**`.
- [ ] `packages/core/src/cli.ts` — `node:util` `parseArgs` only. Subcommands registered but all
      print "not implemented" and exit 0. The CLI exists from day one because **the CLI is the
      product and the web app is the demo skin**; anything the UI can do must be reproducible
      headlessly, which is what makes the whole thing gradeable without a browser.
- [ ] `apps/web` — Next.js App Router, TypeScript.
      **Do NOT add `transpilePackages`** for `@lexmind/core`: Turbopack (the default bundler in
      Next 16) auto-transpiles pnpm workspace packages. Adding it is noise a reviewer will notice.
- [ ] `vitest.config.ts` at root using **`test.projects`** — `workspace` / `vitest.workspace.ts`
      has been deprecated since Vitest 3.2. Two projects: `core` (`environment: 'node'`,
      `extends: false`) and `web` (`environment: 'jsdom'`, React plugin).
- [ ] Coverage via `@vitest/coverage-v8`, **version pinned in lockstep with `vitest`**.
      Gate: `thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 }` scoped to
      `packages/core/src/**`. Set `reportOnFailure: true` so CI still emits a report when red.
- [ ] Lint split — deliberate, document it in the README:
      **Biome** (`biome.json`, `biome ci`) for formatting + fast baseline lint monorepo-wide;
      **ESLint flat config** (`eslint.config.mjs`, `eslint-config-next/core-web-vitals` +
      `eslint-config-next/typescript`) scoped to `apps/web` for the Next-specific rules
      (`no-async-client-component`, `no-img-element`, …) that Biome does not reimplement.
      Note `next lint` was **removed** in Next 16 and `next build` no longer lints — CI must.
- [ ] `.github/workflows/ci.yml`. Ordering is load-bearing: **`pnpm/action-setup` must run before
      `actions/setup-node`**, because setup-node requires the package manager to be pre-installed.
      Use `pnpm/action-setup@v6` with `cache: true` **or** setup-node's `cache: 'pnpm'` — never both.
      Steps: `pnpm install --frozen-lockfile` → typecheck → lint → `vitest run --coverage` → build.
      Add `permissions: contents: read`, `concurrency` with `cancel-in-progress`, `timeout-minutes`.
- [ ] `.github/workflows/gitleaks.yml` — secret scanning on push and PR.
- [ ] `.github/dependabot.yml` — weekly `npm` and `github-actions` ecosystems.
- [ ] `.env.example` listing `GEMINI_API_KEY=` and `LEXMIND_OFFLINE=1` with comments, no values.
      `.gitignore` must cover `.env`, `.env.local`, `.env.*.local` before the first commit.
- [ ] `git init` (repo is not yet a git repo), **single branch `main`**, first commit.
- [ ] Add a repo-size guard script (`scripts/check-size.sh`) asserting the packed repo is
      **under 10 MB** — a hard submission rule, so make it a check rather than a hope.

## Design notes

- **Why the core/web split is non-negotiable:** the Next.js testing docs state plainly that Vitest
  does not support `async` Server Components and recommend E2E for them. If the legal logic lived in
  route handlers or RSCs, it would be effectively untestable in unit tests, and the Testing axis
  would collapse to a handful of Playwright specs. Putting every rule in a node-environment library
  is what makes 90% coverage both achievable and meaningful.
- **`server-only` goes in the web adapter, not in core.** `import 'server-only'` is a
  bundler-resolution trick Next understands; putting it inside `packages/core` would break the
  plain-Node CLI that imports the same module. The guard belongs in the thin `apps/web` wrapper.
- **CSP decision is deferred to Phase 10**, but flag it now: nonce-based CSP forces every page to
  render dynamically and is **incompatible with PPR**. Static headers in `next.config.ts` is the
  pragmatic choice; revisit only if a strict CSP is worth losing static rendering.
- Repo size: never commit `node_modules`, build output, real lease PDFs, or a slide deck rendered
  at print resolution. The previous hackathon repo carried a multi-MB PDF in `submission/`; here the
  deck, if any, stays under 2 MB or lives outside the repo.

## Acceptance criteria

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  all exit 0 on a clean clone with **no network access and no API key set**.
- `pnpm vitest run --coverage` reports ≥ 1 passing test and prints a coverage table.
- CI is green on the first push, and the badge is in the README.
- `git count-objects -vH` / `scripts/check-size.sh` reports well under 10 MB.
- `grep -rE "^import .*(react|next)" packages/core/src` returns nothing.
- No `.env` file is tracked: `git ls-files | grep -E '^\.env$'` is empty.

## Risks

- **Over-scaffolding.** Timebox to a few hours. A half-built monorepo that does nothing is worse
  than a single package that runs. If the workspace fights back, collapse `apps/web` into the root
  and keep `packages/core` — the core/web boundary matters, the folder count does not.
- **Coverage gate set too high too early** will block Phase 01–02 commits. Start the threshold at
  the numbers above but scoped **only** to `packages/core/src`, and never to UI code.
- **Turbopack + workspace package resolution** occasionally needs a `pnpm install` rerun after
  adding a new workspace dep. Known friction, not a blocker.
