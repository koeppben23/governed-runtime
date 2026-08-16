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

const WATCHED_PREFIXES = [
  'src/rails/',
  'src/integration/review/',
  'src/adapters/',
  'src/audit/proofgraph/',
];

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

const touchesTrustBoundary = changed.some((file) =>
  WATCHED_PREFIXES.some((prefix) => file.startsWith(prefix)),
);
const touchesKnownIssues = changed.includes('KNOWN_ISSUES.md');

if (touchesTrustBoundary && !touchesKnownIssues) {
  console.log(
    '::warning::This PR changes trust-boundary code paths (src/rails/, src/integration/review/, ' +
      'src/adapters/, src/audit/proofgraph/) but does not update KNOWN_ISSUES.md. ' +
      'Consider adding a dated section for new findings or changes.',
  );
} else if (touchesTrustBoundary) {
  console.log('KNOWN_ISSUES.md updated together with trust-boundary changes.');
} else {
  console.log('No trust-boundary paths changed.');
}

process.exit(0);
