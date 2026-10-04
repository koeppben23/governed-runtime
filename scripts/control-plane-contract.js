/**
 * @module scripts/control-plane-contract
 * @description Machine-readable contract for the relied-upon GitHub control
 * plane. `scripts/control-plane-drift.js` compares the live repository
 * configuration against this contract and fails closed on divergence.
 *
 * `.github/BRANCH-PROTECTION.md` documents this contract for humans; the
 * documentation test in `scripts/__tests__/control-plane-workflow-contract.test.ts`
 * keeps the required status-check names aligned in both directions.
 *
 * Bypass actors are pinned exactly. Trusted verification modes (scheduled drift
 * and the release POST-TAG preflight) fail when the API hides `bypass_actors`
 * for the caller; only the pull-request drift run may fall back to
 * `PARTIAL_VERIFICATION`.
 *
 * @version v2
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

/** GitHub Actions app integration id; required checks must be bound to it. */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/** The one branch ruleset that protects `main` and `develop`. */
export const BRANCH_RULESET_CONTRACT = {
  name: 'Protect main and develop',
  target: 'branch',
  enforcement: 'active',
  refs: {
    // `~ALL` is acceptable, but neither protected ref may be excluded.
    mode: 'includes',
    includedRefs: ['refs/heads/main', 'refs/heads/develop'],
    excludedRefs: [],
  },
  requiredRules: [
    'deletion',
    'non_fast_forward',
    'pull_request',
    'required_linear_history',
    'required_status_checks',
  ],
  requiredStatusChecks: REQUIRED_STATUS_CHECKS,
  requiredStatusChecksIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
  strictRequiredStatusChecks: true,
  pullRequest: {
    requiredApprovingReviewCount: 0,
    dismissStaleReviewsOnPush: true,
    requireReviewThreadResolution: true,
    allowedMergeMethods: ['squash', 'rebase'],
  },
  bypassActors: [],
};

/**
 * Tag protection is split on purpose: the creation-authority ruleset carries
 * the exact release-actor bypass so `v*` tags can be created, while the
 * immutability ruleset has no bypass actor so an existing `v*` tag cannot be
 * moved or deleted. A single combine-all ruleset would let the creation bypass
 * weaken the immutability rules.
 */
export const TAG_RULESET_CONTRACTS = [
  {
    name: 'Release tag creation authority',
    target: 'tag',
    enforcement: 'active',
    refs: {
      mode: 'exact',
      includedRefs: ['refs/tags/v*'],
      excludedRefs: [],
    },
    requiredRules: ['creation'],
    bypassActors: [{ actorType: 'User', actorId: 57482452, bypassMode: 'always' }],
  },
  {
    name: 'Release tag immutability',
    target: 'tag',
    enforcement: 'active',
    refs: {
      mode: 'exact',
      includedRefs: ['refs/tags/v*'],
      excludedRefs: [],
    },
    requiredRules: ['update', 'deletion', 'non_fast_forward'],
    bypassActors: [],
  },
];

/** The protected publication environment and its anti-impulse delay. */
export const RELEASE_ENVIRONMENT_CONTRACT = {
  name: 'release',
  waitTimerMinutes: 15,
  deploymentTagPolicy: 'v*',
  customBranchPolicies: true,
  protectedBranches: false,
};

/** Repository Actions policy that the release supply chain relies on. */
export const ACTIONS_POLICY_CONTRACT = {
  enabled: true,
  allowedActions: 'all',
  shaPinningRequired: true,
};

export const CONTROL_PLANE_CONTRACT = {
  branchRuleset: BRANCH_RULESET_CONTRACT,
  tagRulesets: TAG_RULESET_CONTRACTS,
  releaseEnvironment: RELEASE_ENVIRONMENT_CONTRACT,
  actionsPolicy: ACTIONS_POLICY_CONTRACT,
};
