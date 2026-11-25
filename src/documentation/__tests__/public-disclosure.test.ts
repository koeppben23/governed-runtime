/**
 * @module documentation/public-disclosure
 * @description Guard current public text against reintroducing company-specific
 * product or pilot references.
 *
 * This is a current-tree guard, not a history rewrite and not a secret scan.
 * The marker expression is encoded so this guard file does not itself republish
 * the markers and can be scanned like every other tracked text file.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPANY_MARKERS = Buffer.from(
  'YWRvcnN5c3xkYXRldnx0ZWFtW1s6c3BhY2U6XS1dKmJhbms=',
  'base64',
).toString('utf8');

describe('public disclosure guard', () => {
  it('keeps company-specific references out of the current public tree', () => {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(100);

    const result = spawnSync(
      'git',
      ['grep', '-n', '-I', '-i', '-E', COMPANY_MARKERS, '--', ':(exclude)package-lock.json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    const matches = sanitizeMatches(result.stdout ?? '');
    expect(
      result.status,
      matches.length > 0
        ? `Company-specific markers reappeared in current public text:\n${matches.join('\n')}`
        : result.stderr,
    ).toBe(1);
  });
});

function sanitizeMatches(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(':', 2).join(':'));
}
