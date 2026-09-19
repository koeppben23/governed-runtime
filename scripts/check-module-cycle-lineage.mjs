#!/usr/bin/env node

/**
 * check-module-cycle-lineage.mjs
 *
 * Monotonic lineage guard for the module-level cycle-debt baseline.
 *
 * `test:architecture` proves that the observed cyclic module-edge set equals
 * `scripts/module-cycle-baseline.json` exactly. That snapshot alone could be
 * laundered by editing code and baseline together in one pull request, so this
 * check additionally compares the head baseline against the baseline of the
 * pull-request base commit: the debt set may only shrink.
 *
 * Contract:
 * - the base commit must resolve (`git rev-parse --verify <sha>^{commit}`);
 * - a base commit WITHOUT the baseline file is the one-time bootstrap case and
 *   passes (the base commit itself must exist — an invalid/unfetched SHA fails
 *   closed);
 * - every head baseline edge must already exist in the base baseline;
 *   removed edges are the improvement this ratchet is designed to lock in.
 *
 * The check is read-only. Reducing the baseline is a manual, visible edit that
 * both this lineage guard and the architecture snapshot enforce.
 *
 * Usage:
 *   node scripts/check-module-cycle-lineage.mjs                 # schema check
 *   node scripts/check-module-cycle-lineage.mjs --against <sha> # CI lineage
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'module-cycle-baseline.json');
const BASELINE_REPO_PATH = 'scripts/module-cycle-baseline.json';

export const BASELINE_VERSION = 1;

/** Deduplicated identity of a directed module edge. */
export function edgeKey(from, to) {
  return `${from}\u0000${to}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate the cycle-baseline contract. Fails closed on structural drift,
 * unknown fields, duplicate edges, and self edges.
 */
export function validateCycleBaseline(baseline) {
  if (baseline === null || typeof baseline !== 'object') return ['baseline is not an object'];
  const problems = [];
  if (baseline.version !== BASELINE_VERSION) {
    problems.push(`unsupported baseline version ${String(baseline.version)}`);
  }
  if (!Array.isArray(baseline.edges)) {
    problems.push('baseline edges is not an array');
    return problems;
  }
  const seen = new Set();
  for (const edge of baseline.edges) {
    if (
      edge === null ||
      typeof edge !== 'object' ||
      !isNonEmptyString(edge.from) ||
      !isNonEmptyString(edge.to)
    ) {
      problems.push('malformed baseline edge entry');
      continue;
    }
    if (edge.from === edge.to) {
      problems.push(`self edge is not a cycle debt: ${edge.from}`);
      continue;
    }
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) {
      problems.push(`duplicate baseline edge: ${edge.from} -> ${edge.to}`);
    }
    seen.add(key);
  }
  return problems;
}

/**
 * Monotonic lineage: the head baseline may only remove edges relative to the
 * base baseline. Returns the head edges that the base did not contain.
 */
export function checkCycleLineage(baseBaseline, headBaseline) {
  const baseEdges = new Set((baseBaseline.edges ?? []).map((edge) => edgeKey(edge.from, edge.to)));
  const violations = [];
  for (const edge of headBaseline.edges ?? []) {
    if (!baseEdges.has(edgeKey(edge.from, edge.to))) {
      violations.push({ kind: 'new-cycle-edge', from: edge.from, to: edge.to });
    }
  }
  return violations;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function readHeadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `baseline missing at ${path.relative(REPO_ROOT, BASELINE_PATH)}; commit the baseline first`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

/** Resolve a commit and read its baseline; `null` when absent at that commit. */
function readBaselineAtCommit(sha) {
  execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${BASELINE_REPO_PATH}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch {
    return null;
  }
  const raw = execFileSync('git', ['show', `${sha}:${BASELINE_REPO_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

function parseCliOptions(argv) {
  const options = { against: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--against') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('--against requires a base commit SHA');
      }
      options.against = value;
      i += 1;
    } else {
      throw new Error(`unsupported argument '${argument}'`);
    }
  }
  return options;
}

function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const headBaseline = readHeadBaseline();
  const headProblems = validateCycleBaseline(headBaseline);
  if (headProblems.length > 0) {
    console.error(`[module-cycle-lineage] ERROR: invalid baseline: ${headProblems.join('; ')}`);
    process.exit(1);
  }
  console.log(
    `[module-cycle-lineage] OK: baseline has ${headBaseline.edges.length} cyclic edges`,
  );

  if (options.against === undefined) return;

  let baseBaseline;
  try {
    baseBaseline = readBaselineAtCommit(options.against);
  } catch (error) {
    console.error(
      `[module-cycle-lineage] ERROR: cannot read base commit '${options.against}': ${
        error instanceof Error ? error.message : String(error)
      } (is the base commit fetched? CI checkouts need fetch-depth: 0 for --against)`,
    );
    process.exit(1);
  }
  if (baseBaseline === null) {
    console.log(
      `[module-cycle-lineage] bootstrap: base commit ${options.against} has no cycle baseline yet`,
    );
    return;
  }
  const baseProblems = validateCycleBaseline(baseBaseline);
  if (baseProblems.length > 0) {
    console.error(
      `[module-cycle-lineage] ERROR: invalid base baseline: ${baseProblems.join('; ')}`,
    );
    process.exit(1);
  }
  const violations = checkCycleLineage(baseBaseline, headBaseline);
  if (violations.length > 0) {
    console.error(
      `[module-cycle-lineage] lineage vs ${options.against} may only remove cycle debt ` +
        `(${violations.length} violation(s)):`,
    );
    for (const violation of violations) {
      console.error(`  - NEW CYCLE EDGE ${violation.from} -> ${violation.to}`);
    }
    process.exit(1);
  }
  console.log(`[module-cycle-lineage] lineage OK vs ${options.against}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `[module-cycle-lineage] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
