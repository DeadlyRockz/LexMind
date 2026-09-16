import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * ESLint runs here and nowhere else.
 *
 * The lint split is deliberate: **Biome** formats and lints the whole monorepo fast, and
 * **ESLint** is scoped to `apps/web` purely for the rules `eslint-config-next` owns and Biome
 * does not reimplement — `no-async-client-component`, `no-img-element`, `no-html-link-for-pages`
 * and the rest of the Core Web Vitals set. Running both everywhere would double the lint time to
 * re-report the same findings.
 *
 * This matters more in Next 16 than it used to: `next lint` was **removed**, and `next build` no
 * longer lints. If CI does not run ESLint, nothing does.
 */
export default defineConfig([
  globalIgnores(['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**']),
  nextCoreWebVitals,
  nextTypescript,
]);
