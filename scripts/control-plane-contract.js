/**
 * @module scripts/control-plane-contract
 * @description Machine-readable contract for the relied-upon GitHub control
 * plane. `scripts/control-plane-drift.js` compares the live repository
 * configuration against this contract and fails closed on divergence.
 *
 * `.github/BRANCH-PROTECTION.md` documents this contract for humans; the
 * documentation test in `scripts/__tests__/control-plane-contract.test.ts`
 * keeps the required status-check names aligned in both directions.
 *
 * @version v1
 */

/** Every required status-check context of the `Protect main and develop` ruleset. */
export const REQUIRED_STATUS_CHECKS = [
  'Validate Commit Messages',
  'ci-gate',
  'typecheck',
  'lint',
  'format',
  'architecture',
  'build',
  'build-clean',
  'actionlint',
  'secrets-scan',
  'security-policy',
  'audit',
  'codeql-sast',
  'install-verify (macos-latest)',
  'install-verify (ubuntu-latest)',
  'install-verify (windows-latest)',
  'independent-review-e2e',
];

/** The one branch ruleset that protects `main` and `develop`. */
export const BRANCH_RULESET_CONTRACT = {
  name: 'Protect main and develop',
  target: 'branch',
  enforcement: 'active',
  includedRefs: ['refs/heads/main', 'refs/heads/develop'],
  requiredRules: [
    'deletion',
    'non_fast_forward',
    'pull_request',
    'required_linear_history',
    'required_status_checks',
  ],
  requiredStatusChecks: REQUIRED_STATUS_CHECKS,
  strictRequiredStatusChecks: true,
  pullRequest: {
    requiredApprovingReviewCount: 0,
    dismissStaleReviewsOnPush: true,
    requireReviewThreadResolution: true,
    allowedMergeMethods: ['squash', 'rebase'],
  },
};

/**
 * Tag protection is split on purpose: the creation-authority ruleset carries
 * the release-actor bypass so `v*` tags can be created, while the immutability
 * ruleset has no normal bypass actor so an existing `v*` tag cannot be moved
 * or deleted. A single combine-all ruleset would let the creation bypass
 * weaken the immutability rules.
 */
export const TAG_RULESET_CONTRACTS = [
  {
    name: 'Release tag creation authority',
    target: 'tag',
    enforcement: 'active',
    requiredRules: ['creation'],
    expectsBypassActor: true,
  },
  {
    name: 'Release tag immutability',
    target: 'tag',
    enforcement: 'active',
    requiredRules: ['update', 'deletion', 'non_fast_forward'],
    expectsBypassActor: false,
  },
];

/** The protected publication environment and its anti-impulse delay. */
export const RELEASE_ENVIRONMENT_CONTRACT = {
  name: 'release',
  waitTimerMinutes: 15,
  deploymentTagPolicy: 'v*',
};

export const CONTROL_PLANE_CONTRACT = {
  branchRuleset: BRANCH_RULESET_CONTRACT,
  tagRulesets: TAG_RULESET_CONTRACTS,
  releaseEnvironment: RELEASE_ENVIRONMENT_CONTRACT,
};
