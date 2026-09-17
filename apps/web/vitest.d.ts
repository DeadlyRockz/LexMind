/**
 * `@types/jest-axe` augments `jest` / `@jest/expect` only, so `toHaveNoViolations` reads as
 * TS2339 under Vitest without this. Hand-written rather than imported because jest-axe exports no
 * standalone matcher-interface type to extend.
 *
 * The `export {}` is load-bearing: with `moduleDetection: "force"` a file with no top-level
 * import/export is still a script, and `declare module 'vitest'` in a script file replaces the
 * real module instead of augmenting it — every other export (`describe`, `it`, `expect`, ...)
 * disappears along with it. The empty export makes this file itself a module, which is what
 * turns the block below into a proper augmentation of the real `vitest` types.
 */
export {};

declare module 'vitest' {
  interface Matchers<R = void | Promise<void>, T = unknown> {
    toHaveNoViolations(): R;
  }
}
