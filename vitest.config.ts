import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__*',
        'src/test-policy.ts',
        'src/cli/run.ts',
      ],
      thresholds: {
        branches: 80,
        lines: 80,
        functions: 80,
        statements: 80,
        // TODO: architecture.ts (65%) continues to drag branches down
        // Working on adding integration tests
      },
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
