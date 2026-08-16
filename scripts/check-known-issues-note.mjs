#!/usr/bin/env node

/**
 * check-known-issues-note.mjs
 *
 * Non-blocking PR hint: when a PR changes trust-boundary code paths but does
 * not touch KNOWN_ISSUES.md, emit a workflow warning annotation. Pure
 * path-diff heuristic — no semantic understanding. Always exits 0.
 *
 * Usage: node scripts/check-known-issues-note.mjs <base-sha> <head-sha>
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WATCHED_PREFIXES = [
  'src/rails/',
  'src/integration/review/',
  'src/adapters/',
  'src/audit/proofgraph/',
];

const WARNING_MESSAGE =
  'This PR changes trust-boundary code paths (src/rails/, src/integration/review/, ' +
  'src/adapters/, src/audit/proofgraph/) but does not update KNOWN_ISSUES.md. ' +
  'Consider adding a dated section for new findings or changes.';

/**
 * Classify a list of changed files (from `git diff --name-only`). Rename
 * entries (`old => new`) are normalized to the new path.
 */
export function knownIssuesNoteForChangedFiles(changedFiles) {
  const normalized = changedFiles.map((file) => {
    const rename = file.split(' => ');
    return rename[rename.length - 1];
  });
  const touchesTrustBoundary = normalized.some((file) =>
    WATCHED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  const touchesKnownIssues = normalized.includes('KNOWN_ISSUES.md');
  if (touchesTrustBoundary && !touchesKnownIssues) {
    return { kind: 'warning', message: WARNING_MESSAGE };
  }
  if (touchesTrustBoundary) {
    return { kind: 'ok', message: 'KNOWN_ISSUES.md updated together with trust-boundary changes.' };
  }
  return { kind: 'skip', message: 'No trust-boundary paths changed.' };
}

function main() {
  const [, , base, head] = process.argv;
  if (!base || !head) {
    console.error('Usage: node scripts/check-known-issues-note.mjs <base-sha> <head-sha>');
    process.exit(0);
  }
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const result = knownIssuesNoteForChangedFiles(changed);
  if (result.kind === 'warning') {
    console.log(`::warning::${result.message}`);
  } else {
    console.log(result.message);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
