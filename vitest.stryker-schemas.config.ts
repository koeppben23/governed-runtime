import { defineConfig } from 'vitest/config';

/**
 * Stryker profile for module-init schema authorities.
 *
 * `flowguard-config.ts` and `state/schema.ts` build their Zod schemas at module
 * load, so the base profile's `perTest` attribution cannot assign their mutants
 * to tests. This profile uses `coverageAnalysis: "all"` and
 * `ignoreStatic: false` so Stryker executes the covering contract suites for
 * every mutant instead of attributing per test.
 *
 * Run locally with:
 *   node scripts/stryker-patch.js && npx stryker run stryker.schemas.conf.json
 *   node scripts/verify-mutation-admission.mjs --profile schemas
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/config/flowguard-config-schema.test.ts',
      'src/config/flowguard-config-io.test.ts',
      'src/state/state.test.ts',
    ],
    globals: false,
    restoreMocks: true,
    testTimeout: 60_000,
  },
});
