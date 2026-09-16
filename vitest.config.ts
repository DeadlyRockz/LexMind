import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately:
 *
 *  - `core` runs in Node with no DOM. Every legal rule, parser and verifier lives here, which is
 *    what makes the coverage gate below meaningful rather than theatre.
 *  - `web` runs in jsdom (NOT happy-dom — its `Node.prototype.isConnected` breaks axe).
 *
 * `test.projects` replaces the `workspace` field, deprecated since Vitest 3.2.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['packages/core/src/**/*.test.ts', 'test/**/*.test.ts'],
          setupFiles: ['./test/setup-core.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/**/*.test.tsx', 'apps/web/**/*.test.ts'],
          setupFiles: ['./apps/web/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportOnFailure: true,
      // Scoped to core on purpose: 90% on real legal logic is a signal, 90% chased across JSX is not.
      include: ['packages/core/src/**'],
      exclude: [
        'packages/core/src/**/*.test.ts',
        'packages/core/src/cli.ts',
        'packages/core/src/model/adapters/gemini.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
