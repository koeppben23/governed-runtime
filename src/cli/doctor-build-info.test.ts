/**
 * @module cli/doctor-build-info.test
 * @description Tests for the doctor build-info / stale-dist check: detects an
 * installed dist whose build stamp is missing, unparseable, or version-mismatched
 * against the running package VERSION.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBuildInfo } from './doctor-build-info.js';
import { PACKAGE_VERSION, BUILD_INFO_CHECK } from './install-helpers.js';

describe('checkBuildInfo (stale-dist guard)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fg-doctor-buildinfo-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeBuildInfo(content: string): void {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'build-info.json'), content, 'utf-8');
  }

  describe('HAPPY', () => {
    it('reports ok when build-info version matches the package version', () => {
      writeBuildInfo(
        JSON.stringify({
          version: PACKAGE_VERSION(),
          gitSha: 'abc123',
          gitShaSource: 'git',
          builtAt: '2026-06-23T00:00:00.000Z',
        }),
      );
      const checks = checkBuildInfo(root);
      expect(checks).toHaveLength(1);
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).toBe('ok');
      expect(check.check).toBe(BUILD_INFO_CHECK);
      expect(check.detail).toContain('gitSha=abc123');
    });
  });

  describe('BAD', () => {
    it('flags a version mismatch as version_mismatch (stale dist)', () => {
      writeBuildInfo(
        JSON.stringify({
          version: '0.0.0-stale',
          gitSha: 'old',
          gitShaSource: 'git',
          builtAt: '2020-01-01T00:00:00.000Z',
        }),
      );
      const checks = checkBuildInfo(root);
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).toBe('version_mismatch');
      expect(check.check).toBe(BUILD_INFO_CHECK);
      expect(check.detail).toContain('stale dist');
    });

    it('flags a missing build-info.json as version_mismatch (predates stamping)', () => {
      // No file written.
      const checks = checkBuildInfo(root);
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).toBe('version_mismatch');
      expect(check.detail).toContain('missing');
    });
  });

  describe('CORNER', () => {
    it('flags unparseable JSON as an error', () => {
      writeBuildInfo('{ not json');
      const checks = checkBuildInfo(root);
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).toBe('error');
      expect(check.detail).toContain('not valid JSON');
    });

    it('flags a build-info without a string version as an error', () => {
      writeBuildInfo(JSON.stringify({ gitSha: 'x', builtAt: 'y' }));
      const checks = checkBuildInfo(root);
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).toBe('error');
      expect(check.detail).toContain('version');
    });
  });

  describe('EDGE', () => {
    it('treats any non-ok status as a doctor failure signal', () => {
      writeBuildInfo(JSON.stringify({ version: '0.0.0-stale' }));
      const checks = checkBuildInfo(root);
      // Doctor exit logic fails on any status !== 'ok' && !== 'warn'.
      const [check] = checks;
      if (!check) throw new TypeError('expected build-info check');
      expect(check.status).not.toBe('ok');
      expect(check.status).not.toBe('warn');
    });
  });
});
