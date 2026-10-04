/**
 * @module scripts/__tests__/release-preflight
 * @description Negative-path contracts for the shared release-tag decisions.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateReleasePostTag,
  evaluateReleasePreTag,
  isPrereleaseVersion,
  validateReleaseTagName,
} from '../release-preflight.js';

const validPreTag = {
  tag: 'v2.0.0-tp.1',
  branch: 'main',
  clean: true,
  head: 'a'.repeat(40),
  originMain: 'a'.repeat(40),
  localTagExists: false,
  remoteTagExists: false,
  packageVersion: '2.0.0-tp.1',
  versionFile: '2.0.0-tp.1',
  changelogHasReleaseSection: true,
};

const validPostTag = {
  tag: 'v2.0.0-tp.1',
  refObjectType: 'tag',
  taggedCommit: 'b'.repeat(40),
  originMain: 'b'.repeat(40),
  verificationVerified: true,
  packageVersion: '2.0.0-tp.1',
  versionFile: '2.0.0-tp.1',
  changelogHasReleaseSection: true,
};

describe('scripts/release-preflight', () => {
  describe('tag name validation', () => {
    it('accepts release and prerelease tags', () => {
      expect(validateReleaseTagName('v2.0.0')).toBeNull();
      expect(validateReleaseTagName('v2.0.0-tp.1')).toBeNull();
      expect(validateReleaseTagName('v1.2.0-rc.4')).toBeNull();
    });

    it('rejects names without the v prefix, partial versions, and empty input', () => {
      expect(validateReleaseTagName('2.0.0')).not.toBeNull();
      expect(validateReleaseTagName('v2.0')).not.toBeNull();
      expect(validateReleaseTagName('')).not.toBeNull();
      expect(validateReleaseTagName(undefined)).not.toBeNull();
    });
  });

  describe('PRE-TAG', () => {
    it('passes on a clean main checkout without the tag', () => {
      expect(evaluateReleasePreTag(validPreTag)).toEqual([]);
    });

    it('fails when not on main', () => {
      expect(evaluateReleasePreTag({ ...validPreTag, branch: 'release/v2.0.0-tp.1' })).toContain(
        'release tags must be created from main, current branch is release/v2.0.0-tp.1',
      );
    });

    it('fails on a dirty working tree', () => {
      expect(evaluateReleasePreTag({ ...validPreTag, clean: false })).toContain(
        'working tree must be clean before tagging',
      );
    });

    it('fails when HEAD is not the current origin/main', () => {
      expect(evaluateReleasePreTag({ ...validPreTag, head: 'c'.repeat(40) })).toContain(
        'HEAD must equal origin/main before tagging',
      );
    });

    it('fails when the local or remote tag already exists', () => {
      expect(evaluateReleasePreTag({ ...validPreTag, localTagExists: true })).toContain(
        'local tag already exists: v2.0.0-tp.1',
      );
      expect(evaluateReleasePreTag({ ...validPreTag, remoteTagExists: true })).toContain(
        'remote tag already exists: v2.0.0-tp.1',
      );
    });

    it('fails on version drift and a missing changelog release section', () => {
      const failures = evaluateReleasePreTag({
        ...validPreTag,
        packageVersion: '2.0.0',
        changelogHasReleaseSection: false,
      });
      expect(failures).toContain('package.json and VERSION must both equal 2.0.0-tp.1');
      expect(failures).toContain('CHANGELOG.md must contain a dated [2.0.0-tp.1] release section');
    });
  });

  describe('POST-TAG', () => {
    it('passes on an annotated, verified tag at protected main', () => {
      expect(evaluateReleasePostTag(validPostTag)).toEqual([]);
    });

    it('fails on a lightweight tag', () => {
      expect(evaluateReleasePostTag({ ...validPostTag, refObjectType: 'commit' })).toContain(
        'release tag v2.0.0-tp.1 must be an annotated tag object (got commit)',
      );
    });

    it('fails when GitHub does not verify the signature', () => {
      expect(evaluateReleasePostTag({ ...validPostTag, verificationVerified: false })).toContain(
        'release tag v2.0.0-tp.1 must carry a GitHub-verified signature',
      );
    });

    it('fails when the tagged commit is not the current protected main commit', () => {
      expect(evaluateReleasePostTag({ ...validPostTag, taggedCommit: 'd'.repeat(40) })).toContain(
        'tagged commit must equal the current protected main commit',
      );
    });

    it('fails on version drift inside the tagged tree', () => {
      expect(evaluateReleasePostTag({ ...validPostTag, versionFile: '1.2.0-tp.2' })).toContain(
        'package.json and VERSION must both equal 2.0.0-tp.1',
      );
    });
  });

  describe('prerelease classification', () => {
    it('marks SemVer prerelease suffixes as GitHub prereleases', () => {
      expect(isPrereleaseVersion('v2.0.0-tp.1')).toBe(true);
      expect(isPrereleaseVersion('v1.2.0-rc.4')).toBe(true);
      expect(isPrereleaseVersion('v2.0.0')).toBe(false);
    });
  });
});
