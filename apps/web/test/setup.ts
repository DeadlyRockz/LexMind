import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterEach, expect } from 'vitest';

expect.extend(toHaveNoViolations);

// Mirrors `test/setup-core.ts`: a web test that reaches `route.ts`'s `analyse()` call must run
// the same offline, deterministic path core's suite does, never a live call to a real provider,
// regardless of what happens to be exported in the shell this process inherited from.
process.env['LEXMIND_OFFLINE'] = '1';
delete process.env['GEMINI_API_KEY'];

// `@testing-library/react`'s auto-cleanup only registers itself when it detects a global
// `afterEach` (the Jest convention). `test.globals` is off here on purpose, so it is wired
// explicitly — without it, every render after the first leaks into the next test's `document.body`.
afterEach(() => {
  cleanup();
});
