#!/usr/bin/env node
/**
 * @module scripts/control-plane-drift
 * @description Fail-closed drift detection for the relied-upon GitHub control
 * plane: branch ruleset, tag rulesets, protected release environment, and the
 * repository Actions policy.
 *
 * The live configuration is compared against `scripts/control-plane-contract.js`
 * (the single structured authority). Verification has two modes:
 *
 * - `strict` (default; scheduled runs and the release POST-TAG preflight):
 *   every relied-upon setting, including the exact bypass actors, must be
 *   readable and correct. Hidden `bypass_actors` is a failure.
 * - `partial` (pull-request runs only, no privileged secret): everything
 *   readable must match; hidden `bypass_actors` is reported as
 *   `PARTIAL_VERIFICATION` instead of a false full match.
 *
 * The repository is public, so most endpoints are readable without elevated
 * credentials. Reading `bypass_actors` and the Actions policy needs an
 * owner-authorized read; set `CONTROL_PLANE_TOKEN` to a read-only token with
 * `Administration: read`.
 *
 * Usage:
 *   node scripts/control-plane-drift.js [--mode strict|partial] [--verbose] [--repo owner/name]
 */

import { CONTROL_PLANE_CONTRACT } from './control-plane-contract.js';

const API_VERSION = '2022-11-28';

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function ruleByType(ruleset, type) {
  return ruleset.rules?.find((rule) => rule.type === type);
}

function describeActor(actor) {
  return `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode ?? 'always'}`;
}

function describeExpectedActor(actor) {
  return `${actor.actorType}:${actor.actorId}:${actor.bypassMode}`;
}

function checkBypassActors(ruleset, expectedActors, mode, failures, warnings, unverified) {
  const observed = Array.isArray(ruleset.bypass_actors)
    ? ruleset.bypass_actors.map(describeActor)
    : null;
  const expected = expectedActors.map(describeExpectedActor);
  if (observed === null) {
    const message = `bypass actors for ruleset '${ruleset.name}' could not be verified: the API requires an owner-authorized read (set CONTROL_PLANE_TOKEN)`;
    if (mode === 'strict') {
      failures.push(message);
    } else {
      warnings.push(`UNVERIFIED ${message}`);
      unverified.push(`bypass actors for '${ruleset.name}'`);
    }
    return;
  }
  if (!sameSet(observed, expected)) {
    failures.push(
      `ruleset '${ruleset.name}' bypass actors are [${observed.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }
}

function checkRefs(ruleset, refsContract, failures) {
  const included = ruleset.conditions?.ref_name?.include ?? [];
  const excluded = ruleset.conditions?.ref_name?.exclude ?? [];
  if (refsContract.mode === 'exact') {
    if (!sameSet(included, refsContract.includedRefs)) {
      failures.push(
        `ruleset '${ruleset.name}' includes [${included.join(', ')}], expected exactly [${refsContract.includedRefs.join(', ')}]`,
      );
    }
    if (!sameSet(excluded, refsContract.excludedRefs)) {
      failures.push(
        `ruleset '${ruleset.name}' excludes [${excluded.join(', ')}], expected exactly [${refsContract.excludedRefs.join(', ')}]`,
      );
    }
    return;
  }
  const allIncluded = included.includes('~ALL');
  for (const ref of refsContract.includedRefs) {
    if (!allIncluded && !included.includes(ref)) {
      failures.push(`ruleset '${ruleset.name}' does not include ${ref}`);
    }
    if (excluded.includes(ref)) {
      failures.push(`ruleset '${ruleset.name}' excludes protected ref ${ref}`);
    }
  }
}

function checkBranchRuleset(live, contract, mode, failures, warnings, unverified) {
  const ruleset = live.rulesets.find((entry) => entry.name === contract.name);
  if (!ruleset) {
    failures.push(`missing branch ruleset '${contract.name}'`);
    return;
  }
  if (ruleset.enforcement !== contract.enforcement) {
    failures.push(
      `ruleset '${ruleset.name}' enforcement is '${ruleset.enforcement}', expected '${contract.enforcement}'`,
    );
  }
  if (ruleset.target !== contract.target) {
    failures.push(
      `ruleset '${ruleset.name}' target is '${ruleset.target}', expected '${contract.target}'`,
    );
  }
  const observedRules = (ruleset.rules ?? []).map((rule) => rule.type);
  for (const required of contract.requiredRules) {
    if (!observedRules.includes(required)) {
      failures.push(`ruleset '${ruleset.name}' is missing rule '${required}'`);
    }
  }
  checkRefs(ruleset, contract.refs, failures);
  const statusRule = ruleByType(ruleset, 'required_status_checks');
  if (statusRule) {
    const entries = statusRule.parameters?.required_status_checks ?? [];
    const contexts = entries.map((check) => check.context);
    if (!sameSet(contexts, contract.requiredStatusChecks)) {
      const missing = contract.requiredStatusChecks.filter((name) => !contexts.includes(name));
      const extra = contexts.filter((name) => !contract.requiredStatusChecks.includes(name));
      if (missing.length > 0) failures.push(`required checks missing: ${missing.join(', ')}`);
      if (extra.length > 0) failures.push(`required checks not in contract: ${extra.join(', ')}`);
    }
    for (const check of entries) {
      if (check.integration_id !== contract.requiredStatusChecksIntegrationId) {
        failures.push(
          `required check '${check.context}' is bound to app ${check.integration_id ?? 'none'}, expected ${contract.requiredStatusChecksIntegrationId}`,
        );
      }
    }
    const strict = statusRule.parameters?.strict_required_status_checks_policy;
    if (strict !== contract.strictRequiredStatusChecks) {
      failures.push(
        `ruleset '${ruleset.name}' strict_required_status_checks_policy is ${strict}, expected ${contract.strictRequiredStatusChecks}`,
      );
    }
  }
  const prRule = ruleByType(ruleset, 'pull_request');
  if (prRule) {
    const parameters = prRule.parameters ?? {};
    if (
      parameters.required_approving_review_count !==
      contract.pullRequest.requiredApprovingReviewCount
    ) {
      failures.push(
        `ruleset '${ruleset.name}' required_approving_review_count is ${parameters.required_approving_review_count}, expected ${contract.pullRequest.requiredApprovingReviewCount}`,
      );
    }
    if (
      parameters.dismiss_stale_reviews_on_push !== contract.pullRequest.dismissStaleReviewsOnPush
    ) {
      failures.push(
        `ruleset '${ruleset.name}' dismiss_stale_reviews_on_push diverges from contract`,
      );
    }
    if (
      parameters.required_review_thread_resolution !==
      contract.pullRequest.requireReviewThreadResolution
    ) {
      failures.push(
        `ruleset '${ruleset.name}' require_review_thread_resolution diverges from contract`,
      );
    }
    const methods = parameters.allowed_merge_methods ?? [];
    if (!sameSet(methods, contract.pullRequest.allowedMergeMethods)) {
      failures.push(
        `ruleset '${ruleset.name}' allowed_merge_methods is [${methods.join(', ')}], expected [${contract.pullRequest.allowedMergeMethods.join(', ')}]`,
      );
    }
  }
  checkBypassActors(ruleset, contract.bypassActors, mode, failures, warnings, unverified);
}

function checkTagRulesets(live, contract, mode, failures, warnings, unverified) {
  for (const tagContract of contract) {
    const ruleset = live.rulesets.find((entry) => entry.name === tagContract.name);
    if (!ruleset) {
      failures.push(`missing tag ruleset '${tagContract.name}'`);
      continue;
    }
    if (ruleset.target !== tagContract.target) {
      failures.push(
        `ruleset '${ruleset.name}' target is '${ruleset.target}', expected '${tagContract.target}'`,
      );
    }
    if (ruleset.enforcement !== tagContract.enforcement) {
      failures.push(
        `ruleset '${ruleset.name}' enforcement is '${ruleset.enforcement}', expected '${tagContract.enforcement}'`,
      );
    }
    const observedRules = (ruleset.rules ?? []).map((rule) => rule.type);
    for (const required of tagContract.requiredRules) {
      if (!observedRules.includes(required)) {
        failures.push(`ruleset '${ruleset.name}' is missing rule '${required}'`);
      }
    }
    checkRefs(ruleset, tagContract.refs, failures);
    checkBypassActors(ruleset, tagContract.bypassActors, mode, failures, warnings, unverified);
  }
}

function checkReleaseEnvironment(live, contract, failures) {
  const environment = live.environments.find((entry) => entry.name === contract.name);
  if (!environment) {
    failures.push(`missing protected environment '${contract.name}'`);
    return;
  }
  const waitTimer = (environment.protection_rules ?? []).find((rule) => rule.type === 'wait_timer');
  if (!waitTimer) {
    failures.push(`environment '${contract.name}' has no wait timer`);
  } else if (waitTimer.wait_timer !== contract.waitTimerMinutes) {
    failures.push(
      `environment '${contract.name}' wait timer is ${waitTimer.wait_timer} minutes, expected ${contract.waitTimerMinutes}`,
    );
  }
  const deploymentPolicy = environment.deployment_branch_policy;
  if (deploymentPolicy?.custom_branch_policies !== contract.customBranchPolicies) {
    failures.push(
      `environment '${contract.name}' custom_branch_policies is ${deploymentPolicy?.custom_branch_policies}, expected ${contract.customBranchPolicies}`,
    );
  }
  if (deploymentPolicy?.protected_branches !== contract.protectedBranches) {
    failures.push(
      `environment '${contract.name}' protected_branches is ${deploymentPolicy?.protected_branches}, expected ${contract.protectedBranches}`,
    );
  }
  const policies = live.releaseEnvironmentPolicies ?? [];
  const tagPolicy = policies.find(
    (policy) => policy.name === contract.deploymentTagPolicy && policy.type === 'tag',
  );
  if (!tagPolicy) {
    failures.push(
      `environment '${contract.name}' has no '${contract.deploymentTagPolicy}' tag deployment policy`,
    );
  }
}

function checkActionsPolicy(live, contract, mode, failures, warnings, unverified) {
  const permissions = live.actionsPermissions;
  if (!permissions || permissions.unavailable) {
    const message = `Actions policy could not be read${
      permissions?.unavailable ? `: ${permissions.unavailable}` : ''
    } (set CONTROL_PLANE_TOKEN)`;
    if (mode === 'strict') {
      failures.push(message);
    } else {
      warnings.push(`UNVERIFIED ${message}`);
      unverified.push('Actions policy');
    }
    return;
  }
  if (permissions.enabled !== contract.enabled) {
    failures.push(`Actions enabled is ${permissions.enabled}, expected ${contract.enabled}`);
  }
  if (permissions.allowed_actions !== contract.allowedActions) {
    failures.push(
      `Actions allowed_actions is '${permissions.allowed_actions}', expected '${contract.allowedActions}'`,
    );
  }
  if (permissions.sha_pinning_required !== contract.shaPinningRequired) {
    failures.push(
      `Actions sha_pinning_required is ${permissions.sha_pinning_required}, expected ${contract.shaPinningRequired}`,
    );
  }
}

/**
 * Pure comparison between observed live configuration and the contract.
 *
 * @returns {{ failures: string[], warnings: string[], unverified: string[] }}
 */
export function evaluateControlPlane(live, contract = CONTROL_PLANE_CONTRACT, options = {}) {
  const mode = options.mode === 'partial' ? 'partial' : 'strict';
  const failures = [];
  const warnings = [];
  const unverified = [];
  checkBranchRuleset(live, contract.branchRuleset, mode, failures, warnings, unverified);
  checkTagRulesets(live, contract.tagRulesets, mode, failures, warnings, unverified);
  checkReleaseEnvironment(live, contract.releaseEnvironment, failures);
  checkActionsPolicy(live, contract.actionsPolicy, mode, failures, warnings, unverified);
  return { failures, warnings, unverified };
}

async function githubJson(fetchImpl, path, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'flowguard-control-plane-drift',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch the live control plane. Rulesets, environments, and deployment
 * policies are required and fail closed. The Actions policy is fetched
 * best-effort and reported as unavailable when the caller is not authorized.
 */
export async function fetchLiveControlPlane({ repo, token, fetchImpl = fetch }) {
  const rulesetSummaries = await githubJson(fetchImpl, `/repos/${repo}/rulesets`, token);
  const rulesets = [];
  for (const summary of rulesetSummaries) {
    rulesets.push(await githubJson(fetchImpl, `/repos/${repo}/rulesets/${summary.id}`, token));
  }
  const environments = await githubJson(fetchImpl, `/repos/${repo}/environments`, token);
  const releaseEnvironmentPolicies = await githubJson(
    fetchImpl,
    `/repos/${repo}/environments/${CONTROL_PLANE_CONTRACT.releaseEnvironment.name}/deployment-branch-policies`,
    token,
  );
  let actionsPermissions;
  try {
    actionsPermissions = await githubJson(fetchImpl, `/repos/${repo}/actions/permissions`, token);
  } catch (error) {
    actionsPermissions = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  return {
    rulesets,
    environments: environments.environments ?? [],
    releaseEnvironmentPolicies: releaseEnvironmentPolicies.branch_policies ?? [],
    actionsPermissions,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'strict';
  const repoIndex = args.indexOf('--repo');
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('control-plane-drift failed: pass --repo owner/name or set GITHUB_REPOSITORY');
    process.exit(1);
  }
  if (mode !== 'strict' && mode !== 'partial') {
    console.error(`control-plane-drift failed: unknown mode '${mode}'`);
    process.exit(1);
  }

  const token = process.env.CONTROL_PLANE_TOKEN || process.env.GITHUB_TOKEN;
  let live;
  try {
    live = await fetchLiveControlPlane({ repo, token });
  } catch (error) {
    console.error(
      `control-plane-drift failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const { failures, warnings, unverified } = evaluateControlPlane(live, CONTROL_PLANE_CONTRACT, {
    mode,
  });
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (verbose) {
    console.log(
      `Checked ${live.rulesets.length} ruleset(s) and ${live.environments.length} environment(s) on ${repo} in ${mode} mode.`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`drift: ${failure}`);
    }
    console.error(`control-plane-drift failed: ${failures.length} divergence(s) detected`);
    process.exit(1);
  }
  if (unverified.length > 0) {
    console.warn(
      `control-plane-drift PARTIAL_VERIFICATION: ${unverified.join(', ')} could not be verified`,
    );
    return;
  }
  console.log('control-plane-drift OK: live configuration matches the contract.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
