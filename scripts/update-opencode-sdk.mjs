#!/usr/bin/env node
/** Native API package update only. Never updates host certification, runtime
 * support constants, historical probes or installed-product documentation pins. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SdkContractError } from './sdk-type-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['@opencode/plugin', '@opencode/client'];
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

export function validateTarget(version) {
  if (!/^2\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new SdkContractError(`Expected one exact OpenCode V2 version, received ${version}`);
  return version;
}

function main() {
  if (process.argv.length > 3)
    throw new SdkContractError(
      'Usage: npm run update:opencode-sdk -- [V2-version-or-tag]. Host targets are not accepted.',
    );
  const requested = process.argv[2] ?? 'latest';
  const targets = packages.map((name) =>
    validateTarget(
      execFileSync('npm', ['view', `${name}@${requested}`, 'version'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ),
  );
  if (targets[0] !== targets[1])
    throw new SdkContractError(
      'Native plugin/client versions must match; review the release before updating.',
    );
  const pkg = read('package.json');
  for (const name of packages) validateTarget(pkg.dependencies[name]);
  run('npm', ['install', '--save-exact', ...packages.map((name, i) => `${name}@${targets[i]}`)]);
  run('node', ['scripts/sdk-type-snapshot.mjs', '--platform', 'opencode', '--update']);
  const updated = read('package.json');
  const lock = read('package-lock.json');
  const baseline = read('.sdk-baselines/opencode/version.json');
  for (const [i, name] of packages.entries()) {
    const installed = read(`node_modules/${name}/package.json`);
    if (
      [
        updated.dependencies[name],
        lock.packages[`node_modules/${name}`]?.version,
        installed.version,
        baseline.packages[name],
      ].some((version) => version !== targets[i])
    )
      throw new SdkContractError(`Native package/lock/install/baseline mismatch for ${name}`);
  }
  run('node', ['scripts/sdk-type-snapshot.mjs', '--platform', 'opencode']);
  console.log(
    `Native API baselines synchronized at ${targets[0]}. Installed Desktop/CLI, operator UI and reviewer assurance remain separate acceptance gates.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
