#!/usr/bin/env node

/**
 * check-unused-exports.mjs
 *
 * Non-blocking PR hint: warn when a PR introduces NEW unused exports relative
 * to the committed baseline. Pure path/symbol diff — no semantic judgment.
 * Always exits 0. Baseline management is explicit:
 *
 *   node scripts/check-unused-exports.mjs --update [--baseline <path>]
 *
 * CI runs the comparison mode. The baseline documents the existing debt; it
 * shrinks only through explicit --update runs after cleanup commits.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASELINE = 'scripts/unused-exports-baseline.json';

/**
 * Diff current unused-export identities against the baseline.
 * Identity is `symbol@file` — line numbers are deliberately excluded so plain
 * code shifts do not masquerade as new findings; the line is display-only.
 */
export function diffUnusedExports(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    added: current.filter((entry) => !baselineSet.has(entry)),
    removed: baseline.filter((entry) => !currentSet.has(entry)),
  };
}

/** Collect the current unused-export identities via `knip --reporter json`. */
function collectCurrentExports() {
  let raw;
  try {
    raw = execFileSync('npx', ['knip', '--reporter', 'json'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    // knip exits non-zero on findings; stdout still carries the JSON.
    raw = err.stdout ?? '';
  }
  if (!raw || !raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    const identities = new Set();
    const lineOf = new Map();
    for (const issue of data.issues ?? []) {
      const file = issue.file;
      for (const entry of issue.exports ?? []) {
        const id = `${entry.name}@${file}`;
        identities.add(id);
        lineOf.set(id, entry.line);
      }
    }
    return { entries: [...identities].sort(), lineOf };
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const baselineFlag = args.indexOf('--baseline');
  const baselinePath =
    baselineFlag !== -1 && args[baselineFlag + 1]
      ? resolve(args[baselineFlag + 1])
      : resolve(DEFAULT_BASELINE);

  const current = collectCurrentExports();
  if (current === null) {
    console.log('Could not collect unused exports (knip unavailable or unparsable).');
    process.exit(0);
  }

  if (update) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ version: 2, entries: current.entries }, null, 1)}\n`,
    );
    console.log(`Baseline updated: ${current.entries.length} unused exports at ${baselinePath}`);
    process.exit(0);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).entries ?? [];
  } catch {
    baseline = [];
  }
  if (baseline.length === 0) {
    console.log(`No baseline at ${baselinePath}; run with --update to initialize it.`);
    process.exit(0);
  }

  const { added, removed } = diffUnusedExports(current.entries, baseline);
  if (added.length > 0) {
    const preview = added
      .slice(0, 10)
      .map((entry) => `  - ${entry}:${current.lineOf.get(entry) ?? '?'}`)
      .join('\n');
    console.log(
      `::warning::This PR introduces ${added.length} new unused export(s) ` +
        `(baseline has ${baseline.length}; ${removed.length} removed).\n${preview}`,
    );
  } else if (removed.length > 0) {
    console.log(
      `No new unused exports; ${removed.length} baseline entry(s) were cleaned up ` +
        `(consider --update to shrink the baseline).`,
    );
  } else {
    console.log('Unused exports unchanged against the baseline.');
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
