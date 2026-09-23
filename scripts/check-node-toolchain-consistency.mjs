#!/usr/bin/env node
/**
 * @module scripts/check-node-toolchain-consistency
 * @description Validates Node toolchain invariants: .node-version, CI workflow
 * node-version-file usage (direct setup-node calls AND local composite actions),
 * devEngines consistency, and package engines policy.
 *
 * DELIBERATELY DEPENDENCY-FREE: the CI `node-toolchain` job runs this script
 * without installing project dependencies, so the workflow/action analysis uses
 * a small line-based YAML scanner instead of a parser dependency.
 *
 * Every non-allow-listed workflow must prove a node-version-file reference
 * either directly on a setup-node step or through a local composite action
 * whose metadata (recursively) configures one; local actions that install Node
 * without a node-version-file fail closed.
 *
 * @version v2
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

const MATRIX_ALLOW_LIST = new Set(['node-compat.yml', 'release.yml']);

// ─── Line-based YAML scanning (no parser dependency) ────────────────────────

/**
 * Split a document into step blocks, one per `steps:` section (workflow job or
 * action metadata). The step-item indentation is discovered from the section
 * itself, so formatting differences between files are irrelevant. Nested list
 * items inside a step (for example a script block) are never mistaken for new
 * steps because they sit deeper than the section's item indent.
 *
 * @returns {Array<{ lines: string[], itemIndent: number }>}
 */
function splitStepBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const stepsMatch = /^(\s*)steps:\s*$/.exec(lines[index]);
    if (!stepsMatch) continue;
    const stepsIndent = stepsMatch[1].length;
    let itemIndent = null;
    let current = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') {
        if (current !== null) current.push(line);
        continue;
      }
      const indent = /^\s*/.exec(line)[0].length;
      if (indent <= stepsIndent) {
        if (current !== null) blocks.push({ lines: current, itemIndent });
        current = null;
        break;
      }
      if (/^\s*-\s+/.test(line)) {
        if (itemIndent === null) itemIndent = indent;
        if (indent === itemIndent) {
          if (current !== null) blocks.push({ lines: current, itemIndent });
          current = [line];
          continue;
        }
      }
      if (current !== null) current.push(line);
    }
    if (current !== null) blocks.push({ lines: current, itemIndent });
  }
  return blocks;
}

/** Value of a step key at the item-key indentation, supporting `- key: value`. */
function stepKeyValue(stepLines, key, keyIndent) {
  for (let index = 0; index < stepLines.length; index += 1) {
    const line = stepLines[index];
    if (index === 0) {
      const inline = new RegExp(`^\\s*-\\s+${key}:\\s*(.*)$`).exec(line);
      if (inline) return inline[1].trim();
      continue;
    }
    const match = new RegExp(`^\\s{${keyIndent}}${key}:\\s*(.*)$`).exec(line);
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Keys of the step's `with:` block (children indented below `with:`). */
function stepWithKeys(stepLines, keyIndent) {
  const keys = new Map();
  const withIndex = stepLines.findIndex((line) =>
    new RegExp(`^\\s{${keyIndent}}with:\\s*$`).test(line),
  );
  if (withIndex < 0) return keys;
  for (const line of stepLines.slice(withIndex + 1)) {
    const match = /^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1].length <= keyIndent) break;
    keys.set(match[2], match[3].trim());
  }
  return keys;
}

/** Setup-node configuration of a step, or null when the step is not setup-node. */
function setupNodeConfig(block) {
  const keyIndent = block.itemIndent + 2;
  const uses = stepKeyValue(block.lines, 'uses', keyIndent);
  if (typeof uses !== 'string' || !uses.startsWith('actions/setup-node')) return null;
  const withKeys = stepWithKeys(block.lines, keyIndent);
  const nodeVersion = withKeys.get('node-version');
  return {
    hasNodeVersionFile: withKeys.has('node-version-file'),
    staticVersion: nodeVersion !== undefined && !nodeVersion.includes('${{'),
  };
}

/**
 * Repository-relative paths are compared with `/` separators regardless of the
 * platform; `path.relative()` yields backslashes on Windows.
 */
function normalizeRel(rel) {
  return rel.replaceAll('\\', '/');
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
  return normalizeRel(rel).split('/').slice(0, -1).join('/');
}

function localActionProof(dir, actionByDir, visited) {
  if (visited.has(dir)) return { found: false, proof: false };
  visited.add(dir);
  const entry = actionByDir.get(dir);
  if (!entry) return { found: false, proof: false };
  let proof = false;
  for (const block of entry.steps) {
    const config = setupNodeConfig(block);
    if (config?.hasNodeVersionFile) proof = true;
    const nested = localActionDir(stepKeyValue(block.lines, 'uses', block.itemIndent + 2));
    if (nested !== null && localActionProof(nested, actionByDir, visited).proof) proof = true;
  }
  return { found: true, proof };
}

/**
 * Pure node-toolchain analysis over workflow and local-action YAML text.
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
      steps: splitStepBlocks(action.content),
    });
  }

  for (const entry of actionByDir.values()) {
    for (const block of entry.steps) {
      const config = setupNodeConfig(block);
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
    const fileName = basename(normalizeRel(workflow.file));
    if (MATRIX_ALLOW_LIST.has(fileName)) {
      if (fileName === 'release.yml' && !/node-version-file:/.test(workflow.content)) {
        errors.push('release.yml: missing node-version-file for build job');
      }
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
    for (const block of splitStepBlocks(workflow.content)) {
      const config = setupNodeConfig(block);
      if (config) {
        if (config.hasNodeVersionFile) directProof = true;
        else errors.push(`${fileName}: setup-node step without node-version-file`);
        if (config.staticVersion) {
          errors.push(`${fileName}: static node-version outside allow-listed matrix workflow`);
        }
      }
      const ref = localActionDir(stepKeyValue(block.lines, 'uses', block.itemIndent + 2));
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
        file: normalizeRel(relative(REPO_ROOT, path)),
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
