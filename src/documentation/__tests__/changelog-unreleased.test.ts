/**
 * @module documentation/__tests__/changelog-unreleased
 * @description Guard for current-work entries in CHANGELOG.md Unreleased section.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readChangelog(): string {
  return readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
}

function unreleasedSection(): string {
  const marker = '## [Unreleased]\n';
  const afterMarker = readChangelog().split(marker)[1];
  expect(afterMarker, 'CHANGELOG.md must contain an [Unreleased] section').toBeTruthy();
  return afterMarker!.split(/\n## \[/)[0];
}

describe('documentation/changelog-unreleased', () => {
  describe('HAPPY — Unreleased is the active section', () => {
    it('starts with the Unreleased heading after the preamble', () => {
      expect(readChangelog()).toMatch(/^## \[Unreleased\]/m);
    });
  });

  describe('BAD — current PR work must be represented', () => {
    it('documents PR-0b documentation drift guards in Unreleased', () => {
      const section = unreleasedSection();
      expect(section).toContain('Documentation drift guards (PR-0b)');
      expect(section).toContain('runtime SSOTs');
    });
  });

  describe('CORNER — entry is categorized', () => {
    it('places the PR-0b entry under an allowed Keep a Changelog category', () => {
      const section = unreleasedSection();
      const addedSection = section.match(/### Added\n([\s\S]*?)(?=\n### |$)/);
      expect(addedSection, 'Unreleased must contain an Added category').toBeTruthy();
      expect(addedSection![1]).toContain('Documentation drift guards (PR-0b)');
    });
  });

  describe('EDGE — category headings are known', () => {
    it('uses only Keep a Changelog category headings in Unreleased', () => {
      const allowed = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
      const headings = Array.from(
        unreleasedSection().matchAll(/^### (.+)$/gm),
        (match) => match[1],
      );
      expect(headings.length).toBeGreaterThan(0);
      expect(headings.filter((heading) => !allowed.has(heading))).toEqual([]);
    });
  });
});
