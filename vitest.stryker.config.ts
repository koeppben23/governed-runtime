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
      'src/integration/review/orchestrator.test.ts',
      'src/integration/review/orchestrator-invoke.test.ts',
      'src/integration/review/orchestrator-retry.test.ts',
      'src/integration/review/enforcement/enforcement.test.ts',
      'src/integration/review/enforcement/mutation.test.ts',
      'src/integration/review/enforcement/extraction.test.ts',
      'src/integration/review/enforcement/session.test.ts',

      'src/hooks/**/*.test.ts',
      'src/mcp-server/**/*.test.ts',
      'src/templates/**/*.test.ts',
      'src/integration/plugin-audit.test.ts',
      'src/integration/plugin-compaction.test.ts',
      'src/integration/plugin-enforcement-tracking.test.ts',
      'src/integration/plugin-events.test.ts',
      'src/integration/plugin-helpers.test.ts',
      'src/integration/plugin-host-task-diagnostics-helpers.test.ts',
      'src/integration/plugin-logging.test.ts',
      'src/integration/plugin-orchestrator-arch-ssot.test.ts',
      'src/integration/plugin-orchestrator-bug16.test.ts',
      'src/integration/plugin-orchestrator-exhaustion.test.ts',
      'src/integration/plugin-orchestrator-independent-review.test.ts',
      'src/integration/plugin-orchestrator-plan-ssot.test.ts',
      'src/integration/plugin-orchestrator-review-content.test.ts',
      'src/integration/plugin-orchestrator-unable.test.ts',
      'src/integration/plugin-policy.test.ts',
      'src/integration/plugin-risk.test.ts',
      'src/integration/plugin-task-evidence.test.ts',
      'src/integration/plugin-workspace.test.ts',
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
