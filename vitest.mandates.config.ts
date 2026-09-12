import { defineConfig } from 'vitest/config';

/**
 * Mutation coverage for statically rendered mandate and command templates.
 * These modules build their strings at import time, so Stryker must execute
 * this focused contract suite for every mutant instead of attributing hits per test.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/templates/**/*.test.ts', 'src/cli/templates-hash.test.ts'],
    globals: false,
    restoreMocks: true,
    testTimeout: 60_000,
  },
});
