#!/usr/bin/env node
/**
 * Measure the documented first local run on a fresh clone.
 *
 * This is acceptance evidence, not a required CI gate. It clones the requested
 * ref into a temporary directory, uses an empty npm cache, and times:
 *   clone -> npm ci -> npm run check -> npm test
 *
 * The 15-minute target covers those four steps. `--with-build` measures
 * `npm run build` separately and does not change the target.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

const DEFAULT_REPO = 'https://github.com/koeppben23/governed-runtime.git';
const TARGET_MS = 15 * 60 * 1000;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

class OnboardingSmokeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ONBOARDING_SMOKE_FAILED';
  }
}

/**
 * Fail closed when a caller pins the acceptance run to one exact commit.
 * A branch ref alone can move between invocation and interpretation.
 */
export function assertExpectedCommit(actual, expected) {
  if (expected === undefined) return;
  if (!/^[0-9a-f]{40}$/i.test(expected)) {
    throw new OnboardingSmokeError(
      '--expected-sha must be a full 40-character hexadecimal commit SHA',
    );
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new OnboardingSmokeError(
      `expected commit ${expected}, but the clone checked out ${actual}`,
    );
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function run(label, command, args, options = {}) {
  console.error(`[onboarding-smoke] ${label}: ${command} ${args.join(' ')}`);
  const started = performance.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  const elapsedMs = performance.now() - started;

  if (result.error) {
    throw new OnboardingSmokeError(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new OnboardingSmokeError(`${label} failed with exit code ${String(result.status)}`);
  }
  return elapsedMs;
}

function requirePinnedNode() {
  const pinned = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
  if (process.versions.node !== pinned) {
    throw new OnboardingSmokeError(
      `requires Node ${pinned}, but this process is Node ${process.versions.node}. ` +
        `Run: nvm install "$(cat .node-version)" && nvm use "$(cat .node-version)"`,
    );
  }
  return pinned;
}

function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: DEFAULT_REPO },
      ref: { type: 'string', default: 'develop' },
      'expected-sha': { type: 'string' },
      'with-build': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const nodeVersion = requirePinnedNode();
  const npmVersion = execFileSync(npmCommand, ['--version'], { encoding: 'utf8' }).trim();
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  const workRoot = mkdtempSync(join(tmpdir(), 'flowguard-onboarding-'));
  const cloneDir = join(workRoot, 'repo');
  const cacheDir = join(workRoot, 'npm-cache');

  try {
    const cloneMs = run('clone', 'git', ['clone', '--branch', values.ref, values.repo, cloneDir]);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim();
    assertExpectedCommit(commit, values['expected-sha']);

    const installMs = run('npm ci', npmCommand, ['ci'], {
      cwd: cloneDir,
      env: { ...process.env, npm_config_cache: cacheDir },
    });
    const checkMs = run('npm run check', npmCommand, ['run', 'check'], { cwd: cloneDir });
    const testMs = run('npm test', npmCommand, ['test'], { cwd: cloneDir });
    const buildMs = values['with-build']
      ? run('npm run build', npmCommand, ['run', 'build'], { cwd: cloneDir })
      : null;

    const targetMs = cloneMs + installMs + checkMs + testMs;
    const passed = targetMs <= TARGET_MS;

    console.log('');
    console.log('## Onboarding smoke result');
    console.log('');
    console.log('| Field | Value |');
    console.log('| --- | --- |');
    console.log(`| Date | ${new Date().toISOString()} |`);
    console.log(`| Repository | ${values.repo} |`);
    console.log(`| Ref | ${values.ref} |`);
    console.log(`| Commit | \`${commit}\` |`);
    console.log(`| Expected SHA | ${values['expected-sha'] ?? 'not supplied'} |`);
    console.log(
      `| SHA check | ${values['expected-sha'] === undefined ? 'not requested' : 'PASS'} |`,
    );
    console.log(`| OS | ${process.platform} ${process.arch} (${release()}) |`);
    console.log(`| Node | ${nodeVersion} |`);
    console.log(`| npm | ${npmVersion} |`);
    console.log(`| Git | ${gitVersion} |`);
    console.log('| Exit codes | 0 (clone, npm ci, check, test) |');
    console.log('| npm cache | empty temporary cache |');
    console.log(`| Clone | ${formatDuration(cloneMs)} |`);
    console.log(`| npm ci | ${formatDuration(installMs)} |`);
    console.log(`| npm run check | ${formatDuration(checkMs)} |`);
    console.log(`| npm test | ${formatDuration(testMs)} |`);
    console.log(`| **Total (target path)** | **${formatDuration(targetMs)}** |`);
    if (buildMs !== null) {
      console.log(`| npm run build (separate) | ${formatDuration(buildMs)} |`);
    }
    console.log(`| 15-minute target | ${passed ? 'PASS' : 'MISS'} |`);
    console.log('');
    console.log(
      passed
        ? 'The measured target path completed within 15 minutes.'
        : 'The measured target path exceeded 15 minutes; do not claim the 15-minute target for this environment.',
    );

    if (values.keep) {
      console.log(`Temporary clone kept at: ${cloneDir}`);
    }
  } finally {
    if (!values.keep) {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[onboarding-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
