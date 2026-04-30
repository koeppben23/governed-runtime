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
      // Integration tests — EPERM on Windows atomic writes under pool:'forks'
      // and unrelated to mutation target unit coverage
      'src/integration/**',
      // Performance timing tests — flaky under load
      'src/architecture/__tests__/dependency-rules.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
