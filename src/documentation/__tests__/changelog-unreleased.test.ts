/**
 * @module documentation/__tests__/changelog-unreleased
 * @description Guard for CHANGELOG.md section structure.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v2 (P10b: updated for rc.2 section while keeping Unreleased guard)
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

function rc2Section(): string {
  const marker = '## [1.2.0-rc.2] - 2026-05-03\n';
  const afterMarker = readChangelog().split(marker)[1];
  expect(afterMarker, 'CHANGELOG.md must contain a [1.2.0-rc.2] section').toBeTruthy();
  return afterMarker!.split(/\n## \[/)[0];
}

describe('documentation/changelog-sections', () => {
  describe('HAPPY — Unreleased and rc.2 sections exist', () => {
    it('starts with the Unreleased heading after the preamble', () => {
      expect(readChangelog()).toMatch(/^## \[Unreleased\]/m);
    });

    it('contains a [1.2.0-rc.2] section', () => {
      expect(readChangelog()).toContain('## [1.2.0-rc.2] - 2026-05-03');
    });

    it('contains a [1.2.0-rc.1] referrer section', () => {
      expect(readChangelog()).toContain('## [1.2.0-rc.1] - 2026-04-23');
    });
  });

  describe('BAD — current Unreleased work must be represented', () => {
    it('documents P10b rail unit tests in Unreleased', () => {
      const section = unreleasedSection();
      expect(section).toContain('Rail unit tests for 6 untested rails (P10b)');
    });
  });

  describe('CORNER — rc.2 entries are categorized', () => {
    it('places the PR-0b entry under Added in rc.2 section', () => {
      const section = rc2Section();
      const addedSection = section.match(/### Added\n([\s\S]*?)(?=\n### |$)/);
      expect(addedSection, 'rc.2 must contain an Added category').toBeTruthy();
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
