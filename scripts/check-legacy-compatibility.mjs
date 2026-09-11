#!/usr/bin/env node

/**
 * Reject explicit legacy/backward-compatibility production paths on the FlowGuard
 * implementation surface changed by a pull request.
 *
 * This is repository-development enforcement only. It excludes tests, fixtures,
 * downstream code, and comment-only prose. Product templates are production
 * authority and therefore remain inside the guard.
 *
 * Usage:
 *   node scripts/check-legacy-compatibility.mjs <base-sha> <head-sha>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [base, head] = process.argv.slice(2);

if (!base || !head) {
  console.error('Usage: node scripts/check-legacy-compatibility.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const EXCLUDED_PATH_PARTS = [
  '/__tests__/',
  '/test/',
  '/tests/',
  '/testing/',
  '/testdata/',
  '/fixtures/',
];
const EXCLUDED_FILE_PATTERNS = [/\.test\.[cm]?[jt]sx?$/u, /\.spec\.[cm]?[jt]sx?$/u];

const LEGACY_MARKERS = [
  /\bbackwards? compatibility\b/giu,
  /\blegacy compatibility\b/giu,
  /\blegacy[- ]tolerant\b/giu,
  /\bcompatibility (?:shim|alias|fallback|adapter|re-export|projection|entry point)\b/giu,
  /\b(?:retained|kept|re-exported|re-exports?) for compatibility\b/giu,
];

function isProductionFlowGuardImplementation(path) {
  if (!path.startsWith('src/')) return false;
  if (!/\.[cm]?[jt]sx?$/u.test(path)) return false;
  if (EXCLUDED_PATH_PARTS.some((part) => path.includes(part))) return false;
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(path))) return false;
  return true;
}

function changedFiles() {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', base, head, '--', 'src'],
    { encoding: 'utf8' },
  );
  return output
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .filter(isProductionFlowGuardImplementation);
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function isCommentOnlyMatch(content, index) {
  const lineStart = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const prefix = content.slice(lineStart, index).trimStart();
  return prefix.startsWith('//') || prefix.startsWith('/*') || prefix.startsWith('*');
}

const findings = [];

for (const path of changedFiles()) {
  const content = readFileSync(path, 'utf8');
  for (const marker of LEGACY_MARKERS) {
    marker.lastIndex = 0;
    for (const match of content.matchAll(marker)) {
      const index = match.index ?? 0;
      if (isCommentOnlyMatch(content, index)) continue;
      findings.push({
        path,
        line: lineNumberAt(content, index),
        text: match[0],
      });
    }
  }
}

if (findings.length > 0) {
  console.error('Legacy/backward-compatibility implementation remains on the changed FlowGuard surface:');
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}: ${JSON.stringify(finding.text)}`);
  }
  console.error(
    '\nRemove the compatibility path and update affected callers/tests/docs to the current canonical contract. ' +
      'Tests, fixtures, and comment-only prose are intentionally outside this repository-only guard.',
  );
  process.exit(1);
}

console.log('No explicit legacy/backward-compatibility implementation markers found in changed FlowGuard source.');
