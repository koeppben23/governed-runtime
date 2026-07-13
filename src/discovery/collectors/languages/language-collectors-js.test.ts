import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';
import { extractFromNodeVersionFiles } from './node.js';
import {
  extractFromTsConfig,
  extractFromPackageJson,
  refineBuildToolFromLockfiles,
  refineFromPackageManagerField,
} from './js-ecosystem.js';

function makeItem(id: string, overrides?: Partial<DetectedItem>): DetectedItem {
  return {
    id,
    confidence: 0.9,
    classification: 'derived_signal',
    evidence: ['detected'],
    ...overrides,
  };
}

function mockReadFile(files: Record<string, string>) {
  return async (path: string) => files[path];
}

describe('languages/node', () => {
  describe('HAPPY', () => {
    it('detects node version from .nvmrc', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '20.11.0\n' }), runtimes);
      expect(runtimes[0]!.version).toBe('20.11.0');
    });

    it('detects node version from .node-version', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.node-version': '18.17.1\n' }), runtimes);
      expect(runtimes[0]!.version).toBe('18.17.1');
    });
  });

  describe('BAD', () => {
    it('skips empty .nvmrc content', async () => {
      // Covers line 23: !version || !/^\d/.test(version)
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '\n' }), runtimes);
      expect(runtimes[0]!.version).toBeUndefined();
    });

    it('skips .nvmrc with non-numeric content', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': 'lts/iron\n' }), runtimes);
      expect(runtimes[0]!.version).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('skips when node already has a version set', async () => {
      const runtimes: DetectedItem[] = [
        makeItem('node', { version: '20.0.0', versionEvidence: 'prior' }),
      ];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '21.0.0\n' }), runtimes);
      expect(runtimes[0]!.version).toBe('20.0.0');
    });
  });

  describe('EDGE', () => {
    it('strips v prefix from node version', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': 'v20.11.0\n' }), runtimes);
      expect(runtimes[0]!.version).toBe('20.11.0');
    });
  });
});

describe('languages/js-ecosystem', () => {
  describe('extractFromPackageJson', () => {
    it('detects typescript from devDependencies', async () => {
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ devDependencies: { typescript: '^5.3' } }),
        }),
        languages,
        [],
        [],
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('5.3');
    });

    it('skips ts version enrichment when version already set', async () => {
      // Covers line 178: tsItem with existing version (false path of !tsItem.version)
      const languages: DetectedItem[] = [
        makeItem('typescript', { version: '5.4', versionEvidence: 'prior' }),
      ];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ devDependencies: { typescript: '^5.3' } }),
        }),
        languages,
        [],
        [],
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('5.4');
    });

    it('detects database from devDependencies only (not in deps)', async () => {
      // Covers line 192: devDeps-only DB detection using a real JS_DATABASE_DEPS entry (pg→postgresql)
      const databases: DetectedItem[] = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ devDependencies: { pg: '^8.11.0' } }),
        }),
        [],
        [],
        [],
        [],
        [],
        databases,
      );
      const pg = databases.find((d) => d.id === 'postgresql');
      expect(pg).toBeDefined();
      expect(pg?.evidence).toContain('package.json:devDependencies.pg');
    });
  });

  describe('extractFromTsConfig', () => {
    it('sets typescript compilerTarget from tsconfig.json', async () => {
      // Covers the full extractFromTsConfig function (lines 196-211)
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromTsConfig(
        mockReadFile({
          'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022' } }),
        }),
        languages,
      );
      expect(languages[0]!.compilerTarget).toBe('es2022');
      expect(languages[0]!.compilerTargetEvidence).toBe('tsconfig.json:compilerOptions.target');
    });

    it('does nothing when tsconfig.json is absent', async () => {
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromTsConfig(mockReadFile({}), languages);
      expect(languages[0]!.compilerTarget).toBeUndefined();
    });

    it('does nothing when tsconfig has no target property', async () => {
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromTsConfig(
        mockReadFile({ 'tsconfig.json': JSON.stringify({ compilerOptions: {} }) }),
        languages,
      );
      expect(languages[0]!.compilerTarget).toBeUndefined();
    });

    it('does not overwrite existing compilerTarget', async () => {
      const languages: DetectedItem[] = [
        makeItem('typescript', { compilerTarget: 'es2020', compilerTargetEvidence: 'prior' }),
      ];
      await extractFromTsConfig(
        mockReadFile({
          'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022' } }),
        }),
        languages,
      );
      expect(languages[0]!.compilerTarget).toBe('es2020');
    });
  });

  describe('extractFromPackageJson edge cases', () => {
    it('detects framework from dependencies with version', async () => {
      // Covers JS_ECOSYSTEM_DEPS framework detection path in deps
      const frameworks: DetectedItem[] = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ dependencies: { react: '^18.3.1' } }),
        }),
        [],
        frameworks,
        [],
        [],
        [],
        [],
      );
      expect(frameworks.find((f) => f.id === 'react')).toBeDefined();
    });

    it('detects database from dependencies when in deps (not devDeps)', async () => {
      // Covers the deps-only DB detection branch
      const databases: DetectedItem[] = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ dependencies: { mysql2: '^3.9.0' } }),
        }),
        [],
        [],
        [],
        [],
        [],
        databases,
      );
      const mysql = databases.find((d) => d.id === 'mysql');
      expect(mysql).toBeDefined();
      expect(mysql?.evidence).toContain('package.json:dependencies.mysql2');
    });

    it('detects node version from engines.node field', async () => {
      // Covers line 134: engines.node version detection
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ engines: { node: '>=20.0.0' } }),
        }),
        [],
        [],
        runtimes,
        [],
        [],
        [],
      );
      expect(runtimes[0]!.version).toBe('20.0.0');
    });

    it('detects react framework with version from dependencies', async () => {
      const frameworks: DetectedItem[] = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ dependencies: { vue: '^3.4.0' } }),
        }),
        [],
        frameworks,
        [],
        [],
        [],
        [],
      );
      expect(frameworks.find((f) => f.id === 'vue')).toBeDefined();
    });
  });

  describe('refineFromPackageManagerField', () => {
    it('detects pnpm from packageManager field', async () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      const result = await refineFromPackageManagerField(
        mockReadFile({
          'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
        }),
        buildTools,
      );
      expect(result).toBe(true);
      expect(buildTools[0]!.id).toBe('pnpm');
      expect(buildTools[0]!.version).toBe('9.0.0');
    });

    it('returns false when packageManager field is absent', async () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      const result = await refineFromPackageManagerField(
        mockReadFile({ 'package.json': JSON.stringify({}) }),
        buildTools,
      );
      expect(result).toBe(false);
    });

    it('enriches npm evidence from packageManager field', async () => {
      // Covers line 58: npmItem.evidence.includes check
      const buildTools: DetectedItem[] = [makeItem('npm', { evidence: [] })];
      await refineFromPackageManagerField(
        mockReadFile({
          'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }),
        }),
        buildTools,
      );
      expect(buildTools[0]!.version).toBe('10.0.0');
      expect(buildTools[0]!.evidence.length).toBeGreaterThan(0);
    });

    it('skips duplicate evidence when npm already has packageManager evidence', async () => {
      // Covers line 58 true branch: npmItem.evidence already contains the evidence
      const buildTools: DetectedItem[] = [
        makeItem('npm', { evidence: ['package.json:packageManager'] }),
      ];
      await refineFromPackageManagerField(
        mockReadFile({
          'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }),
        }),
        buildTools,
      );
      expect(buildTools[0]!.evidence).toHaveLength(1);
      expect(buildTools[0]!.version).toBe('10.0.0');
    });
  });

  describe('refineBuildToolFromLockfiles', () => {
    it('replaces npm with yarn when yarn.lock is present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles(['yarn.lock'], buildTools);
      expect(buildTools[0]!.id).toBe('yarn');
    });

    it('replaces npm with pnpm when pnpm-lock.yaml is present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles(['pnpm-lock.yaml'], buildTools);
      expect(buildTools[0]!.id).toBe('pnpm');
    });

    it('leaves npm when no lockfile is found', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles([], buildTools);
      expect(buildTools[0]!.id).toBe('npm');
    });

    it('adds package-lock.json evidence when present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { evidence: [] })];
      refineBuildToolFromLockfiles(['package-lock.json'], buildTools);
      expect(buildTools[0]!.id).toBe('npm');
      expect(buildTools[0]!.evidence).toContain('package-lock.json');
    });

    it('skips duplicate package-lock.json evidence', () => {
      // Covers line 106: npmItem.evidence already contains package-lock.json
      const buildTools: DetectedItem[] = [makeItem('npm', { evidence: ['package-lock.json'] })];
      refineBuildToolFromLockfiles(['package-lock.json'], buildTools);
      expect(buildTools[0]!.evidence).toHaveLength(1);
    });
  });
});
