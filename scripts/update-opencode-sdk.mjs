#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const installedPackageJsonPath = path.join(
  root,
  'node_modules',
  '@opencode-ai',
  'plugin',
  'package.json',
);
const baselineVersionPath = path.join(root, '.sdk-baselines', 'opencode', 'version.json');
const hostVersionPath = path.join(root, '.sdk-baselines', 'opencode', 'host-version.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function resolvePackageVersion(packageName, rawTarget) {
  const target = rawTarget || 'latest';
  try {
    return execFileSync('npm', ['view', `${packageName}@${target}`, 'version'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Failed to resolve ${packageName}@${target}: ${message}`);
    process.exit(1);
  }
}

function writeHostVersion(version) {
  const meta = {
    platform: 'opencode',
    package: 'opencode-ai',
    updated: new Date().toISOString(),
    version,
    evidence:
      'OpenCode Desktop/host compatibility is verified via the opencode-ai package with autoupdate disabled during CI.',
    docs: ['https://opencode.ai/docs/cli/#upgrade', 'https://opencode.ai/docs/config/#autoupdate'],
  };
  fs.writeFileSync(hostVersionPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

const currentPackage = readJson(packageJsonPath);
const currentVersion = currentPackage.devDependencies?.['@opencode-ai/plugin'];
if (!currentVersion) {
  console.error('ERROR: package.json devDependencies must include @opencode-ai/plugin.');
  process.exit(1);
}

if (/^[~^]/.test(currentVersion)) {
  console.error(`ERROR: @opencode-ai/plugin must be exact-pinned, found ${currentVersion}.`);
  process.exit(1);
}

const targetVersion = resolvePackageVersion('@opencode-ai/plugin', process.argv[2]);
const targetHostVersion = resolvePackageVersion('opencode-ai', process.argv[3]);
console.log(`OpenCode SDK update: ${currentVersion} -> ${targetVersion}`);
console.log(`OpenCode host/Desktop compatibility target: opencode-ai@${targetHostVersion}`);

run('npm', ['install', `@opencode-ai/plugin@${targetVersion}`, '--save-dev', '--save-exact']);
run('node', ['scripts/sdk-type-snapshot.mjs', '--platform', 'opencode', '--update']);
writeHostVersion(targetHostVersion);

const installedVersion = readJson(installedPackageJsonPath).version;
const baselineVersion = readJson(baselineVersionPath).version;
const hostVersion = readJson(hostVersionPath).version;
const updatedPackage = readJson(packageJsonPath);
const pinnedVersion = updatedPackage.devDependencies?.['@opencode-ai/plugin'];

if (pinnedVersion !== targetVersion) {
  console.error(
    `ERROR: package.json pins @opencode-ai/plugin@${pinnedVersion}, expected ${targetVersion}.`,
  );
  process.exit(1);
}

if (installedVersion !== targetVersion) {
  console.error(
    `ERROR: installed @opencode-ai/plugin@${installedVersion}, expected ${targetVersion}.`,
  );
  process.exit(1);
}

if (baselineVersion !== targetVersion) {
  console.error(`ERROR: opencode baseline version ${baselineVersion}, expected ${targetVersion}.`);
  process.exit(1);
}

if (hostVersion !== targetHostVersion) {
  console.error(
    `ERROR: opencode host baseline version ${hostVersion}, expected ${targetHostVersion}.`,
  );
  process.exit(1);
}

console.log(`OpenCode SDK baseline synchronized at @opencode-ai/plugin@${targetVersion}.`);
console.log(`OpenCode host/Desktop baseline synchronized at opencode-ai@${targetHostVersion}.`);
