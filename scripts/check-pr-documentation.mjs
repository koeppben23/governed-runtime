#!/usr/bin/env node
/**
 * Enforce the repository-wide every-PR changelog requirement.
 *
 * Usage: node scripts/check-pr-documentation.mjs <base-commit> <head-commit>
 *
 * Compare committed Unreleased entries against the PR merge base, not the
 * working tree or the current base tip. Semantic accuracy remains a review duty.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CATEGORIES = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

/** Parse the repository's categorized, top-level bullet-entry changelog format. */
function unreleasedEntries(content) {
  if (typeof content !== 'string') return null;
  const text = content.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const sections = [...text.matchAll(/^## (.+)$/gm)];
  const unreleased = sections.filter((match) => match[1].trim() === '[Unreleased]');
  if (unreleased.length !== 1 || sections[0] !== unreleased[0]) return null;
  const start = unreleased[0].index + unreleased[0][0].length;
  const end = sections[1]?.index ?? text.length;
  const entries = [];
  const categories = new Set();
  let entry = [];
  const flush = () => {
    const value = entry.join(' ').replace(/\s+/g, ' ').trim();
    if (value) entries.push(value);
    entry = [];
  };
  for (const line of text.slice(start, end).split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      flush();
      const category = heading[1].trim();
      if (!CATEGORIES.has(category) || categories.has(category)) return null;
      categories.add(category);
    } else if (/^-\s/.test(line)) {
      if (categories.size === 0) return null;
      flush();
      entry.push(line.slice(2));
    } else if (entry.length > 0) {
      entry.push(line);
    } else if (line.trim()) {
      return null;
    }
  }
  flush();
  return entries;
}

export function validatePrDocumentation(baseChangelog, headChangelog) {
  const previous = unreleasedEntries(baseChangelog);
  const current = unreleasedEntries(headChangelog);
  if (previous === null || current === null) {
    return { ok: false, message: 'Missing or malformed categorized [Unreleased] changelog.' };
  }
  const existing = new Set(previous);
  return current.some((entry) => !existing.has(entry))
    ? { ok: true, message: 'Unreleased entry added or revised; verify semantic alignment.' }
    : {
        ok: false,
        message: 'Every PR must add or revise a nonempty [Unreleased] entry; no exemption.',
      };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head || process.argv.length !== 4) {
    console.error('Usage: check-pr-documentation.mjs <base-sha> <head-sha>');
    process.exitCode = 2;
    return;
  }
  try {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const baseCommit = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
    const headCommit = git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]);
    const mergeBase = git(['merge-base', baseCommit, headCommit]);
    const result = validatePrDocumentation(
      git(['show', `${mergeBase}:CHANGELOG.md`]),
      git(['show', `${headCommit}:CHANGELOG.md`]),
    );
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      'Could not verify PR changelog diff:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
