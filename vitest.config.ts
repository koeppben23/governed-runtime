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
        // Test infrastructure (helpers/fixtures), not product code.
        'src/integration/test-helpers.ts',
        'src/integration/*-test-helpers.ts',
        'src/integration/*-helpers.ts',
      ],
      thresholds: {
        branches: 80,
        lines: 80,
        functions: 80,
        statements: 80,
      },
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.ts'],
          exclude: [
            'src/integration/**/*.test.ts',
            'src/**/*.fuzz.test.ts',
            'src/mcp-server/mcp-protocol.test.ts',
            'src/cli/install-verify.test.ts',
            'src/cli/claude-plugin-load.test.ts',
            'src/cli/cli-contract-smoke.test.ts',
            'src/cli/doctor-cli-smoke.test.ts',
            'src/cli/run-acp-smoke.test.ts',
            'src/cli/inspect-command.test.ts',
            'src/cli/opencode-reviewer-capability.test.ts',
            'src/hooks/command-hooks-smoke.test.ts',
          ],
          globals: false,
          restoreMocks: true,
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'integration',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/integration/**/*.test.ts'],
          globals: false,
          restoreMocks: true,
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'smoke',
          setupFiles: ['./vitest.setup.ts'],
          include: [
            'src/cli/install-verify.test.ts',
            'src/cli/claude-plugin-load.test.ts',
            'src/cli/cli-contract-smoke.test.ts',
            'src/cli/doctor-cli-smoke.test.ts',
            'src/cli/run-acp-smoke.test.ts',
            'src/cli/inspect-command.test.ts',
            'src/mcp-server/mcp-protocol.test.ts',
            'src/hooks/command-hooks-smoke.test.ts',
          ],
          globals: false,
          restoreMocks: true,
          testTimeout: 540_000,
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
          globals: false,
          restoreMocks: true,
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'evals',
          include: ['evals/**/*.test.ts'],
          globals: false,
          restoreMocks: true,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'fuzz',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.fuzz.test.ts'],
          globals: false,
          restoreMocks: true,
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'conformance',
          setupFiles: ['./vitest.setup.ts'],
          include: ['test/conformance/assertions/**/*.test.ts'],
          exclude: [
            'test/conformance/assertions/projects/**',
            'test/conformance/assertions/fixtures/**',
          ],
          globals: false,
          restoreMocks: true,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
