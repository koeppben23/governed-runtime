/**
 * @module scripts/__tests__/control-plane-drift
 * @description Pure comparison tests for live control-plane drift detection.
 */

import { describe, expect, it } from 'vitest';

import { evaluateControlPlane } from '../control-plane-drift.js';
import { CONTROL_PLANE_CONTRACT, REQUIRED_STATUS_CHECKS } from '../control-plane-contract.js';

function branchRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Protect main and develop',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main', 'refs/heads/develop'] } },
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
          required_status_checks: REQUIRED_STATUS_CHECKS.map((context) => ({ context })),
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
    bypass_actors: [],
    rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    ...overrides,
  };
}

function live(overrides: Record<string, unknown> = {}) {
  return {
    rulesets: [branchRuleset(), creationRuleset(), immutabilityRuleset()],
    environments: [
      {
        name: 'release',
        protection_rules: [{ type: 'wait_timer', wait_timer: 15 }],
      },
    ],
    releaseEnvironmentPolicies: [{ name: 'v*', type: 'tag' }],
    ...overrides,
  };
}

describe('scripts/control-plane-drift', () => {
  it('accepts a live configuration that matches the contract', () => {
    const result = evaluateControlPlane(live(), CONTROL_PLANE_CONTRACT);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails when the branch ruleset is missing', () => {
    const result = evaluateControlPlane(
      live({ rulesets: [creationRuleset(), immutabilityRuleset()] }),
    );
    expect(result.failures).toContain("missing branch ruleset 'Protect main and develop'");
  });

  it('fails when a required branch rule is missing', () => {
    const reduced = branchRuleset({
      rules: branchRuleset().rules.filter((rule) => rule.type !== 'required_linear_history'),
    });
    const result = evaluateControlPlane(
      live({ rulesets: [reduced, creationRuleset(), immutabilityRuleset()] }),
    );
    expect(result.failures).toContain(
      "ruleset 'Protect main and develop' is missing rule 'required_linear_history'",
    );
  });

  it('fails when required status checks diverge in either direction', () => {
    const parameters = {
      strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_STATUS_CHECKS.filter((name) => name !== 'ci-gate').map(
        (context) => ({ context }),
      ),
    };
    const reduced = branchRuleset({
      rules: [
        ...branchRuleset().rules.filter((rule) => rule.type !== 'required_status_checks'),
        { type: 'required_status_checks', parameters },
      ],
    });
    const result = evaluateControlPlane(
      live({ rulesets: [reduced, creationRuleset(), immutabilityRuleset()] }),
    );
    expect(result.failures).toContain('required checks missing: ci-gate');
  });

  it('fails when the branch ruleset stops enforcing freshness', () => {
    const parameters = {
      strict_required_status_checks_policy: false,
      required_status_checks: REQUIRED_STATUS_CHECKS.map((context) => ({ context })),
    };
    const relaxed = branchRuleset({
      rules: [
        ...branchRuleset().rules.filter((rule) => rule.type !== 'required_status_checks'),
        { type: 'required_status_checks', parameters },
      ],
    });
    const result = evaluateControlPlane(
      live({ rulesets: [relaxed, creationRuleset(), immutabilityRuleset()] }),
    );
    expect(result.failures).toContain(
      "ruleset 'Protect main and develop' strict_required_status_checks_policy is false, expected true",
    );
  });

  it('fails when a tag ruleset is missing', () => {
    const result = evaluateControlPlane(
      live({ rulesets: [branchRuleset(), immutabilityRuleset()] }),
    );
    expect(result.failures).toContain("missing tag ruleset 'Release tag creation authority'");
  });

  it('fails when the immutability ruleset loses a rule', () => {
    const reduced = immutabilityRuleset({ rules: [{ type: 'deletion' }] });
    const result = evaluateControlPlane(
      live({ rulesets: [branchRuleset(), creationRuleset(), reduced] }),
    );
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' is missing rule 'update'",
    );
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' is missing rule 'non_fast_forward'",
    );
  });

  it('fails when the creation ruleset has no bypass actor for the release authority', () => {
    const result = evaluateControlPlane(
      live({
        rulesets: [branchRuleset(), creationRuleset({ bypass_actors: [] }), immutabilityRuleset()],
      }),
    );
    expect(result.failures).toContain(
      "ruleset 'Release tag creation authority' must declare a bypass actor for the release authority, but has none",
    );
  });

  it('fails when the immutability ruleset gains a bypass actor', () => {
    const result = evaluateControlPlane(
      live({
        rulesets: [
          branchRuleset(),
          creationRuleset(),
          immutabilityRuleset({ bypass_actors: [{ actor_id: 1, actor_type: 'User' }] }),
        ],
      }),
    );
    expect(result.failures).toContain(
      "ruleset 'Release tag immutability' must not declare bypass actors (found User:1)",
    );
  });

  it('reports hidden bypass actors as UNVERIFIED instead of silently passing them', () => {
    const hidden = creationRuleset();
    delete (hidden as { bypass_actors?: unknown }).bypass_actors;
    const result = evaluateControlPlane(
      live({ rulesets: [branchRuleset(), hidden, immutabilityRuleset()] }),
    );
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      "UNVERIFIED bypass actors for ruleset 'Release tag creation authority': the API hides bypass_actors for this caller (verify with an owner-authorized read)",
    ]);
  });

  it('fails when the release environment or its wait timer is missing', () => {
    const missingEnvironment = evaluateControlPlane(live({ environments: [] }));
    expect(missingEnvironment.failures).toContain("missing protected environment 'release'");

    const noTimer = evaluateControlPlane(
      live({ environments: [{ name: 'release', protection_rules: [] }] }),
    );
    expect(noTimer.failures).toContain("environment 'release' has no wait timer");

    const shortTimer = evaluateControlPlane(
      live({
        environments: [
          { name: 'release', protection_rules: [{ type: 'wait_timer', wait_timer: 1 }] },
        ],
      }),
    );
    expect(shortTimer.failures).toContain(
      "environment 'release' wait timer is 1 minutes, expected 15",
    );
  });

  it('fails when the release environment loses the v* tag deployment policy', () => {
    const result = evaluateControlPlane(live({ releaseEnvironmentPolicies: [] }));
    expect(result.failures).toContain("environment 'release' has no 'v*' tag deployment policy");
  });
});
