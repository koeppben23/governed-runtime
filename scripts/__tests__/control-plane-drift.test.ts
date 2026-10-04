/**
 * @module scripts/__tests__/control-plane-drift
 * @description Pure comparison tests for live control-plane drift detection,
 * including the strict/partial verification modes.
 */

import { describe, expect, it } from 'vitest';

import { evaluateControlPlane } from '../control-plane-drift.js';
import {
  ACTIONS_POLICY_CONTRACT,
  CONTROL_PLANE_CONTRACT,
  GITHUB_ACTIONS_INTEGRATION_ID,
  REQUIRED_STATUS_CHECKS,
  TAG_RULESET_CONTRACTS,
} from '../control-plane-contract.js';

function branchRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Protect main and develop',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: ['refs/heads/main', 'refs/heads/develop'], exclude: [] },
    },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash', 'rebase'],
        },
      },
      { type: 'required_linear_history' },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: REQUIRED_STATUS_CHECKS.map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
          })),
        },
      },
    ],
    ...overrides,
  };
}

function creationRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Release tag creation authority',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [{ actor_id: 57482452, actor_type: 'User', bypass_mode: 'always' }],
    rules: [{ type: 'creation' }],
    ...overrides,
  };
}

function immutabilityRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Release tag immutability',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    ...overrides,
  };
}

function releaseEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    name: 'release',
    protection_rules: [{ type: 'wait_timer', wait_timer: 15 }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    ...overrides,
  };
}

function live(overrides: Record<string, unknown> = {}) {
  return {
    rulesets: [branchRuleset(), creationRuleset(), immutabilityRuleset()],
    environments: [releaseEnvironment()],
    releaseEnvironmentPolicies: [{ name: 'v*', type: 'tag' }],
    actionsPermissions: { enabled: true, allowed_actions: 'all', sha_pinning_required: true },
    ...overrides,
  };
}

function evaluate(overrides: Record<string, unknown> = {}, mode: 'strict' | 'partial' = 'strict') {
  return evaluateControlPlane(live(overrides), CONTROL_PLANE_CONTRACT, { mode });
}

describe('scripts/control-plane-drift', () => {
  it('accepts a live configuration that matches the contract in strict mode', () => {
    const result = evaluate();
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unverified).toEqual([]);
  });

  it('fails when the branch ruleset is missing', () => {
    const result = evaluate({ rulesets: [creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain("missing branch ruleset 'Protect main and develop'");
  });

  it('fails when a required branch rule is missing', () => {
    const reduced = branchRuleset({
      rules: branchRuleset().rules.filter((rule) => rule.type !== 'required_linear_history'),
    });
    const result = evaluate({ rulesets: [reduced, creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain(
      "ruleset 'Protect main and develop' is missing rule 'required_linear_history'",
    );
  });

  it('fails when required status checks diverge in either direction', () => {
    const parameters = {
      strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_STATUS_CHECKS.filter((name) => name !== 'ci-gate').map(
        (context) => ({ context, integration_id: GITHUB_ACTIONS_INTEGRATION_ID }),
      ),
    };
    const reduced = branchRuleset({
      rules: [
        ...branchRuleset().rules.filter((rule) => rule.type !== 'required_status_checks'),
        { type: 'required_status_checks', parameters },
      ],
    });
    const result = evaluate({ rulesets: [reduced, creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain('required checks missing: ci-gate');
  });

  it('fails when a required check is not bound to the GitHub Actions app', () => {
    const parameters = {
      strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_STATUS_CHECKS.map((context) => ({ context })),
    };
    const unbound = branchRuleset({
      rules: [
        ...branchRuleset().rules.filter((rule) => rule.type !== 'required_status_checks'),
        { type: 'required_status_checks', parameters },
      ],
    });
    const result = evaluate({ rulesets: [unbound, creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain(
      `required check 'Validate Commit Messages' is bound to app none, expected ${GITHUB_ACTIONS_INTEGRATION_ID}`,
    );
  });

  it('fails when the branch ruleset stops enforcing freshness', () => {
    const parameters = {
      strict_required_status_checks_policy: false,
      required_status_checks: REQUIRED_STATUS_CHECKS.map((context) => ({
        context,
        integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
      })),
    };
    const relaxed = branchRuleset({
      rules: [
        ...branchRuleset().rules.filter((rule) => rule.type !== 'required_status_checks'),
        { type: 'required_status_checks', parameters },
      ],
    });
    const result = evaluate({ rulesets: [relaxed, creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain(
      "ruleset 'Protect main and develop' strict_required_status_checks_policy is false, expected true",
    );
  });

  it('fails when a protected ref is excluded even under a ~ALL include', () => {
    const widened = branchRuleset({
      conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } },
    });
    const result = evaluate({ rulesets: [widened, creationRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain(
      "ruleset 'Protect main and develop' excludes protected ref refs/heads/main",
    );
  });

  it('fails when a tag ruleset is missing', () => {
    const result = evaluate({ rulesets: [branchRuleset(), immutabilityRuleset()] });
    expect(result.failures).toContain("missing tag ruleset 'Release tag creation authority'");
  });

  it('fails when the immutability ruleset loses a rule', () => {
    const reduced = immutabilityRuleset({ rules: [{ type: 'deletion' }] });
    const result = evaluate({ rulesets: [branchRuleset(), creationRuleset(), reduced] });
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' is missing rule 'update'",
    );
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' is missing rule 'non_fast_forward'",
    );
  });

  it('pins the exact tag ref target for both rulesets', () => {
    const drifted = creationRuleset({
      conditions: { ref_name: { include: ['refs/tags/test*'], exclude: [] } },
    });
    const result = evaluate({ rulesets: [branchRuleset(), drifted, immutabilityRuleset()] });
    expect(result.failures).toContain(
      "ruleset 'Release tag creation authority' includes [refs/tags/test*], expected exactly [refs/tags/v*]",
    );
  });

  it('pins empty tag excludes', () => {
    const drifted = immutabilityRuleset({
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v0*'] } },
    });
    const result = evaluate({ rulesets: [branchRuleset(), creationRuleset(), drifted] });
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' excludes [refs/tags/v0*], expected exactly []",
    );
  });

  it('pins the exact release actor and bypass mode', () => {
    const wrongActor = creationRuleset({
      bypass_actors: [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }],
    });
    const result = evaluate({ rulesets: [branchRuleset(), wrongActor, immutabilityRuleset()] });
    expect(result.failures).toContain(
      "ruleset 'Release tag creation authority' bypass actors are [User:1:always], expected [User:57482452:always]",
    );

    const wrongMode = creationRuleset({
      bypass_actors: [{ actor_id: 57482452, actor_type: 'User', bypass_mode: 'pull_request' }],
    });
    const modeResult = evaluate({ rulesets: [branchRuleset(), wrongMode, immutabilityRuleset()] });
    expect(modeResult.failures).toContain(
      "ruleset 'Release tag creation authority' bypass actors are [User:57482452:pull_request], expected [User:57482452:always]",
    );
  });

  it('fails when the immutability ruleset gains a bypass actor', () => {
    const result = evaluate({
      rulesets: [
        branchRuleset(),
        creationRuleset(),
        immutabilityRuleset({
          bypass_actors: [{ actor_id: 57482452, actor_type: 'User', bypass_mode: 'always' }],
        }),
      ],
    });
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' bypass actors are [User:57482452:always], expected []",
    );
  });

  it('fails closed on hidden bypass actors in strict mode', () => {
    const hidden = creationRuleset();
    delete (hidden as { bypass_actors?: unknown }).bypass_actors;
    const result = evaluate({ rulesets: [branchRuleset(), hidden, immutabilityRuleset()] });
    expect(result.failures).toContain(
      "bypass actors for ruleset 'Release tag creation authority' could not be verified: the API requires an owner-authorized read (set CONTROL_PLANE_TOKEN)",
    );
  });

  it('reports hidden bypass actors as partial verification in partial mode', () => {
    const hidden = creationRuleset();
    delete (hidden as { bypass_actors?: unknown }).bypass_actors;
    const result = evaluate(
      { rulesets: [branchRuleset(), hidden, immutabilityRuleset()] },
      'partial',
    );
    expect(result.failures).toEqual([]);
    expect(result.unverified).toContain("bypass actors for 'Release tag creation authority'");
    expect(result.warnings[0]).toContain('UNVERIFIED');
  });

  it('fails when the release environment or its wait timer is missing', () => {
    expect(evaluate({ environments: [] }).failures).toContain(
      "missing protected environment 'release'",
    );

    const noTimer = evaluate({
      environments: [releaseEnvironment({ protection_rules: [] })],
    });
    expect(noTimer.failures).toContain("environment 'release' has no wait timer");

    const shortTimer = evaluate({
      environments: [
        releaseEnvironment({ protection_rules: [{ type: 'wait_timer', wait_timer: 1 }] }),
      ],
    });
    expect(shortTimer.failures).toContain(
      "environment 'release' wait timer is 1 minutes, expected 15",
    );
  });

  it('pins the active deployment policy mode of the environment', () => {
    const protectedOnly = evaluate({
      environments: [
        releaseEnvironment({
          deployment_branch_policy: { custom_branch_policies: false, protected_branches: true },
        }),
      ],
    });
    expect(protectedOnly.failures).toContain(
      "environment 'release' custom_branch_policies is false, expected true",
    );
    expect(protectedOnly.failures).toContain(
      "environment 'release' protected_branches is true, expected false",
    );
  });

  it('fails when the release environment loses the v* tag deployment policy', () => {
    const result = evaluate({ releaseEnvironmentPolicies: [] });
    expect(result.failures).toContain("environment 'release' has no 'v*' tag deployment policy");
  });

  it('pins the Actions policy', () => {
    const result = evaluate({
      actionsPermissions: {
        enabled: true,
        allowed_actions: 'selected',
        sha_pinning_required: false,
      },
    });
    expect(result.failures).toContain("Actions allowed_actions is 'selected', expected 'all'");
    expect(result.failures).toContain('Actions sha_pinning_required is false, expected true');
  });

  it('fails closed on an unreadable Actions policy in strict mode and warns in partial mode', () => {
    const strict = evaluate({ actionsPermissions: { unavailable: 'HTTP 403' } });
    expect(strict.failures).toContain(
      'Actions policy could not be read: HTTP 403 (set CONTROL_PLANE_TOKEN)',
    );

    const partial = evaluate({ actionsPermissions: { unavailable: 'HTTP 403' } }, 'partial');
    expect(partial.failures).toEqual([]);
    expect(partial.unverified).toContain('Actions policy');
  });

  it('keeps tag creation and immutability as separate policies', () => {
    expect(TAG_RULESET_CONTRACTS).toHaveLength(2);
    const [creation, immutability] = TAG_RULESET_CONTRACTS;
    expect(creation?.requiredRules).toEqual(['creation']);
    expect(creation?.bypassActors).toEqual([
      { actorType: 'User', actorId: 57482452, bypassMode: 'always' },
    ]);
    expect(immutability?.requiredRules).toEqual(['update', 'deletion', 'non_fast_forward']);
    expect(immutability?.bypassActors).toEqual([]);
  });

  it('requires no approving review and pinned Actions policy', () => {
    expect(CONTROL_PLANE_CONTRACT.branchRuleset.pullRequest.requiredApprovingReviewCount).toBe(0);
    expect(ACTIONS_POLICY_CONTRACT).toEqual({
      enabled: true,
      allowedActions: 'all',
      shaPinningRequired: true,
    });
  });
});
