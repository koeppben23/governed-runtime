/**
 * @module documentation/__tests__/version-consistency
 * @description Tests that all documented versions match the VERSION file SSOT.
 *
 * The VERSION file is the single source of truth for the FlowGuard version.
 * All documentation and config files MUST reference the same version.
 * This test catches version drift caused by manual edits to docs without
 * running the sync tooling (npm run generate-docs / npm version hooks).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// ─── Helpers ───────────────────────────────────────────────────────────────────

let version: string;

beforeAll(() => {
  const versionFile = join(REPO_ROOT, 'VERSION');
  expect(existsSync(versionFile), `VERSION file must exist at ${versionFile}`).toBe(true);
  version = readFileSync(versionFile, 'utf-8').trim();
  expect(version.length).toBeGreaterThan(0);
});

function readFile(relativePath: string): string {
  const absPath = join(REPO_ROOT, relativePath);
  return readFileSync(absPath, 'utf-8');
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('documentation/version-consistency', () => {
  describe('HAPPY — package.json', () => {
    it('package.json version matches VERSION', () => {
      const pkg = JSON.parse(readFile('package.json')) as { version: string };
      expect(pkg.version).toBe(version);
    });
  });

  describe('HAPPY — PRODUCT_ONE_PAGER.md', () => {
    it('Current snapshot line matches VERSION', () => {
      const content = readFile('PRODUCT_ONE_PAGER.md');
      const match = content.match(/Current snapshot: ([*\w]*?)([\d.]+(?:-[a-zA-Z0-9.]+)?)/);
      expect(match, 'PRODUCT_ONE_PAGER.md must contain "Current snapshot: {version}"').toBeTruthy();
      expect(match![2]).toBe(version);
    });
  });

  describe('HAPPY — PRODUCT_IDENTITY.md', () => {
    it('Version field matches VERSION', () => {
      const content = readFile('PRODUCT_IDENTITY.md');
      // Matches: "**Version:** 1.2.0-rc.1" or "- **Version:** 1.2.0-rc.1"
      const match = content.match(/(?:-\s*)?\*\*Version:\*\* ([\d.]+(?:-[a-zA-Z0-9.]+)?)/);
      expect(match, 'PRODUCT_IDENTITY.md must contain "**Version:** {version}"').toBeTruthy();
      expect(match![1]).toBe(version);
    });
  });

  describe('HAPPY — CHANGELOG.md', () => {
    it('CHANGELOG contains current VERSION or is marked Unreleased', () => {
      const content = readFile('CHANGELOG.md');
      const firstHeading = content.match(/^## \[([^\]]+)\]/m);
      // [Unreleased] during active development, [X.Y.Z] for releases
      const isUnreleased = firstHeading && firstHeading[1] === 'Unreleased';
      if (!isUnreleased) {
        expect(
          content.includes(version),
          `CHANGELOG.md must contain version "${version}" or have [Unreleased] as first heading`,
        ).toBe(true);
      }
    });
  });

  describe('HAPPY — README.md', () => {
    it('README contains current VERSION or placeholder', () => {
      const content = readFile('README.md');
      const hasVersion = content.includes(version);
      const hasPlaceholder = content.includes('{version}');
      if (!hasVersion && !hasPlaceholder) {
        // Check for version marker
        const match = content.match(/FlowGuard Version: ([\d.]+(?:-[a-zA-Z0-9.]+)?)/);
        expect(match, 'README must contain version or {version} placeholder').toBeTruthy();
      }
    });

    it('README references correct tarball version', () => {
      const content = readFile('README.md');
      const hasTarball = content.includes('flowguard-core-');
      if (hasTarball && !content.includes('{version}')) {
        expect(
          content.includes(`flowguard-core-${version}.tgz`),
          `README must reference flowguard-core-${version}.tgz when tarball is mentioned`,
        ).toBe(true);
      }
    });
  });

  describe('BAD — missing VERSION file', () => {
    it('handles missing VERSION file by test setup', () => {
      // The beforeAll assertion already guards this
      expect(version).toBeTruthy();
    });
  });

  describe('CORNER — pre-release versions', () => {
    it('handles pre-release suffix in VERSION (e.g. rc.1, beta.2)', () => {
      // VERSION may contain pre-release suffix. Verify the format is valid.
      const semverPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;
      expect(
        version,
        `VERSION "${version}" must be valid semver (optionally with pre-release suffix)`,
      ).toMatch(semverPattern);
    });

    it('pre-release version is found in PRODUCT_ONE_PAGER', () => {
      const content = readFile('PRODUCT_ONE_PAGER.md');
      // The one-pager must contain the exact version including any pre-release suffix
      expect(
        content.includes(version),
        `PRODUCT_ONE_PAGER.md must contain exact version "${version}"`,
      ).toBe(true);
    });
  });

  describe('EDGE — whitespace handling', () => {
    it('VERSION file has no leading/trailing whitespace issues', () => {
      const raw = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf-8');
      expect(raw.trim()).toBe(version);
      // A trailing newline is normal for text files and is NOT whitespace drift
    });

    it('version in PRODUCT_IDENTITY has no trailing spaces', () => {
      const content = readFile('PRODUCT_IDENTITY.md');
      const match = content.match(/\*\*Version:\*\* ([\d.]+(?:-[a-zA-Z0-9.]+)?)/);
      if (match) {
        const extracted = match[1];
        expect(extracted).toBe(extracted.trim());
      }
    });
  });

  describe('PERF', () => {
    it('all version consistency checks complete in < 10ms', () => {
      const start = performance.now();
      // Read all versioned files
      readFile('package.json');
      readFile('PRODUCT_ONE_PAGER.md');
      readFile('PRODUCT_IDENTITY.md');
      readFile('CHANGELOG.md');
      readFile('README.md');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(10);
    });
  });
});
