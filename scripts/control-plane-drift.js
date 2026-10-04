#!/usr/bin/env node
/**
 * @module scripts/control-plane-drift
 * @description Fail-closed drift detection for the relied-upon GitHub control
 * plane: branch ruleset, tag rulesets, and the protected release environment.
 *
 * The live configuration is compared against `scripts/control-plane-contract.js`
 * (the single structured authority). Any missing or divergent relied-upon
 * setting fails. Because the repository is public, all endpoints are readable
 * without elevated credentials; `bypass_actors` is only visible to callers with
 * enough ruleset access, so a hidden actor list is reported as `UNVERIFIED`
 * instead of being silently treated as correct.
 *
 * Usage:
 *   node scripts/control-plane-drift.js [--verbose] [--repo owner/name]
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

function describeBypassActors(ruleset) {
  if (Array.isArray(ruleset.bypass_actors)) {
    return ruleset.bypass_actors.map((actor) => `${actor.actor_type}:${actor.actor_id}`);
  }
  return null;
}

function checkBypassActors(ruleset, contract, failures, warnings) {
  const actors = describeBypassActors(ruleset);
  if (actors === null) {
    warnings.push(
      `UNVERIFIED bypass actors for ruleset '${ruleset.name}': the API hides bypass_actors for this caller (verify with an owner-authorized read)`,
    );
    return;
  }
  if (contract.expectsBypassActor && actors.length === 0) {
    failures.push(
      `ruleset '${ruleset.name}' must declare a bypass actor for the release authority, but has none`,
    );
  }
  if (!contract.expectsBypassActor && actors.length > 0) {
    failures.push(
      `ruleset '${ruleset.name}' must not declare bypass actors (found ${actors.join(', ')})`,
    );
  }
}

function checkBranchRuleset(live, contract, failures, warnings) {
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
  const includedRefs = ruleset.conditions?.ref_name?.include ?? [];
  if (!includedRefs.includes('~ALL')) {
    for (const ref of contract.includedRefs) {
      if (!includedRefs.includes(ref)) {
        failures.push(`ruleset '${ruleset.name}' does not include ${ref}`);
      }
    }
  }
  const statusRule = ruleByType(ruleset, 'required_status_checks');
  if (statusRule) {
    const contexts = (statusRule.parameters?.required_status_checks ?? []).map(
      (check) => check.context,
    );
    if (!sameSet(contexts, contract.requiredStatusChecks)) {
      const missing = contract.requiredStatusChecks.filter((name) => !contexts.includes(name));
      const extra = contexts.filter((name) => !contract.requiredStatusChecks.includes(name));
      if (missing.length > 0) failures.push(`required checks missing: ${missing.join(', ')}`);
      if (extra.length > 0) failures.push(`required checks not in contract: ${extra.join(', ')}`);
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
  checkBypassActors(ruleset, contract, failures, warnings);
}

function checkTagRulesets(live, contract, failures, warnings) {
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
    checkBypassActors(ruleset, tagContract, failures, warnings);
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

/**
 * Pure comparison between observed live configuration and the contract.
 *
 * @returns {{ failures: string[], warnings: string[] }}
 */
export function evaluateControlPlane(live, contract = CONTROL_PLANE_CONTRACT) {
  const failures = [];
  const warnings = [];
  checkBranchRuleset(live, contract.branchRuleset, failures, warnings);
  checkTagRulesets(live, contract.tagRulesets, failures, warnings);
  checkReleaseEnvironment(live, contract.releaseEnvironment, failures);
  return { failures, warnings };
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
 * Fetch the live control plane. Fails closed: any unavailable endpoint throws.
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
  return {
    rulesets,
    environments: environments.environments ?? [],
    releaseEnvironmentPolicies: releaseEnvironmentPolicies.branch_policies ?? [],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const repoIndex = args.indexOf('--repo');
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('control-plane-drift failed: pass --repo owner/name or set GITHUB_REPOSITORY');
    process.exit(1);
  }

  let live;
  try {
    live = await fetchLiveControlPlane({ repo, token: process.env.GITHUB_TOKEN });
  } catch (error) {
    console.error(
      `control-plane-drift failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const { failures, warnings } = evaluateControlPlane(live, CONTROL_PLANE_CONTRACT);
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (verbose) {
    console.log(
      `Checked ${live.rulesets.length} ruleset(s) and ${live.environments.length} environment(s) on ${repo}.`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`drift: ${failure}`);
    }
    console.error(`control-plane-drift failed: ${failures.length} divergence(s) detected`);
    process.exit(1);
  }
  console.log('control-plane-drift OK: live configuration matches the contract.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
