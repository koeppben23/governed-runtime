import { defineConfig } from 'vitest/config';

/**
 * Stryker-specific vitest config.
 * Excludes flaky/failing tests that are unrelated to mutation targets
 * to prevent dry-run aborts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      // Unrelated to mutation targets — causes dry-run aborts
      'src/security/actions-pinning.test.ts',
      // Performance timing tests — flaky under load
      'src/architecture/__tests__/dependency-rules.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
