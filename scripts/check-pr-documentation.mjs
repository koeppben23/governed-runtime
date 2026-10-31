#!/usr/bin/env node
/**
 * Enforce the repository-wide every-PR changelog requirement.
 *
 * Usage: node scripts/check-pr-documentation.mjs <base-commit> <head-commit>
 *
 * Deliberately checks the PR's changed-file set, not the changelog contents or
 * PR checkbox. Semantic alignment of affected docs is a separate review duty.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validatePrDocumentation(changedFiles) {
  const files = new Set(changedFiles);
  return files.has('CHANGELOG.md')
    ? { ok: true, message: 'CHANGELOG.md updated in this PR; verify affected docs semantically.' }
    : {
        ok: false,
        message: 'Every PR must update CHANGELOG.md under [Unreleased]; no exemption.',
      };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('Usage: check-pr-documentation.mjs <base-sha> <head-sha>');
    process.exitCode = 2;
    return;
  }
  try {
    const changedFiles = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
    const result = validatePrDocumentation(changedFiles);
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error('Could not verify PR changelog diff:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
