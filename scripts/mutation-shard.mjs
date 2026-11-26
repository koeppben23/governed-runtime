#!/usr/bin/env node

/**
 * Generate one deterministic mutation shard config.
 *
 * The generated config is the canonical profile config with exactly two
 * overrides: the shard's `mutate` subset and `thresholds.break: 0` (the
 * aggregate gate runs on the merged report). It stays in the repository root
 * so every relative path in the canonical config resolves as before.
 *
 * Usage:
 *   node scripts/mutation-shard.mjs --profile base --shard-index 0 \
 *     --shard-count 8 --config-out stryker.shard-0.conf.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadShardPlan, shardConfigFor } from './mutation-shard-plan.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function fail(message) {
  console.error(`[mutation-shard] ERROR: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    profile: undefined,
    shardIndex: undefined,
    shardCount: undefined,
    configOut: undefined,
    planOut: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--shard-index') options.shardIndex = Number(argv[++index]);
    else if (argument === '--shard-count') options.shardCount = Number(argv[++index]);
    else if (argument === '--config-out') options.configOut = argv[++index];
    else if (argument === '--plan-out') options.planOut = argv[++index];
    else fail(`unsupported argument '${argument}'`);
  }
  if (typeof options.profile !== 'string' || options.profile.length === 0) {
    fail('missing --profile');
  }
  if (!Number.isInteger(options.shardIndex) || options.shardIndex < 0) {
    fail('--shard-index must be a non-negative integer');
  }
  if (!Number.isInteger(options.shardCount) || options.shardCount < 1) {
    fail('--shard-count must be a positive integer');
  }
  if (options.shardIndex >= options.shardCount) {
    fail('--shard-index must be lower than --shard-count');
  }
  if (typeof options.configOut !== 'string' || options.configOut.length === 0) {
    fail('missing --config-out');
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const configTarget = resolve(REPO_ROOT, options.configOut);
  if (dirname(configTarget) !== REPO_ROOT) {
    fail('--config-out must be a file directly in the repository root');
  }
  const plan = loadShardPlan({
    repoRoot: REPO_ROOT,
    profile: options.profile,
    shardCount: options.shardCount,
  });
  const shard = plan.shards[options.shardIndex];
  const shardConfig = shardConfigFor({ config: plan.config, shard });
  mkdirSync(dirname(configTarget), { recursive: true });
  writeFileSync(configTarget, `${JSON.stringify(shardConfig, null, 2)}\n`, 'utf8');
  if (options.planOut !== undefined) {
    const planTarget = resolve(REPO_ROOT, options.planOut);
    mkdirSync(dirname(planTarget), { recursive: true });
    writeFileSync(
      planTarget,
      `${JSON.stringify(
        {
          profile: plan.profile,
          configFile: plan.configFile,
          shardIndex: shard.index,
          shardCount: options.shardCount,
          selectors: shard.selectors,
          targets: shard.targets,
          weight: shard.weight,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  console.error(
    `[mutation-shard] profile=${plan.profile} shard=${shard.index}/${options.shardCount} ` +
      `targets=${shard.targets.length} weight=${shard.weight} config=${options.configOut}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
