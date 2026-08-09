import { defineConfig } from 'vitest/config';

/**
 * Stryker-specific vitest config for the targeted Human Projection mutation run.
 * Exercises the projection authority (reason-copy, reason-projection,
 * human-projection, markdown renderer) plus the surfaces that consume it.
 * TEMPORARY — used only for the PR #790 targeted mutation verification.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/presentation/**/*.test.ts',
      'src/integration/status-presentation.test.ts',
      'src/integration/why-presentation.test.ts',
      'src/integration/finish-presentation.test.ts',
      'src/integration/tools/helpers.test.ts',
      'src/integration/plugin-helpers.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
