/**
 * Deterministic target partition for the sharded mutation gate.
 *
 * The profile config remains the authority for the full mutate list. Sharding
 * only decides which disjoint target set a runner measures; it never changes a
 * selector, a mutator, a test runner setting or a threshold. The merged report
 * is the only admission evidence and is verified against the canonical config.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const MAX_MUTATION_SHARDS = 32;

const PROFILE_REGISTRY_PATH = 'scripts/mutation-profile-registry.json';

function fail(message) {
  throw new Error(`[mutation-shard-plan] ${message}`);
}

/** Strip a Stryker mutation range; the target is the file every range belongs to. */
export function mutationTargetOf(selector) {
  if (typeof selector !== 'string' || selector.length === 0) {
    fail('every mutate selector must be a non-empty string');
  }
  if (/[\r\n\0,]/.test(selector)) {
    fail(`mutate selector '${selector}' contains a character that cannot be sharded`);
  }
  const range = selector.indexOf(':');
  const target = range === -1 ? selector : selector.slice(0, range);
  if (target.length === 0) fail(`mutate selector '${selector}' has no target file`);
  if (/[*?]/.test(target)) {
    fail(`mutate selector '${selector}' is a glob; sharding requires explicit target files`);
  }
  return target;
}

function validateShardCount(shardCount, targetCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    fail('shardCount must be a positive integer');
  }
  if (shardCount > MAX_MUTATION_SHARDS) {
    fail(`shardCount ${shardCount} exceeds the supported maximum ${MAX_MUTATION_SHARDS}`);
  }
  if (shardCount > targetCount) {
    fail(`shardCount ${shardCount} exceeds the ${targetCount} distinct target(s)`);
  }
}

/**
 * Partition selectors into disjoint, weight-balanced shards.
 *
 * All selectors for one target stay together: a range profile must never be
 * split across runners. A heavier target is placed first on the least-loaded
 * shard; ties fall back to the lower shard index and canonical target order so
 * every runner derives the same partition.
 *
 * @param {{ selectors: readonly string[], weights: ReadonlyMap<string, number>,
 *   shardCount: number }} input
 * @returns {Array<{ index: number, selectors: string[], targets: string[],
 *   weight: number }>}
 */
export function planMutationShards({ selectors, weights, shardCount }) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    fail('selectors must be a non-empty array');
  }
  const grouped = new Map();
  const targetOrder = new Map();
  const selectorOrder = new Map();
  for (const [index, selector] of selectors.entries()) {
    if (selectorOrder.has(selector)) fail(`duplicate mutate selector '${selector}'`);
    selectorOrder.set(selector, index);
    const target = mutationTargetOf(selector);
    if (!grouped.has(target)) {
      grouped.set(target, []);
      targetOrder.set(target, targetOrder.size);
    }
    grouped.get(target).push(selector);
  }
  validateShardCount(shardCount, grouped.size);

  for (const target of grouped.keys()) {
    const weight = weights.get(target);
    if (!Number.isFinite(weight) || weight <= 0) {
      fail(`target '${target}' has no positive weight`);
    }
  }

  const orderedTargets = [...grouped.keys()].sort((left, right) => {
    return weights.get(right) - weights.get(left) || targetOrder.get(left) - targetOrder.get(right);
  });

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    selectors: [],
    targets: [],
    weight: 0,
  }));

  for (const target of orderedTargets) {
    let selected = shards[0];
    for (const shard of shards) {
      if (shard.weight < selected.weight) selected = shard;
    }
    selected.targets.push(target);
    selected.weight += weights.get(target);
    selected.selectors.push(...grouped.get(target));
  }

  for (const shard of shards) {
    shard.selectors.sort((left, right) => selectorOrder.get(left) - selectorOrder.get(right));
    shard.targets.sort((left, right) => targetOrder.get(left) - targetOrder.get(right));
  }
  return shards;
}

/** Read a profile's exact mutate selectors from the registry-owned config. */
export function loadShardPlan({ repoRoot, profile, shardCount }) {
  const registryPath = resolve(repoRoot, PROFILE_REGISTRY_PATH);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const profileEntry = registry.profiles?.[profile];
  if (profileEntry === undefined) fail(`unknown mutation profile '${profile}'`);
  const configPath = resolve(repoRoot, profileEntry.configFile);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.mutate) || config.mutate.length === 0) {
    fail(`profile '${profile}' has no mutate selectors in ${profileEntry.configFile}`);
  }
  if (config.thresholds === undefined || typeof config.thresholds !== 'object') {
    fail(`profile '${profile}' has no thresholds in ${profileEntry.configFile}`);
  }
  const weights = new Map();
  for (const selector of config.mutate) {
    const target = mutationTargetOf(selector);
    if (weights.has(target)) continue;
    const stat = statSync(resolve(repoRoot, target));
    if (!stat.isFile() || stat.size <= 0) fail(`target '${target}' is not a non-empty file`);
    weights.set(target, stat.size);
  }
  if (weights.size === 0) fail(`profile '${profile}' has no target files`);
  const shards = planMutationShards({ selectors: config.mutate, weights, shardCount });
  return { profile, configPath, configFile: profileEntry.configFile, config, shards };
}

/** A shard config is the canonical config with exactly two measurement overrides. */
export function shardConfigFor({ config, shard }) {
  if (!Array.isArray(shard.selectors) || shard.selectors.length === 0) {
    fail(`shard ${shard.index} has no selectors`);
  }
  const breakThreshold = config.thresholds?.break;
  if (typeof breakThreshold !== 'number') {
    fail('the canonical config must declare a numeric thresholds.break');
  }
  return {
    ...config,
    mutate: [...shard.selectors],
    // Shards measure disjoint subsets; the aggregate admission is enforced on
    // the merged report. A per-shard break gate would fail a valid subset.
    thresholds: { ...config.thresholds, break: 0 },
  };
}
