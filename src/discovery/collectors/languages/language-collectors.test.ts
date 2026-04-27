/**
 * @module discovery/collectors/languages/language-collectors.test
 * @description Unit tests for per-language detection functions extracted from stack-detection.ts.
 *
 * Targets uncovered branches from the extraction refactor.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';

import { extractFromGoMod } from './go.js';
import { extractFromNodeVersionFiles } from './node.js';
import { extractFromPythonRootFiles } from './python.js';
import { extractFromRustRootFiles } from './rust.js';
import {
  extractFromTsConfig,
  extractFromPackageJson,
  refineBuildToolFromLockfiles,
  refineFromPackageManagerField,
} from './js-ecosystem.js';
import {
  extractFromPomXml,
  extractFromGradleBuild,
  enrichFrameworkVersion,
  enrichRuntimeVersion,
  extractDatabasesFromDockerCompose,
  extractArtifactsFromPomXml,
} from './java.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

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

// ─── go.ts ─────────────────────────────────────────────────────────────────────

describe('languages/go', () => {
  describe('HAPPY', () => {
    it('sets go version from go.mod', async () => {
      const languages: DetectedItem[] = [makeItem('go')];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n\ngo 1.23\n' }), languages, [
        'go.mod',
      ]);
      expect(languages[0].version).toBe('1.23');
      expect(languages[0].versionEvidence).toBe('go.mod:go');
    });
  });

  describe('BAD', () => {
    it('does nothing when go.mod has no version line', async () => {
      // Covers line 24: if (!goVer) return
      const languages: DetectedItem[] = [makeItem('go')];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n' }), languages, ['go.mod']);
      expect(languages[0].version).toBeUndefined();
    });

    it('does not overwrite existing go version', async () => {
      // Covers line 27: goItem && !goItem.version (false path)
      const languages: DetectedItem[] = [
        makeItem('go', { version: '1.22', versionEvidence: 'prior' }),
      ];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n\ngo 1.23\n' }), languages, [
        'go.mod',
      ]);
      expect(languages[0].version).toBe('1.22');
    });
  });

  describe('CORNER', () => {
    it('removes cargo when Cargo.toml is absent', async () => {
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(mockReadFile({}), ['src/main.rs'], [], [], buildTools);
      expect(buildTools.find((t) => t.id === 'cargo')).toBeUndefined();
    });

    it('keeps cargo when Cargo.toml is present', async () => {
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': '[package]\nname = "test"\n',
        }),
        ['Cargo.toml'],
        [],
        [],
        buildTools,
      );
      expect(buildTools.find((t) => t.id === 'cargo')).toBeDefined();
    });

    it('does nothing when rust-toolchain.toml has no channel', async () => {
      // Covers line 47: rust && !rust.version when channel is absent
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBeUndefined();
    });

    it('does nothing when rust-toolchain.toml has no components block', async () => {
      // Covers line 64: components regex returns null
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools).toHaveLength(0);
    });

    it('skips clippy when components block does not contain clippy', async () => {
      // Covers lines 69-72: components match for clippy false, rustfmt true
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "stable"
components = ["rustfmt"]
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'clippy')).toBeUndefined();
      expect(qualityTools.find((t) => t.id === 'rustfmt')).toBeDefined();
    });

    it('skips rust-toolchain.toml when file is empty', async () => {
      // Covers line 43: content null branch (safeRead returns empty/undefined)
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({}),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBeUndefined();
    });

    it('does not overwrite rust version when already set from toolchain', async () => {
      // Covers line 47: rust && !rust.version false path
      const languages: DetectedItem[] = [
        makeItem('rust', { version: '1.76.0', versionEvidence: 'prior' }),
      ];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "1.77.0"
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBe('1.76.0');
    });
  });
});

// ─── node.ts ───────────────────────────────────────────────────────────────────

describe('languages/node', () => {
  describe('HAPPY', () => {
    it('detects node version from .nvmrc', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '20.11.0\n' }), runtimes, [
        '.nvmrc',
      ]);
      expect(runtimes[0].version).toBe('20.11.0');
    });

    it('detects node version from .node-version', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.node-version': '18.17.1\n' }), runtimes, [
        '.node-version',
      ]);
      expect(runtimes[0].version).toBe('18.17.1');
    });
  });

  describe('BAD', () => {
    it('skips empty .nvmrc content', async () => {
      // Covers line 23: !version || !/^\d/.test(version)
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '\n' }), runtimes, ['.nvmrc']);
      expect(runtimes[0].version).toBeUndefined();
    });

    it('skips .nvmrc with non-numeric content', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': 'lts/iron\n' }), runtimes, [
        '.nvmrc',
      ]);
      expect(runtimes[0].version).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('skips when node already has a version set', async () => {
      const runtimes: DetectedItem[] = [
        makeItem('node', { version: '20.0.0', versionEvidence: 'prior' }),
      ];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '21.0.0\n' }), runtimes, [
        '.nvmrc',
      ]);
      expect(runtimes[0].version).toBe('20.0.0');
    });
  });

  describe('EDGE', () => {
    it('strips v prefix from node version', async () => {
      const runtimes: DetectedItem[] = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': 'v20.11.0\n' }), runtimes, [
        '.nvmrc',
      ]);
      expect(runtimes[0].version).toBe('20.11.0');
    });
  });
});

// ─── python.ts ─────────────────────────────────────────────────────────────────

describe('languages/python', () => {
  describe('HAPPY', () => {
    it('detects pytest from requirements.txt', async () => {
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({ 'requirements.txt': 'pytest>=7.0\n' }),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks.find((t) => t.id === 'pytest')).toBeDefined();
    });

    it('detects python version from .python-version', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': '3.12.2\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0].version).toBe('3.12.2');
    });
  });

  describe('EDGE', () => {
    it('detects python version with python- prefix in .python-version', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': 'python-3.11.9\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0].version).toBe('3.11.9');
    });

    it('does nothing when .python-version has no recognizable version', async () => {
      // Covers line 35: version match returns null (non-numeric content)
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': 'system\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0].version).toBeUndefined();
    });

    it('detects black as quality tool from requirements.txt', async () => {
      const qualityTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({ 'requirements.txt': 'black>=23.0' }),
        ['requirements.txt'],
        [],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'black')).toBeDefined();
    });

    it('detects ruff from pyproject.toml', async () => {
      const qualityTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[tool.ruff]\nline-length = 100\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'ruff')).toBeDefined();
    });

    it('detects python version from pyproject.toml requires-python', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[project]\nrequires-python = ">=3.9"\n',
        }),
        ['pyproject.toml'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0].version).toBe('3.9');
    });

    it('skips non-root files for detection', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['subdir/requirements.txt'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });
  });

  describe('pyproject.toml poetry detection', () => {
    it('detects poetry from pyproject.toml', async () => {
      // Covers line 79: pyproject.toml poetry detection
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[tool.poetry]\nname = "test"\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      const poetry = buildTools.find((t) => t.id === 'poetry');
      expect(poetry).toBeDefined();
      expect(poetry?.evidence).toContain('pyproject.toml:[tool.poetry]');
    });

    it('does not detect poetry when pyproject.toml has no poetry section', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[project]\nname = "test"\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      const poetry = buildTools.find((t) => t.id === 'poetry');
      expect(poetry).toBeUndefined();
    });

    it('does nothing when pyproject.toml content is null', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });

    it('does nothing when requirements.txt content is null', async () => {
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks).toHaveLength(0);
    });

    it('does nothing when pyproject.toml content is null', async () => {
      // Covers line 43: content null check
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });

    it('does nothing when requirements.txt content is null', async () => {
      // Covers line 67: content null check
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks).toHaveLength(0);
    });
  });
});

// ─── rust.ts ───────────────────────────────────────────────────────────────────

describe('languages/rust', () => {
  describe('HAPPY', () => {
    it('detects rust version from rust-toolchain.toml channel', async () => {
      // Covers line 47: channel detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\nchannel = "1.77.0"\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBe('1.77.0');
    });

    it('detects clippy and rustfmt from rust-toolchain.toml components', async () => {
      // Covers lines 53-57: components detection
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'clippy')).toBeDefined();
      expect(qualityTools.find((t) => t.id === 'rustfmt')).toBeDefined();
    });

    it('detects rust version from plain rust-toolchain file', async () => {
      // Covers lines 64-75: plain rust-toolchain detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({ 'rust-toolchain': '1.76.0\n' }),
        ['rust-toolchain', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBe('1.76.0');
    });
  });

  describe('CORNER', () => {
    it('detects rust edition from Cargo.toml', async () => {
      // Covers line 31-36: edition detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': `[package]
name = "test"
edition = "2021"
`,
        }),
        ['Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].compilerTarget).toBe('2021');
    });

    it('does not overwrite existing rust edition', async () => {
      const languages: DetectedItem[] = [
        makeItem('rust', { compilerTarget: '2018', compilerTargetEvidence: 'prior' }),
      ];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': `[package]
name = "test"
edition = "2021"
`,
        }),
        ['Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].compilerTarget).toBe('2018');
    });

    it('removes cargo when Cargo.toml is absent', async () => {
      // Covers line 82: cargo removal
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(mockReadFile({}), ['src/main.rs'], [], [], buildTools);
      expect(buildTools.find((t) => t.id === 'cargo')).toBeUndefined();
    });

    it('keeps cargo when Cargo.toml is present', async () => {
      // Covers the happy branch of !rootFiles.has('Cargo.toml')
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': '[package]\nname = "test"\n',
        }),
        ['Cargo.toml'],
        [],
        [],
        buildTools,
      );
      expect(buildTools.find((t) => t.id === 'cargo')).toBeDefined();
    });
  });
});

// ─── js-ecosystem.ts ───────────────────────────────────────────────────────────

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
      expect(languages[0].version).toBe('5.3');
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
      expect(languages[0].version).toBe('5.4');
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
      expect(languages[0].compilerTarget).toBe('es2022');
      expect(languages[0].compilerTargetEvidence).toBe('tsconfig.json:compilerOptions.target');
    });

    it('does nothing when tsconfig.json is absent', async () => {
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromTsConfig(mockReadFile({}), languages);
      expect(languages[0].compilerTarget).toBeUndefined();
    });

    it('does nothing when tsconfig has no target property', async () => {
      const languages: DetectedItem[] = [makeItem('typescript')];
      await extractFromTsConfig(
        mockReadFile({ 'tsconfig.json': JSON.stringify({ compilerOptions: {} }) }),
        languages,
      );
      expect(languages[0].compilerTarget).toBeUndefined();
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
      expect(languages[0].compilerTarget).toBe('es2020');
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
      expect(runtimes[0].version).toBe('20.0.0');
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
      expect(buildTools[0].id).toBe('pnpm');
      expect(buildTools[0].version).toBe('9.0.0');
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
      expect(buildTools[0].version).toBe('10.0.0');
      expect(buildTools[0].evidence.length).toBeGreaterThan(0);
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
      expect(buildTools[0].evidence).toHaveLength(1);
      expect(buildTools[0].version).toBe('10.0.0');
    });
  });

  describe('refineBuildToolFromLockfiles', () => {
    it('replaces npm with yarn when yarn.lock is present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles(['yarn.lock'], buildTools);
      expect(buildTools[0].id).toBe('yarn');
    });

    it('replaces npm with pnpm when pnpm-lock.yaml is present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles(['pnpm-lock.yaml'], buildTools);
      expect(buildTools[0].id).toBe('pnpm');
    });

    it('leaves npm when no lockfile is found', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { version: '10.0.0' })];
      refineBuildToolFromLockfiles([], buildTools);
      expect(buildTools[0].id).toBe('npm');
    });

    it('adds package-lock.json evidence when present', () => {
      const buildTools: DetectedItem[] = [makeItem('npm', { evidence: [] })];
      refineBuildToolFromLockfiles(['package-lock.json'], buildTools);
      expect(buildTools[0].id).toBe('npm');
      expect(buildTools[0].evidence).toContain('package-lock.json');
    });

    it('skips duplicate package-lock.json evidence', () => {
      // Covers line 106: npmItem.evidence already contains package-lock.json
      const buildTools: DetectedItem[] = [makeItem('npm', { evidence: ['package-lock.json'] })];
      refineBuildToolFromLockfiles(['package-lock.json'], buildTools);
      expect(buildTools[0].evidence).toHaveLength(1);
    });
  });
});

// ─── java.ts ───────────────────────────────────────────────────────────────────

describe('languages/java', () => {
  describe('enrichFrameworkVersion', () => {
    it('sets framework version when not already set', () => {
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks[0].version).toBe('3.4.1');
    });

    it('does not overwrite existing framework version', () => {
      const frameworks: DetectedItem[] = [
        makeItem('spring-boot', { version: '3.3.0', versionEvidence: 'prior' }),
      ];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks[0].version).toBe('3.3.0');
    });

    it('creates framework when not yet in the array', () => {
      const frameworks: DetectedItem[] = [];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks).toHaveLength(1);
      expect(frameworks[0].version).toBe('3.4.1');
    });
  });

  describe('extractFromPomXml', () => {
    it('does nothing when pom.xml is absent', async () => {
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      await extractFromPomXml(mockReadFile({}), [], frameworks);
      expect(frameworks[0].version).toBeUndefined();
    });

    it('detects java version from pom.xml', async () => {
      const languages: DetectedItem[] = [makeItem('java')];
      const frameworks: DetectedItem[] = [];
      await extractFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <properties>
    <java.version>21</java.version>
  </properties>
</project>`,
        }),
        languages,
        frameworks,
      );
      expect(languages[0].version).toBe('21');
    });

    it('detects spring-boot from pom.xml parent artifact', async () => {
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      await extractFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
</project>`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb?.version).toBe('3.3.0');
    });
  });

  describe('extractFromGradleBuild', () => {
    it('detects springBootVersion from build.gradle', async () => {
      // Covers line 177: springBootVersion detection
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [];
      await extractFromGradleBuild(
        mockReadFile({
          'build.gradle': `ext {
    springBootVersion = '3.4.1'
}
`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb).toBeDefined();
      expect(sb?.version).toBe('3.4.1');
    });

    it('detects spring-boot from gradle plugin declaration', async () => {
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [];
      await extractFromGradleBuild(
        mockReadFile({
          'build.gradle': `id 'org.springframework.boot' version '3.2.0'
`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb).toBeDefined();
      expect(sb?.version).toBe('3.2.0');
    });
  });

  describe('enrichRuntimeVersion', () => {
    it('creates runtime item when not found', () => {
      const runtimes: DetectedItem[] = [];
      enrichRuntimeVersion(runtimes, 'java', '21', 'pom.xml:java.version');
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].version).toBe('21');
    });
  });

  describe('extractDatabasesFromDockerCompose', () => {
    it('detects postgres database from docker-compose.yml', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  db:
    image: postgres:15-alpine
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      const pg = databases.find((d) => d.id === 'postgresql');
      expect(pg).toBeDefined();
      expect(pg?.version).toBe('15');
    });

    it('detects database from docker-compose.override.yml', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.override.yml': `services:
  redis:
    image: redis:7-alpine
`,
        }),
        ['docker-compose.override.yml'],
        databases,
      );
      const redis = databases.find((d) => d.id === 'redis');
      expect(redis).toBeDefined();
      expect(redis?.version).toBe('7');
    });

    it('skips compose files without image fields', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  web:
    build: .
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      expect(databases).toHaveLength(0);
    });

    it('handles docker-compose files without database images', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  web:
    image: nginx:alpine
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      expect(databases).toHaveLength(0);
    });
  });

  describe('extractArtifactsFromPomXml', () => {
    it('detects openapi-generator plugin from pom.xml', async () => {
      const testFrameworks: DetectedItem[] = [];
      const tools: DetectedItem[] = [];
      const qualityTools: DetectedItem[] = [];
      const databases: DetectedItem[] = [];
      await extractArtifactsFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <build>
    <plugins>
      <plugin>
        <groupId>org.openapitools</groupId>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <version>7.2.0</version>
      </plugin>
    </plugins>
  </build>
</project>`,
        }),
        testFrameworks,
        tools,
        qualityTools,
        databases,
      );
      expect(tools.find((t) => t.id === 'openapi-generator')).toBeDefined();
    });
  });
  describe('EDGE', () => {
    it('extractFromNodeVersionFiles handles file with no version content', async () => {
      const runtimes = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '# comment only\n' }), runtimes, [
        '.nvmrc',
      ]);
      expect(runtimes[0].version).toBeUndefined();
    });

    it('extractFromPackageJson handles engines.node with non-version constraint', async () => {
      const runtimes = [makeItem('node')];
      await extractFromPackageJson(
        mockReadFile({ 'package.json': JSON.stringify({ engines: { node: 'latest' } }) }),
        [],
        [],
        runtimes,
        [],
        [],
        [],
      );
      expect(runtimes[0].version).toBeUndefined();
    });

    it('extractFromPackageJson handles devDependencies missing typescript item', async () => {
      const languages = [];
      const frameworks = [];
      const databases = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ devDependencies: { typescript: '^5.3' } }),
        }),
        languages,
        frameworks,
        [],
        [],
        [],
        databases,
      );
      expect(languages).toHaveLength(0);
    });
  });
});
