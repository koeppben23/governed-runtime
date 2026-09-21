import { defineConfig } from 'vitest/config';

/**
 * Stryker profile for the formal state transition authority.
 *
 * `topology.ts` is module-init data: the transition table, terminal/user-gate
 * classification sets, and flow progressions are built at load time. The base
 * profile's `ignoreStatic: true` plus its `StringLiteral` exclusion produced
 * zero valid mutants, so the target was classified not-mutation-suitable for
 * base only. This focused profile uses `coverageAnalysis: "all"` and
 * `ignoreStatic: false`, keeps `StringLiteral` enabled, and disables the
 * TypeScript checker (`checkers: []`) because the table literals are
 * deliberately typed data — mutating them is the point, and the selected
 * suites assert the exact table semantics.
 *
 * Run locally with:
 *   node scripts/stryker-patch.js && npx stryker run stryker.topology.conf.json
 *   node scripts/verify-mutation-admission.mjs --profile topology
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/machine/topology.test.ts',
      'src/machine/state-machine.fuzz.test.ts',
      'src/machine/state-machine-invariants.test.ts',
      'src/architecture/__tests__/topology-authority-ssot.test.ts',
    ],
    globals: false,
    restoreMocks: true,
    testTimeout: 60_000,
  },
});
