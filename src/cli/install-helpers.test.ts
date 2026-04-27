/**
 * @module cli/install-helpers.test
 * @description Unit tests for install-helper functions — targets uncovered branches.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  mergePackageJson,
  mergeReviewerTaskPermission,
  PACKAGE_VERSION,
  sha256,
  vendorDependency,
} from './install-helpers.js';

describe('install-helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-install-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('PACKAGE_VERSION', () => {
    it('returns a non-empty string', () => {
      expect(PACKAGE_VERSION()).toBeTruthy();
      expect(PACKAGE_VERSION().length).toBeGreaterThan(0);
    });

    it('returns same value across multiple calls (cached)', () => {
      const a = PACKAGE_VERSION();
      const b = PACKAGE_VERSION();
      expect(a).toBe(b);
    });
  });

  describe('sha256', () => {
    it('returns deterministic hex digest', () => {
      expect(sha256('hello')).toBe(sha256('hello'));
    });

    it('returns different digests for different inputs', () => {
      expect(sha256('hello')).not.toBe(sha256('world'));
    });

    it('returns 64-char hex string', () => {
      expect(sha256('test')).toHaveLength(64);
    });
  });

  describe('vendorDependency', () => {
    it('returns file:-path with version', () => {
      const dep = vendorDependency('1.0.0');
      expect(dep).toBe('file:./vendor/flowguard-core-1.0.0.tgz');
    });
  });

  describe('mergePackageJson', () => {
    it('writes new package.json when file does not exist', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');

      const content = await fs.readFile(pkgPath, 'utf-8');
      expect(content).toContain('@flowguard/core');
    });

    it('merges into existing package.json', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      await fs.writeFile(pkgPath, JSON.stringify({ name: 'test' }));

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(content.name).toBe('test');
      expect(content.dependencies).toBeDefined();
      expect(content.dependencies['@flowguard/core']).toBeDefined();
    });

    it('handles malformed JSON by overwriting', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      // Covers catch block: malformed JSON → overwrite with template
      await fs.writeFile(pkgPath, '{ not valid json }');

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('malformed');

      const content = await fs.readFile(pkgPath, 'utf-8');
      expect(content).toContain('@flowguard/core');
    });
  });

  describe('mergeReviewerTaskPermission', () => {
    it('sets task permission to *.deny + flowguard-reviewer.allow', () => {
      const parsed = {};
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      const task = (parsed as Record<string, unknown>).agent as Record<string, unknown>;
      const build = task.build as Record<string, unknown>;
      const perm = build.permission as Record<string, unknown>;
      expect(perm.task).toEqual({ '*': 'deny', 'flowguard-reviewer': 'allow' });
    });

    it('handles empty agent config', () => {
      const parsed = {};
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      expect(parsed).toHaveProperty('agent');
    });

    it('handles partial config with existing agent but no build', () => {
      const parsed = { agent: { model: 'gpt-4' } as Record<string, unknown> };
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      const agent = parsed.agent as Record<string, unknown>;
      expect(agent.build).toBeDefined();
    });
  });
});
