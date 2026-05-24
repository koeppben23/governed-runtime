import { defineConfig } from 'vitest/config';

/**
 * Root vitest config with native project separation for unit, integration, and smoke tests.
 *
 * - `unit`: Fast, no-build-required tests covering config, audit, rails, machine, etc.
 * - `integration`: Slower tests exercising cross-module flows (review enforcement, tools, plugin).
 * - `smoke`: Build-dependent tests requiring `npm run build` first (opt-in, not in default `npm test`).
 *
 * Usage:
 *   npm test                    → unit + integration (default, fast CI feedback)
 *   npm run test:unit           → unit only (~15s)
 *   npm run test:integration    → integration only (~30s)
 *   npm run test:smoke          → smoke only (requires build)
 *
 * Stryker uses its own config: vitest.stryker.config.ts (not affected).
 *
 * @see https://vitest.dev/guide/projects
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__*',
        'src/test-policy.ts',
      ],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [
            'src/integration/**/*.test.ts',
            'src/mcp-server/mcp-protocol.test.ts',
            'src/cli/install-verify.test.ts',
            'src/cli/cli-contract-smoke.test.ts',
            'src/cli/run-acp-smoke.test.ts',
          ],
          globals: false,
          restoreMocks: true,
          testTimeout: 15_000,
          coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
              'src/**/*.test.ts',
              'src/**/__tests__/**',
              'src/**/__fixtures__*',
              'src/test-policy.ts',
              'src/integration/**/*.ts',
            ],
            thresholds: {
              branches: 80,
              lines: 80,
              functions: 80,
              statements: 80,
            },
            reporter: ['text', 'json-summary', 'html'],
            reportsDirectory: 'coverage/unit',
          },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/integration/**/*.test.ts'],
          globals: false,
          restoreMocks: true,
          testTimeout: 60_000,
          coverage: {
            provider: 'v8',
            include: ['src/integration/**/*.ts'],
            exclude: [
              'src/integration/**/*.test.ts',
              'src/integration/test-helpers.ts',
              'src/integration/*-test-helpers.ts',
              'src/integration/*-helpers.ts',
            ],
            thresholds: {
              branches: 70,
              lines: 70,
              functions: 70,
              statements: 70,
            },
            reporter: ['text', 'json-summary', 'html'],
            reportsDirectory: 'coverage/integration',
          },
        },
      },
      {
        test: {
          name: 'smoke',
          include: [
            'src/cli/install-verify.test.ts',
            'src/cli/cli-contract-smoke.test.ts',
            'src/cli/run-acp-smoke.test.ts',
            'src/cli/inspect-command.test.ts',
            'src/mcp-server/mcp-protocol.test.ts',
          ],
          globals: false,
          restoreMocks: true,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
