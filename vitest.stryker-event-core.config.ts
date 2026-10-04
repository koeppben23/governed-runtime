import { defineConfig } from 'vitest/config';

/**
 * Stryker profile for the audit event-core authority.
 *
 * `event-core.ts` builds its event-kind authority at module load and defines
 * the chain-hash/finalization contracts. The base profile's `perTest`
 * attribution cannot assign those module-init mutants to tests, so this
 * profile uses `coverageAnalysis: "all"` and `ignoreStatic: false` and keeps
 * `StringLiteral` enabled (the base profile excludes it) to mutate the
 * audit-format, event-name and genesis constants that encode the authority.
 *
 * Run locally with:
 *   node scripts/stryker-patch.js && npx stryker run stryker.event-core.conf.json
 *   node scripts/verify-mutation-admission.mjs --profile event-core
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/audit/audit-integrity.test.ts',
      'src/audit/audit-integrity-timestamps.test.ts',
      'src/audit/audit-types.test.ts',
      'src/audit/canonical-digest.test.ts',
      'src/adapters/workspace/archive-verify-chain.test.ts',
    ],
    globals: false,
    restoreMocks: true,
    testTimeout: 60_000,
  },
});
