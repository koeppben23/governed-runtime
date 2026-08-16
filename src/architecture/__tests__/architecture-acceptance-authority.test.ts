/**
 * @module architecture/architecture-acceptance-authority
 * @description Ensures only the explicit human review-decision rail can promote
 *              an ADR from proposed to accepted.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const HUMAN_APPROVAL_AUTHORITY = 'rails/review-decision.ts';
const FIXTURE_MODULE = 'fixtures.ts';
const ACCEPTED_STATUS_ASSIGNMENT = /status:\s*['"]accepted['"]/g;

function productionFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') productionFiles(path, files);
      continue;
    }
    if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

describe('architecture acceptance authority', () => {
  it('promotes architecture status to accepted only in the explicit human decision rail', () => {
    const violations = productionFiles(SRC_ROOT).flatMap((path) => {
      const relativePath = relative(SRC_ROOT, path).split(sep).join('/');
      if (relativePath === HUMAN_APPROVAL_AUTHORITY || relativePath === FIXTURE_MODULE) return [];
      const content = readFileSync(path, 'utf8');
      return [...content.matchAll(ACCEPTED_STATUS_ASSIGNMENT)].map((match) => ({
        path: relativePath,
        assignment: match[0],
      }));
    });

    expect(violations).toEqual([]);
  });

  it('has the explicit human decision authority', () => {
    const content = readFileSync(join(SRC_ROOT, HUMAN_APPROVAL_AUTHORITY), 'utf8');
    expect(content).toMatch(ACCEPTED_STATUS_ASSIGNMENT);
  });
});
