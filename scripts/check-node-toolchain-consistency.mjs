#!/usr/bin/env node
/**
 * @module scripts/check-node-toolchain-consistency
 * @description Validates Node toolchain invariants: .node-version, CI workflow
 * node-version-file usage (direct setup-node calls AND local composite actions),
 * devEngines consistency, and package engines policy.
 *
 * The workflow/action analysis is a pure function over parsed YAML so it can be
 * unit-tested with fixtures. Every non-allow-listed workflow must prove a
 * node-version-file reference either directly on a setup-node step or through a
 * local composite action whose metadata (recursively) configures one; local
 * actions that install Node without a node-version-file fail closed.
 *
 * @version v2
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

const MATRIX_ALLOW_LIST = new Set(['node-compat.yml', 'release.yml']);

// ─── Pure analysis ──────────────────────────────────────────────────────────

function parseDocument(content) {
  try {
    return parse(content);
  } catch {
    return null;
  }
}

function collectWorkflowSteps(doc) {
  const steps = [];
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') return steps;
  for (const job of Object.values(doc.jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (step && typeof step === 'object') steps.push(step);
    }
  }
  return steps;
}

function collectActionSteps(doc) {
  const steps = doc?.runs?.steps;
  return Array.isArray(steps) ? steps.filter((step) => step && typeof step === 'object') : [];
}

/** Setup-node configuration of a step, or null when the step is not setup-node. */
function setupNodeConfig(step) {
  const uses = typeof step.uses === 'string' ? step.uses.trim() : '';
  if (!uses.startsWith('actions/setup-node')) return null;
  const withBlock = step.with && typeof step.with === 'object' ? step.with : {};
  const staticVersion =
    withBlock['node-version'] !== undefined &&
    (typeof withBlock['node-version'] !== 'string' || !withBlock['node-version'].includes('${{'));
  return {
    hasNodeVersionFile: withBlock['node-version-file'] !== undefined,
    staticVersion,
  };
}

/** Repository-relative directory of a `./` local action reference, or null. */
function localActionDir(uses) {
  if (typeof uses !== 'string') return null;
  const trimmed = uses.trim().replace(/\/+$/, '');
  if (!trimmed.startsWith('./.github/actions/')) return null;
  return trimmed.slice(2);
}

/** Directory key of a local action metadata file, e.g. `.github/actions/x`. */
export function actionDirectory(rel) {
  return rel.split('/').slice(0, -1).join('/');
}

function localActionProof(dir, actionByDir, visited) {
  if (visited.has(dir)) return { found: false, proof: false };
  visited.add(dir);
  const entry = actionByDir.get(dir);
  if (!entry) return { found: false, proof: false };
  let proof = false;
  for (const step of collectActionSteps(entry.doc)) {
    const config = setupNodeConfig(step);
    if (config?.hasNodeVersionFile) proof = true;
    const nested = localActionDir(step.uses);
    if (nested !== null && localActionProof(nested, actionByDir, visited).proof) proof = true;
  }
  return { found: true, proof };
}

/**
 * Pure node-toolchain analysis over workflow and local-action YAML.
 *
 * @param {{ workflows: ReadonlyArray<{file: string, content: string}>,
 *           actions: ReadonlyArray<{file: string, content: string}> }} input
 * @returns {string[]} deterministic error messages; empty means consistent
 */
export function analyzeNodeToolchain(input) {
  const errors = [];
  const actionByDir = new Map();
  for (const action of input.actions) {
    actionByDir.set(actionDirectory(action.file), {
      ...action,
      doc: parseDocument(action.content),
    });
  }

  for (const entry of actionByDir.values()) {
    if (entry.doc === null) {
      errors.push(`${entry.file}: invalid YAML`);
      continue;
    }
    for (const step of collectActionSteps(entry.doc)) {
      const config = setupNodeConfig(step);
      if (!config) continue;
      if (!config.hasNodeVersionFile) {
        errors.push(`${entry.file}: setup-node step without node-version-file`);
      }
      if (config.staticVersion) {
        errors.push(`${entry.file}: static node-version outside allow-listed matrix workflow`);
      }
    }
  }

  for (const workflow of input.workflows) {
    const fileName = basename(workflow.file);
    if (MATRIX_ALLOW_LIST.has(fileName)) {
      if (fileName === 'release.yml' && !/node-version-file:/.test(workflow.content)) {
        errors.push('release.yml: missing node-version-file for build job');
      }
      continue;
    }

    const doc = parseDocument(workflow.content);
    if (doc === null) {
      errors.push(`${fileName}: invalid YAML`);
      continue;
    }

    const staticNodeVersion = workflow.content.match(/node-version:\s*['"][^$]*['"]/g);
    if (staticNodeVersion) {
      for (const match of staticNodeVersion) {
        errors.push(
          `${fileName}: static node-version "${match}" outside allow-listed matrix workflow`,
        );
      }
    }

    let directProof = false;
    let indirectProof = false;
    for (const step of collectWorkflowSteps(doc)) {
      const config = setupNodeConfig(step);
      if (config) {
        if (config.hasNodeVersionFile) directProof = true;
        else errors.push(`${fileName}: setup-node step without node-version-file`);
        if (config.staticVersion) {
          errors.push(`${fileName}: static node-version outside allow-listed matrix workflow`);
        }
      }
      const ref = localActionDir(step.uses);
      if (ref !== null && localActionProof(ref, actionByDir, new Set()).proof) indirectProof = true;
    }

    if (!directProof && !indirectProof) {
      errors.push(`${fileName}: no node-version-file reference`);
    }
  }

  return errors;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function readYamlFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...readYamlFiles(path, predicate));
    else if (predicate(entry.name)) {
      results.push({
        file: relative(REPO_ROOT, path),
        content: readFileSync(path, 'utf-8'),
      });
    }
  }
  return results;
}

function run() {
  let errors = 0;

  function error(msg) {
    console.error(`  FAIL  ${msg}`);
    errors++;
  }

  // ─── 1. .node-version ──────────────────────────────────────────────────
  console.log('--- .node-version ---');
  let nodeVersionFile = '';
  const nodeVersionPath = join(REPO_ROOT, '.node-version');
  if (!existsSync(nodeVersionPath)) {
    error('.node-version file missing');
  } else {
    nodeVersionFile = readFileSync(nodeVersionPath, 'utf-8').trim();
    const semverRe = /^\d+\.\d+\.\d+$/;
    if (!semverRe.test(nodeVersionFile)) {
      error(`.node-version "${nodeVersionFile}" is not a valid semver`);
    } else {
      console.log(`  ok: .node-version = ${nodeVersionFile}`);
    }
  }

  // ─── 2. package.json devEngines ────────────────────────────────────────
  console.log('--- devEngines ---');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  if (!pkg.devEngines || !pkg.devEngines.runtime) {
    error('package.json missing devEngines.runtime');
  } else {
    const runtime = pkg.devEngines.runtime;
    if (runtime.name !== 'node') {
      error(`devEngines.runtime.name expected "node", got "${runtime.name}"`);
    }
    if (runtime.onFail !== 'error') {
      error(`devEngines.runtime.onFail expected "error", got "${runtime.onFail}"`);
    }
    if (nodeVersionFile && runtime.version !== nodeVersionFile) {
      const rangeMin = runtime.version.replace(/^>=/, '');
      const [a, b, c] = rangeMin.split('.').map(Number);
      const [x, y, z] = nodeVersionFile.split('.').map(Number);
      const nodeVer = x * 10000 + y * 100 + z;
      const minVer = a * 10000 + b * 100 + c;
      if (nodeVer < minVer) {
        error(
          `.node-version "${nodeVersionFile}" does not satisfy devEngines.runtime.version "${runtime.version}"`,
        );
      } else {
        console.log(
          `  ok: .node-version ${nodeVersionFile} satisfies devEngines range ${runtime.version}`,
        );
      }
    }
    console.log(
      `  ok: devEngines.runtime.name=${runtime.name}, version=${runtime.version}, onFail=${runtime.onFail}`,
    );
  }

  // ─── 3. package.json engines ───────────────────────────────────────────
  console.log('--- engines ---');
  const enginesNode = pkg.engines?.node;
  if (!enginesNode) {
    error('package.json missing engines.node');
  } else if (enginesNode === '>=20') {
    error('engines.node is still unbounded ">=20" — must declare explicit major ranges');
  } else {
    console.log(`  ok: engines.node = ${enginesNode}`);
  }

  // ─── 4. Workflow and local-action policy ───────────────────────────────
  console.log('--- Workflows and local actions ---');
  const workflows = readYamlFiles(
    WORKFLOW_DIR,
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );
  const actions = readYamlFiles(
    ACTIONS_DIR,
    (name) => name === 'action.yml' || name === 'action.yaml',
  );
  for (const message of analyzeNodeToolchain({ workflows, actions })) {
    error(message);
  }
  console.log(
    `  Scanned ${workflows.length} workflow files and ${actions.length} local action files`,
  );

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  if (errors > 0) {
    console.error(`Node toolchain consistency check FAILED with ${errors} error(s).`);
    process.exit(1);
  }
  console.log('Node toolchain consistency check passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
