import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterEach, expect } from 'vitest';

expect.extend(toHaveNoViolations);

// `@testing-library/react`'s auto-cleanup only registers itself when it detects a global
// `afterEach` (the Jest convention). `test.globals` is off here on purpose, so it is wired
// explicitly — without it, every render after the first leaks into the next test's `document.body`.
afterEach(() => {
  cleanup();
});
