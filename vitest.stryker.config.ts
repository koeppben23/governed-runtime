import { defineConfig } from 'vitest/config';

/**
 * Stryker-specific vitest config.
 * Keeps mutation testing explainable by running direct tests for configured
 * mutation targets plus target-adjacent governance/policy/rail E2Es.
 */
export default defineConfig({
  test: {
    include: [
      // Direct tests for configured mutation targets.
      'src/machine/**/*.test.ts',
      'src/rails/**/*.test.ts',
      'src/audit/**/*.test.ts',
      'src/config/**/*.test.ts',
      'src/identity/**/*.test.ts',

      // Target-adjacent integration tests that exercise policy/rail/audit paths.
      'src/integration/e2e-workflow.test.ts',
      'src/integration/regulated-e2e.test.ts',
      'src/integration/policy-matrix.test.ts',
      'src/integration/policy-snapshot-regression.test.ts',
      'src/integration/identity-policy-e2e.test.ts',
      'src/integration/audit-archive-integrity.test.ts',
      'src/integration/audit-archive-tamper-matrix.test.ts',
      'src/integration/command-aliases.test.ts',
      'src/integration/product-command-routing.test.ts',
      'src/integration/review-assurance.test.ts',
      'src/integration/review-enforcement.test.ts',
      'src/integration/review-orchestrator.test.ts',
      'src/integration/status.test.ts',
      'src/integration/services/decision-finalization.test.ts',
      'src/integration/services/regulated-completion.test.ts',
      'src/integration/session-state-upgrade.test.ts',
      'src/integration/stack-evidence-e2e.test.ts',
      'src/integration/tool-classification.test.ts',
      'src/integration/plugin-policy.test.ts',
      'src/integration/tools-execute-*.test.ts',
      'src/integration/tools.test.ts',
      'src/integration/tools/plan.test.ts',
      'src/integration/tools/architecture-tool.test.ts',
      'src/integration/tools/review-validation.test.ts',

      // State and artifact persistence tests that support hydrate/audit evidence paths.
      'src/adapters/adapters.test.ts',
      'src/state/state.test.ts',
      'src/adapters/workspace.test.ts',
      'src/adapters/workspace/evidence-artifacts.test.ts',
    ],
    exclude: [
      // CI/security meta-policy, not current mutation targets.
      'src/security/actions-pinning.test.ts',
      // Architecture dependency policy, not current mutation targets.
      'src/architecture/__tests__/dependency-rules.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
