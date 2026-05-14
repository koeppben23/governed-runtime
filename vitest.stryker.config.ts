import { defineConfig } from 'vitest/config';

/**
 * Stryker-specific vitest config.
 * 17 governance-core files with proven >70% individual mutation scores.
 * FlowGuard decision chain: state, audit, config, identity, machine, rails, tools.
 */
export default defineConfig({
  test: {
    include: [
      'src/adapters/**/*.test.ts',
      'src/audit/**/*.test.ts',
      'src/config/**/*.test.ts',
      'src/identity/**/*.test.ts',
      'src/machine/**/*.test.ts',
      'src/rails/**/*.test.ts',
      'src/integration/command-aliases.test.ts',
      'src/integration/status.test.ts',
      'src/integration/tool-classification.test.ts',
    ],
    exclude: [
      'src/security/actions-pinning.test.ts',
      'src/architecture/__tests__/dependency-rules.test.ts',
      'src/__fixtures__.ts',
      'src/integration/test-helpers.ts',
      'src/audit/audit-test-helpers.ts',
      'src/test-policy.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
