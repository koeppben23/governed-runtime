/** Focused mutation test selection for native installer ownership and tuning.
 * Full regression runs separately; thresholds/mutators remain in stryker.conf.json. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    include: [
      'src/cli/install-install.test.ts',
      'src/cli/install-parseargs.test.ts',
      'src/cli/install-uninstall.test.ts',
      'src/cli/install-helpers-core.test.ts',
      'src/cli/install-helpers-reviewer-agent.test.ts',
      'src/cli/install-ownership-regression.test.ts',
      'src/cli/install-ownership-rollback.test.ts',
      'src/cli/install-mandate-ownership.test.ts',
      'src/cli/install-steps.test.ts',
      'src/cli/install-transaction.test.ts',
      'src/cli/opencode-runtime-gate-install.test.ts',
      'src/cli/uninstall-ownership-failclosed.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
