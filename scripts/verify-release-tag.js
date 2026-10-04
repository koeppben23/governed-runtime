#!/usr/bin/env node
/**
 * @module scripts/verify-release-tag
 * @description POST-TAG release preflight for the tag-triggered release
 * workflow. Fails closed unless the pushed tag is an annotated,
 * GitHub-verified signature over the exact current protected `main` commit and
 * the required live release controls — including the exact bypass actors and
 * the Actions policy — are present.
 *
 * The live-control comparison runs in `strict` mode: hidden `bypass_actors`
 * or an unreadable Actions policy fail the release. Set `CONTROL_PLANE_TOKEN`
 * to a read-only token with `Administration: read` so the release authority can
 * prove the configuration it relies on.
 *
 * This runs before any write-capable release job. The pure decisions live in
 * `scripts/release-preflight.js`; the live-control comparison reuses the
 * control-plane contract authority.
 *
 * Usage:
 *   node scripts/verify-release-tag.js v2.0.0-tp.1 [--repo owner/name]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROL_PLANE_CONTRACT } from './control-plane-contract.js';
import { evaluateControlPlane, fetchLiveControlPlane } from './control-plane-drift.js';
import {
  evaluateReleasePostTag,
  isPrereleaseVersion,
  releaseVersionOf,
  validateReleaseTagName,
} from './release-preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const args = process.argv.slice(2).filter((argument) => argument !== '--verbose');
const repoIndex = args.indexOf('--repo');
const repo = repoIndex >= 0 ? args[repoIndex + 1] : process.env.GITHUB_REPOSITORY;
const tag =
  args.find((argument) => argument !== '--repo' && argument !== repo) ??
  process.env.GITHUB_REF_NAME;

function git(errors, args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    errors.push(
      `git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return '';
  }
}

async function githubJson(path, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'flowguard-release-preflight',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const failures = [];
  const tagError = validateReleaseTagName(tag);
  if (tagError) {
    console.error(`release-tag-preflight failed: ${tagError}`);
    process.exit(1);
  }

  const label = `release-tag-preflight (${tag})`;
  git(failures, ['fetch', '--no-tags', 'origin', 'main']);

  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  const versionFile = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8').trim();
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
  const version = releaseVersionOf(tag);

  let refObjectType = 'missing';
  let verificationVerified = false;
  let taggedCommit = '';
  try {
    const ref = await githubJson(`/repos/${repo}/git/ref/tags/${tag}`, process.env.GITHUB_TOKEN);
    refObjectType = ref.object?.type ?? 'missing';
    taggedCommit = ref.object?.sha ?? '';
    if (refObjectType === 'tag') {
      const tagObject = await githubJson(
        `/repos/${repo}/git/tags/${taggedCommit}`,
        process.env.GITHUB_TOKEN,
      );
      verificationVerified = tagObject.verification?.verified === true;
      taggedCommit = tagObject.object?.sha ?? taggedCommit;
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const originMain = git(failures, ['rev-parse', 'origin/main']);

  failures.push(
    ...evaluateReleasePostTag({
      tag,
      refObjectType,
      taggedCommit,
      originMain,
      verificationVerified,
      packageVersion: packageJson.version,
      versionFile,
      changelogHasReleaseSection: changelog.includes(`## [${version}] - `),
    }),
  );

  try {
    const live = await fetchLiveControlPlane({
      repo,
      token: process.env.CONTROL_PLANE_TOKEN || process.env.GITHUB_TOKEN,
    });
    const controlPlane = evaluateControlPlane(live, CONTROL_PLANE_CONTRACT, { mode: 'strict' });
    for (const warning of controlPlane.warnings) {
      console.warn(`warning: ${warning}`);
    }
    failures.push(...controlPlane.failures.map((failure) => `control plane: ${failure}`));
  } catch (error) {
    failures.push(`control plane: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${label}: ${failure}`);
    }
    console.error(`${label} failed: ${failures.length} violation(s)`);
    process.exit(1);
  }

  const prerelease = isPrereleaseVersion(tag);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`);
  }
  console.log(
    `${label} OK: annotated, verified, points at protected main; prerelease=${prerelease}.`,
  );
}

await main();
