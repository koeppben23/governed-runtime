import { defineConfig } from 'vitest/config';

/**
 * Stryker-specific vitest config for the targeted Human Projection mutation run.
 * Exercises the projection authority (reason-copy, reason-projection,
 * human-projection, markdown renderer) plus the surfaces that consume it.
 *
 * This is a reusable targeted mutation profile. Run it locally with
 * `node scripts/stryker-patch.js && npx stryker run stryker.human-projection.conf.json`
 * followed by `node scripts/verify-mutation-admission.mjs --profile human-projection`.
 * It has no dedicated CI workflow yet; `.github/workflows/mutation.yml` covers
 * the base profile only. Adding a PR workflow requires a full-profile run that
 * proves every target meets the per-target threshold first.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/presentation/**/*.test.ts',
      'src/integration/status-presentation.test.ts',
      'src/integration/why-presentation.test.ts',
      'src/integration/finish-presentation.test.ts',
      'src/integration/tools/helpers.test.ts',
      'src/integration/plugin-helpers.test.ts',
      'src/integration/proofgraph/proof-summary-projectors.test.ts',
      'src/architecture/__tests__/claim-resolution-ssot.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
