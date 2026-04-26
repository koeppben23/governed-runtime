/**
 * @module discovery/discovery.test
 * @description Tests for the Discovery system — types, collectors, orchestrator, and archive types.
 *
 * Coverage:
 * - Zod schema validation (happy + bad)
 * - All 6 collectors (stack, topology, surfaces, code-surface-analysis, domain-signals, repo-metadata)
 * - Orchestrator (runDiscovery, extractDiscoverySummary, computeDiscoveryDigest)
 * - Archive types (manifest, verification, findings)
 * - Edge cases: empty inputs, large inputs, partial failures
 *
 * @version v1
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Discovery types
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  DiscoverySummarySchema,
  DetectedItemSchema,
  DetectedStackSchema,
  DetectedStackVersionSchema,
  DetectedStackTargetSchema,
  StackInfoSchema,
  ArchiveManifestSchema,
  ArchiveVerificationSchema,
  ArchiveFindingSchema,
  ArchiveFindingCodeSchema,
  DISCOVERY_SCHEMA_VERSION,
  PROFILE_RESOLUTION_SCHEMA_VERSION,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type CollectorInput,
  type DiscoveryResult,
} from '../index.js';

// Collectors
import { collectStack } from './collectors/stack-detection.js';
import { collectTopology } from './collectors/topology.js';
import { collectSurfaces } from './collectors/surface-detection.js';
import { collectCodeSurfaces } from './collectors/code-surface-analysis.js';
import { collectDomainSignals } from './collectors/domain-signals.js';

// Orchestrator
import { runDiscovery, extractDiscoverySummary, computeDiscoveryDigest } from './orchestrator.js';
import { extractDetectedStack } from './orchestrator.js';

// ─── Git Adapter Mock (module-level, deterministic) ──────────────────────────
// The repo-metadata collector imports from ../adapters/git. A single
// module-level mock ensures deterministic behavior across all orchestrator tests.
// Per-test overrides use vi.mocked().mockResolvedValueOnce() where needed.

vi.mock('../adapters/git', () => ({
  defaultBranch: vi.fn().mockResolvedValue('main'),
  headCommit: vi.fn().mockResolvedValue('abc1234'),
  isClean: vi.fn().mockResolvedValue(true),
  remoteOriginUrl: vi.fn().mockResolvedValue(null),
}));

const gitMock = await import('../adapters/git.js');

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const EMPTY_INPUT: CollectorInput = {
  worktreePath: '/test/repo',
  fingerprint: 'abcdef0123456789abcdef01',
  allFiles: [],
  packageFiles: [],
  configFiles: [],
};

const TS_PROJECT_INPUT: CollectorInput = {
  worktreePath: '/test/ts-project',
  fingerprint: 'abcdef0123456789abcdef01',
  allFiles: [
    'src/index.ts',
    'src/app.ts',
    'src/utils/helper.ts',
    'src/services/auth.ts',
    'src/auth/middleware.ts',
    'src/controllers/user.ts',
    'src/models/user.ts',
    'test/app.test.ts',
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    '.eslintrc.json',
    '.prettierrc',
    '.github/workflows/ci.yml',
    'README.md',
    'prisma/schema.prisma',
  ],
  packageFiles: ['package.json'],
  configFiles: ['tsconfig.json', 'vitest.config.ts', '.eslintrc.json', '.prettierrc'],
};

const MONOREPO_INPUT: CollectorInput = {
  worktreePath: '/test/monorepo',
  fingerprint: '123456789abcdef012345678',
  allFiles: [
    'package.json',
    'nx.json',
    'tsconfig.json',
    'packages/api/package.json',
    'packages/api/src/index.ts',
    'packages/web/package.json',
    'packages/web/src/main.tsx',
    'packages/shared/package.json',
    'packages/shared/src/utils.ts',
    'libs/common/package.json',
    '.github/workflows/ci.yml',
  ],
  packageFiles: ['package.json'],
  configFiles: ['tsconfig.json', 'nx.json'],
};

// ─── Schema Tests ─────────────────────────────────────────────────────────────

describe('discovery/collectors/stack-detection/js-ecosystem', () => {
  /** Create a mock readFile that returns content for known paths. */
  function mockReadFile(
    files: Record<string, string>,
  ): (relativePath: string) => Promise<string | undefined> {
    return async (relativePath: string) => files[relativePath];
  }

  function inputWithFiles(
    files: Record<string, string>,
    overrides?: Partial<CollectorInput>,
  ): CollectorInput {
    return {
      worktreePath: '/test/repo',
      fingerprint: 'abcdef0123456789abcdef01',
      allFiles: overrides?.allFiles ?? ['src/index.ts', 'package.json'],
      packageFiles: overrides?.packageFiles ?? ['package.json'],
      configFiles: overrides?.configFiles ?? [],
      readFile: mockReadFile(files),
    };
  }

  // ─── HAPPY: package.json dependency detection ────────────
  describe('HAPPY', () => {
    it('detects react from package.json dependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          }),
        },
        {
          allFiles: ['src/App.tsx', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.frameworks.find((f) => f.id === 'react');
      expect(item).toBeDefined();
      expect(item?.version).toBe('18.3.1');
      expect(item?.versionEvidence).toBe('package.json:dependencies.react');
      expect(item?.classification).toBe('derived_signal');
    });

    it('detects vue from package.json dependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { vue: '^3.4.21' },
          }),
        },
        {
          allFiles: ['src/App.vue', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.frameworks.find((f) => f.id === 'vue');
      expect(item).toBeDefined();
      expect(item?.version).toBe('3.4.21');
    });

    it('detects next from package.json dependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { next: '14.2.3', react: '^18.3.1' },
          }),
        },
        {
          allFiles: ['src/app/page.tsx', 'package.json', 'next.config.mjs'],
          packageFiles: ['package.json'],
          configFiles: ['next.config.mjs'],
        },
      );
      const result = await collectStack(input);
      const nextItem = result.data.frameworks.find((f) => f.id === 'next');
      expect(nextItem).toBeDefined();
      expect(nextItem?.version).toBe('14.2.3');
      // react also detected
      const reactItem = result.data.frameworks.find((f) => f.id === 'react');
      expect(reactItem).toBeDefined();
      expect(reactItem?.version).toBe('18.3.1');
    });

    it('detects sveltekit from package.json devDependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { '@sveltejs/kit': '^2.5.0', svelte: '^4.2.12' },
          }),
        },
        {
          allFiles: ['src/routes/+page.svelte', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const skItem = result.data.frameworks.find((f) => f.id === 'sveltekit');
      expect(skItem).toBeDefined();
      expect(skItem?.version).toBe('2.5.0');
      const svelteItem = result.data.frameworks.find((f) => f.id === 'svelte');
      expect(svelteItem).toBeDefined();
      expect(svelteItem?.version).toBe('4.2.12');
    });

    it('detects astro from package.json dependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { astro: '^4.8.0' },
          }),
        },
        {
          allFiles: ['src/pages/index.astro', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.frameworks.find((f) => f.id === 'astro');
      expect(item).toBeDefined();
      expect(item?.version).toBe('4.8.0');
    });

    it('detects remix from package.json dependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { '@remix-run/node': '^2.9.0', '@remix-run/react': '^2.9.0' },
          }),
        },
        {
          allFiles: ['app/root.tsx', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.frameworks.find((f) => f.id === 'remix');
      expect(item).toBeDefined();
      expect(item?.version).toBe('2.9.0');
      // Should not duplicate from @remix-run/react
      const remixItems = result.data.frameworks.filter((f) => f.id === 'remix');
      expect(remixItems).toHaveLength(1);
    });

    it('detects vitest from package.json devDependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { vitest: '^1.6.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'vitest');
      expect(item).toBeDefined();
      expect(item?.version).toBe('1.6.0');
      expect(item?.versionEvidence).toBe('package.json:devDependencies.vitest');
    });

    it('detects jest from package.json devDependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { jest: '^29.7.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'jest');
      expect(item).toBeDefined();
      expect(item?.version).toBe('29.7.0');
    });

    it('detects playwright from package.json devDependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { '@playwright/test': '^1.44.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'playwright');
      expect(item).toBeDefined();
      expect(item?.version).toBe('1.44.0');
    });

    it('detects cypress from package.json devDependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { cypress: '^13.8.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'cypress');
      expect(item).toBeDefined();
      expect(item?.version).toBe('13.8.0');
    });

    it('detects eslint from package.json devDependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { eslint: '^8.57.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'eslint');
      expect(item).toBeDefined();
      expect(item?.version).toBe('8.57.0');
      expect(item?.versionEvidence).toBe('package.json:devDependencies.eslint');
    });

    it('detects prettier from package.json devDependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { prettier: '^3.2.5' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'prettier');
      expect(item).toBeDefined();
      expect(item?.version).toBe('3.2.5');
    });

    it('detects biome from package.json devDependencies with version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { '@biomejs/biome': '^1.7.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'biome');
      expect(item).toBeDefined();
      expect(item?.version).toBe('1.7.0');
    });

    it('detects eslint from config file as qualityTool', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', '.eslintrc.json'],
          packageFiles: ['package.json'],
          configFiles: ['.eslintrc.json'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'eslint');
      expect(item).toBeDefined();
      expect(item?.classification).toBe('fact');
      expect(item?.evidence).toContain('.eslintrc.json');
    });

    it('detects prettier from config file as qualityTool', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', '.prettierrc'],
          packageFiles: ['package.json'],
          configFiles: ['.prettierrc'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'prettier');
      expect(item).toBeDefined();
      expect(item?.classification).toBe('fact');
      expect(item?.evidence).toContain('.prettierrc');
    });

    it('detects Python ecosystem facts from root pyproject.toml and .python-version', async () => {
      const input = inputWithFiles(
        {
          '.python-version': '3.12.4\n',
          'pyproject.toml': `[project]
name = "demo"
requires-python = ">=3.12"

[tool.pytest.ini_options]
minversion = "8.0"

[tool.ruff]
line-length = 100

[tool.black]
line-length = 100

[tool.mypy]
python_version = "3.12"
`,
        },
        {
          allFiles: ['pyproject.toml', '.python-version'],
          packageFiles: ['pyproject.toml'],
        },
      );

      const result = await collectStack(input);
      const python = result.data.languages.find((l) => l.id === 'python');
      expect(python).toBeDefined();
      expect(python?.version).toBe('3.12.4');
      expect(python?.versionEvidence).toBe('.python-version');

      expect(result.data.testFrameworks.find((t) => t.id === 'pytest')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'ruff')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'black')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'mypy')).toBeDefined();
    });

    it('detects uv and poetry from root lockfiles and pip from requirements.txt', async () => {
      const input = inputWithFiles(
        {
          'requirements.txt': 'pytest==8.1.1\nruff==0.5.5\n',
          'requirements-dev.txt': 'black==24.4.2\nmypy==1.10.0\n',
        },
        {
          allFiles: ['uv.lock', 'poetry.lock', 'requirements.txt', 'requirements-dev.txt'],
          packageFiles: ['requirements.txt'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.buildTools.find((b) => b.id === 'uv')).toBeDefined();
      expect(result.data.buildTools.find((b) => b.id === 'poetry')).toBeDefined();
      expect(result.data.buildTools.find((b) => b.id === 'pip')).toBeDefined();
      expect(result.data.testFrameworks.find((t) => t.id === 'pytest')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'ruff')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'black')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'mypy')).toBeDefined();
    });

    it('detects Rust language, cargo build tool, edition, and toolchain version', async () => {
      const input = inputWithFiles(
        {
          'Cargo.toml': `[package]
name = "demo"
version = "0.1.0"
edition = "2021"
`,
          'rust-toolchain.toml': `[toolchain]
channel = "1.78.0"
components = ["clippy", "rustfmt"]
`,
        },
        {
          allFiles: ['Cargo.toml', 'rust-toolchain.toml'],
          packageFiles: ['Cargo.toml'],
        },
      );

      const result = await collectStack(input);
      const rust = result.data.languages.find((l) => l.id === 'rust');
      expect(rust).toBeDefined();
      expect(rust?.compilerTarget).toBe('2021');
      expect(rust?.compilerTargetEvidence).toBe('Cargo.toml:edition');
      expect(rust?.version).toBe('1.78.0');
      expect(rust?.versionEvidence).toBe('rust-toolchain.toml:channel');

      expect(result.data.buildTools.find((b) => b.id === 'cargo')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'clippy')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'rustfmt')).toBeDefined();
    });

    it('detects Go language version from go.mod and golangci-lint from root config', async () => {
      const input = inputWithFiles(
        {
          'go.mod': 'module example.com/myapp\n\ngo 1.22\n',
        },
        {
          allFiles: ['go.mod', '.golangci.yml'],
          packageFiles: ['go.mod'],
          configFiles: ['.golangci.yml'],
        },
      );

      const result = await collectStack(input);
      const go = result.data.languages.find((l) => l.id === 'go');
      expect(go).toBeDefined();
      expect(go?.version).toBe('1.22');
      expect(go?.versionEvidence).toBe('go.mod:go');

      expect(result.data.buildTools.find((b) => b.id === 'go-modules')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'golangci-lint')).toBeDefined();
    });
  });

  // ─── HAPPY: lockfile-based package manager detection ──────
  describe('HAPPY/lockfiles', () => {
    it('detects pnpm from pnpm-lock.yaml', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'pnpm-lock.yaml'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const pnpm = result.data.buildTools.find((b) => b.id === 'pnpm');
      expect(pnpm).toBeDefined();
      expect(pnpm?.evidence).toContain('pnpm-lock.yaml');
      // npm should be replaced
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('detects yarn from yarn.lock', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'yarn.lock'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const yarn = result.data.buildTools.find((b) => b.id === 'yarn');
      expect(yarn).toBeDefined();
      expect(yarn?.evidence).toContain('yarn.lock');
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('detects bun from bun.lockb', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'bun.lockb'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const bun = result.data.buildTools.find((b) => b.id === 'bun');
      expect(bun).toBeDefined();
      expect(bun?.evidence).toContain('bun.lockb');
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('detects bun from bun.lock', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'bun.lock'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const bun = result.data.buildTools.find((b) => b.id === 'bun');
      expect(bun).toBeDefined();
      expect(bun?.evidence).toContain('bun.lock');
    });

    it('keeps npm when package-lock.json is the lockfile', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'package-lock.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const npm = result.data.buildTools.find((b) => b.id === 'npm');
      expect(npm).toBeDefined();
      expect(npm?.evidence).toContain('package-lock.json');
    });

    it('keeps npm when no lockfile is present', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const npm = result.data.buildTools.find((b) => b.id === 'npm');
      expect(npm).toBeDefined();
    });
  });

  // ─── HAPPY: packageManager field detection ────────────────
  describe('HAPPY/packageManager', () => {
    it('detects pnpm with version from packageManager field', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'pnpm@9.12.0',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const pnpm = result.data.buildTools.find((b) => b.id === 'pnpm');
      expect(pnpm).toBeDefined();
      expect(pnpm?.version).toBe('9.12.0');
      expect(pnpm?.versionEvidence).toBe('package.json:packageManager');
      expect(pnpm?.confidence).toBe(0.95);
      expect(pnpm?.classification).toBe('fact');
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('detects yarn with version from packageManager field', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'yarn@4.1.0',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const yarn = result.data.buildTools.find((b) => b.id === 'yarn');
      expect(yarn).toBeDefined();
      expect(yarn?.version).toBe('4.1.0');
      expect(yarn?.versionEvidence).toBe('package.json:packageManager');
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('detects bun with version from packageManager field', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'bun@1.1.12',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const bun = result.data.buildTools.find((b) => b.id === 'bun');
      expect(bun).toBeDefined();
      expect(bun?.version).toBe('1.1.12');
      expect(bun?.versionEvidence).toBe('package.json:packageManager');
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
    });

    it('versions npm from packageManager field without replacing it', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'npm@10.5.0',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const npm = result.data.buildTools.find((b) => b.id === 'npm');
      expect(npm).toBeDefined();
      expect(npm?.version).toBe('10.5.0');
      expect(npm?.versionEvidence).toBe('package.json:packageManager');
    });
  });

  // ─── CORNER: dedup and version enrichment ─────────────────
  describe('CORNER', () => {
    it('config-detected vitest gets version enriched from package.json, not duplicated', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { vitest: '^1.6.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'vitest.config.ts'],
          packageFiles: ['package.json'],
          configFiles: ['vitest.config.ts'],
        },
      );
      const result = await collectStack(input);
      const vitestItems = result.data.testFrameworks.filter((t) => t.id === 'vitest');
      expect(vitestItems).toHaveLength(1);
      // Config detection provides the item, package.json enriches the version
      expect(vitestItems[0]?.version).toBe('1.6.0');
      expect(vitestItems[0]?.classification).toBe('fact'); // Config-detected = fact
    });

    it('config-detected eslint gets version enriched from package.json, not duplicated', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { eslint: '^8.57.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', '.eslintrc.json'],
          packageFiles: ['package.json'],
          configFiles: ['.eslintrc.json'],
        },
      );
      const result = await collectStack(input);
      const eslintItems = result.data.qualityTools.filter((t) => t.id === 'eslint');
      expect(eslintItems).toHaveLength(1);
      expect(eslintItems[0]?.version).toBe('8.57.0');
      expect(eslintItems[0]?.classification).toBe('fact');
    });

    it('config-detected prettier gets version enriched from package.json, not duplicated', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { prettier: '^3.2.5' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', '.prettierrc'],
          packageFiles: ['package.json'],
          configFiles: ['.prettierrc'],
        },
      );
      const result = await collectStack(input);
      const prettierItems = result.data.qualityTools.filter((t) => t.id === 'prettier');
      expect(prettierItems).toHaveLength(1);
      expect(prettierItems[0]?.version).toBe('3.2.5');
      expect(prettierItems[0]?.classification).toBe('fact');
    });

    it('config-detected vite gets version enriched from package.json devDeps', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { vite: '^5.2.11' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'vite.config.ts'],
          packageFiles: ['package.json'],
          configFiles: ['vite.config.ts'],
        },
      );
      const result = await collectStack(input);
      const viteItems = result.data.frameworks.filter((f) => f.id === 'vite');
      expect(viteItems).toHaveLength(1);
      expect(viteItems[0]?.version).toBe('5.2.11');
    });

    it('config-detected next gets version from package.json deps, not duplicated', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { next: '14.2.3' },
          }),
        },
        {
          allFiles: ['src/app/page.tsx', 'package.json', 'next.config.mjs'],
          packageFiles: ['package.json'],
          configFiles: ['next.config.mjs'],
        },
      );
      const result = await collectStack(input);
      const nextItems = result.data.frameworks.filter((f) => f.id === 'next');
      expect(nextItems).toHaveLength(1);
      expect(nextItems[0]?.version).toBe('14.2.3');
    });

    it('remix detected once despite two @remix-run packages', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: {
              '@remix-run/node': '2.9.0',
              '@remix-run/react': '2.9.0',
            },
          }),
        },
        {
          allFiles: ['app/root.tsx', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const remixItems = result.data.frameworks.filter((f) => f.id === 'remix');
      expect(remixItems).toHaveLength(1);
    });

    it('lockfile detection does not affect non-npm build tools', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/main/java/App.java', 'pom.xml', 'pnpm-lock.yaml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      // No npm to refine — maven stays
      const maven = result.data.buildTools.find((b) => b.id === 'maven');
      expect(maven).toBeDefined();
      // No pnpm added (no package.json → no npm to replace)
      expect(result.data.buildTools.find((b) => b.id === 'pnpm')).toBeUndefined();
    });

    it('pnpm lockfile in subdirectory does not trigger refinement', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'packages/app/pnpm-lock.yaml'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      // Nested pnpm-lock.yaml must NOT refine root build tool — only root-level lockfiles count
      expect(result.data.buildTools.find((b) => b.id === 'pnpm')).toBeUndefined();
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeDefined();
    });

    it('ignores nested Python/Rust/Go manifests for root-first ecosystem facts', async () => {
      const input = inputWithFiles(
        {
          'packages/app/pyproject.toml': '[project]\nname = "nested"\nrequires-python = ">=3.12"\n',
          'packages/lib/Cargo.toml': '[package]\nname = "nested"\nedition = "2021"\n',
          'packages/svc/go.mod': 'module example.com/nested\n\ngo 1.22\n',
        },
        {
          allFiles: [
            'packages/app/pyproject.toml',
            'packages/lib/Cargo.toml',
            'packages/svc/go.mod',
            'packages/svc/.golangci.yml',
          ],
          packageFiles: ['pyproject.toml', 'Cargo.toml', 'go.mod'],
          configFiles: ['.golangci.yml'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.languages.find((l) => l.id === 'python')).toBeUndefined();
      expect(result.data.languages.find((l) => l.id === 'rust')).toBeUndefined();
      expect(result.data.languages.find((l) => l.id === 'go')).toBeUndefined();

      expect(result.data.buildTools.find((b) => b.id === 'poetry')).toBeUndefined();
      expect(result.data.buildTools.find((b) => b.id === 'cargo')).toBeUndefined();
      expect(result.data.buildTools.find((b) => b.id === 'go-modules')).toBeUndefined();
      expect(result.data.qualityTools.find((t) => t.id === 'golangci-lint')).toBeUndefined();
    });

    it('packageManager field takes priority over lockfile', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'pnpm@9.12.0',
          }),
        },
        {
          // yarn.lock at root would normally trigger yarn — but packageManager wins
          allFiles: ['src/index.ts', 'package.json', 'yarn.lock'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const pnpm = result.data.buildTools.find((b) => b.id === 'pnpm');
      expect(pnpm).toBeDefined();
      expect(pnpm?.version).toBe('9.12.0');
      // yarn should NOT be detected — packageManager field is authoritative
      expect(result.data.buildTools.find((b) => b.id === 'yarn')).toBeUndefined();
    });

    it('invalid packageManager field falls through to lockfile detection', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 'not-a-manager@1.0.0',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'pnpm-lock.yaml'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      // Invalid packageManager → falls through to lockfile → pnpm detected
      const pnpm = result.data.buildTools.find((b) => b.id === 'pnpm');
      expect(pnpm).toBeDefined();
      expect(pnpm?.version).toBeUndefined(); // Lockfile detection has no version
    });

    it('packageManager field with hash suffix still extracts version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            // Corepack uses hash suffix: "pnpm@9.12.0+sha512.abc..."
            // Regex captures only the version digits before the +
            packageManager: 'pnpm@9.12.0',
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const pnpm = result.data.buildTools.find((b) => b.id === 'pnpm');
      expect(pnpm?.version).toBe('9.12.0');
    });

    it('full React+Vite+Vitest+ESLint+Prettier project detects everything', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
            devDependencies: {
              vite: '^5.2.11',
              vitest: '^1.6.0',
              typescript: '^5.4.5',
              eslint: '^8.57.0',
              prettier: '^3.2.5',
              tailwindcss: '^3.4.3',
            },
          }),
        },
        {
          allFiles: [
            'src/App.tsx',
            'src/index.ts',
            'package.json',
            'vite.config.ts',
            'vitest.config.ts',
            '.eslintrc.json',
            '.prettierrc',
            'tailwind.config.js',
            'pnpm-lock.yaml',
          ],
          packageFiles: ['package.json'],
          configFiles: [
            'vite.config.ts',
            'vitest.config.ts',
            '.eslintrc.json',
            '.prettierrc',
            'tailwind.config.js',
          ],
        },
      );
      const result = await collectStack(input);

      // Frameworks
      expect(result.data.frameworks.find((f) => f.id === 'react')?.version).toBe('18.3.1');
      expect(result.data.frameworks.find((f) => f.id === 'vite')?.version).toBe('5.2.11');
      expect(result.data.frameworks.find((f) => f.id === 'tailwind')?.version).toBe('3.4.3');
      // Test frameworks
      expect(result.data.testFrameworks.find((t) => t.id === 'vitest')?.version).toBe('1.6.0');
      // Quality tools
      expect(result.data.qualityTools.find((t) => t.id === 'eslint')?.version).toBe('8.57.0');
      expect(result.data.qualityTools.find((t) => t.id === 'prettier')?.version).toBe('3.2.5');
      // Build tool refined to pnpm
      expect(result.data.buildTools.find((b) => b.id === 'pnpm')).toBeDefined();
      expect(result.data.buildTools.find((b) => b.id === 'npm')).toBeUndefined();
      // TypeScript language version
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.version).toBe('5.4.5');
      // No duplicates
      expect(result.data.frameworks.filter((f) => f.id === 'vite')).toHaveLength(1);
      expect(result.data.testFrameworks.filter((t) => t.id === 'vitest')).toHaveLength(1);
      expect(result.data.qualityTools.filter((t) => t.id === 'eslint')).toHaveLength(1);
      expect(result.data.qualityTools.filter((t) => t.id === 'prettier')).toHaveLength(1);
    });
  });

  // ─── BAD ──────────────────────────────────────────────────
  describe('BAD', () => {
    it('no items created when package.json has no deps or devDeps', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({ name: 'empty-project' }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      expect(result.data.frameworks).toHaveLength(0);
      expect(result.data.testFrameworks).toHaveLength(0);
      expect(result.data.qualityTools).toHaveLength(0);
    });

    it('handles missing package.json gracefully for ecosystem scanning', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/index.ts'],
        packageFiles: [],
        configFiles: [],
        readFile: async () => undefined,
      };
      const result = await collectStack(input);
      expect(result.status).toBe('complete');
      expect(result.data.frameworks).toHaveLength(0);
    });

    it('non-string packageManager field is ignored', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            packageManager: 42,
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'yarn.lock'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      // Falls through to lockfile detection
      const yarn = result.data.buildTools.find((b) => b.id === 'yarn');
      expect(yarn).toBeDefined();
    });

    it('does not infer clippy or rustfmt from Cargo.toml without explicit toolchain components', async () => {
      const input = inputWithFiles(
        {
          'Cargo.toml': `[package]
name = "demo"
edition = "2021"
`,
        },
        {
          allFiles: ['Cargo.toml'],
          packageFiles: ['Cargo.toml'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.languages.find((l) => l.id === 'rust')).toBeDefined();
      expect(result.data.buildTools.find((b) => b.id === 'cargo')).toBeDefined();
      expect(result.data.qualityTools.find((t) => t.id === 'clippy')).toBeUndefined();
      expect(result.data.qualityTools.find((t) => t.id === 'rustfmt')).toBeUndefined();
    });

    it('detects Rust language version from root rust-toolchain.toml without Cargo.toml', async () => {
      const input = inputWithFiles(
        {
          'rust-toolchain.toml': `[toolchain]
channel = "1.78.0"
`,
        },
        {
          allFiles: ['rust-toolchain.toml'],
          packageFiles: [],
        },
      );

      const result = await collectStack(input);
      const rust = result.data.languages.find((l) => l.id === 'rust');
      expect(rust).toBeDefined();
      expect(rust?.version).toBe('1.78.0');
      expect(rust?.versionEvidence).toBe('rust-toolchain.toml:channel');
      expect(rust?.evidence).toContain('rust-toolchain.toml');
      expect(result.data.buildTools.find((b) => b.id === 'cargo')).toBeUndefined();
    });

    it('detects Rust language from plain rust-toolchain file without Cargo.toml', async () => {
      const input = inputWithFiles(
        {
          'rust-toolchain': '1.78.0\n',
        },
        {
          allFiles: ['rust-toolchain'],
          packageFiles: [],
        },
      );

      const result = await collectStack(input);
      const rust = result.data.languages.find((l) => l.id === 'rust');
      expect(rust).toBeDefined();
      expect(rust?.version).toBe('1.78.0');
      expect(rust?.versionEvidence).toBe('rust-toolchain');
      expect(rust?.evidence).toContain('rust-toolchain');
      expect(result.data.buildTools.find((b) => b.id === 'cargo')).toBeUndefined();
    });

    it('tolerates malformed pyproject.toml and does not set python version', async () => {
      const input = inputWithFiles(
        {
          'pyproject.toml': '[project\nrequires-python = ">=foo"\n',
        },
        {
          allFiles: ['pyproject.toml'],
          packageFiles: ['pyproject.toml'],
        },
      );

      const result = await collectStack(input);
      const python = result.data.languages.find((l) => l.id === 'python');
      expect(python).toBeDefined();
      expect(python?.version).toBeUndefined();
    });

    it('does not infer Python tools from incidental pyproject text', async () => {
      const input = inputWithFiles(
        {
          'pyproject.toml': `[project]
name = "demo"
description = "black box pytest migration notes"
requires-python = ">=3.12"
`,
        },
        {
          allFiles: ['pyproject.toml'],
          packageFiles: ['pyproject.toml'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.testFrameworks.find((t) => t.id === 'pytest')).toBeUndefined();
      expect(result.data.qualityTools.find((t) => t.id === 'black')).toBeUndefined();
    });

    it('does not infer poetry from generic pyproject.toml without [tool.poetry] or poetry.lock', async () => {
      const input = inputWithFiles(
        {
          'pyproject.toml': `[project]
name = "demo"
requires-python = ">=3.12"

[tool.pytest.ini_options]
minversion = "8.0"

[tool.ruff]
line-length = 100
`,
        },
        {
          allFiles: ['pyproject.toml'],
          packageFiles: ['pyproject.toml'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.buildTools.find((b) => b.id === 'poetry')).toBeUndefined();
      expect(result.data.languages.find((l) => l.id === 'python')).toBeDefined();
      expect(result.data.testFrameworks.find((t) => t.id === 'pytest')).toBeDefined();
    });

    it('detects Python language version from root .python-version without pyproject.toml', async () => {
      const input = inputWithFiles(
        {
          '.python-version': '3.12.4\n',
        },
        {
          allFiles: ['.python-version'],
          packageFiles: [],
        },
      );

      const result = await collectStack(input);
      const python = result.data.languages.find((l) => l.id === 'python');
      expect(python).toBeDefined();
      expect(python?.version).toBe('3.12.4');
      expect(python?.versionEvidence).toBe('.python-version');
      expect(python?.evidence).toContain('.python-version');
      expect(python?.evidence).not.toContain('pyproject.toml');
    });

    it('creates Python language and pip build tool from requirements.txt alone', async () => {
      const input = inputWithFiles(
        {
          'requirements.txt': 'requests==2.32.3\nurllib3==2.2.0\n',
        },
        {
          allFiles: ['requirements.txt'],
          packageFiles: ['requirements.txt'],
        },
      );

      const result = await collectStack(input);
      const python = result.data.languages.find((l) => l.id === 'python');
      expect(python).toBeDefined();
      expect(python?.evidence).toContain('requirements.txt');
      expect(python?.evidence).not.toContain('pyproject.toml');
      expect(result.data.buildTools.find((b) => b.id === 'pip')).toBeDefined();
    });
  });

  // ─── EDGE: extractDetectedStack integration ──────────────
  describe('EDGE', () => {
    it('detectedStack.items includes unversioned lockfile-detected package manager', async () => {
      const input = inputWithFiles(
        {},
        {
          allFiles: ['src/index.ts', 'package.json', 'pnpm-lock.yaml'],
          packageFiles: ['package.json'],
        },
      );
      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      const pnpmItem = ds!.items.find((i) => i.id === 'pnpm');
      expect(pnpmItem).toBeDefined();
      expect(pnpmItem?.kind).toBe('buildTool');
      expect(pnpmItem?.version).toBeUndefined();
      // Should NOT be in versions[]
      expect(ds!.versions.find((v) => v.id === 'pnpm')).toBeUndefined();
    });

    it('detectedStack.versions includes versioned package.json tools', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.3.1' },
            devDependencies: { vitest: '^1.6.0', eslint: '^8.57.0' },
          }),
        },
        {
          allFiles: ['src/App.tsx', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      // versions[] should include react, vitest, eslint
      const versionIds = ds!.versions.map((v) => v.id);
      expect(versionIds).toContain('react');
      expect(versionIds).toContain('vitest');
      expect(versionIds).toContain('eslint');

      // Correct targets
      expect(ds!.versions.find((v) => v.id === 'react')?.target).toBe('framework');
      expect(ds!.versions.find((v) => v.id === 'vitest')?.target).toBe('testFramework');
      expect(ds!.versions.find((v) => v.id === 'eslint')?.target).toBe('qualityTool');
    });

    it('detectedStack.items includes all detected items from full project', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.3.1' },
            devDependencies: { vitest: '^1.6.0', eslint: '^8.57.0', typescript: '^5.4.5' },
          }),
        },
        {
          allFiles: [
            'src/App.tsx',
            'package.json',
            'vitest.config.ts',
            '.eslintrc.json',
            'yarn.lock',
          ],
          packageFiles: ['package.json'],
          configFiles: ['vitest.config.ts', '.eslintrc.json'],
        },
      );
      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      const itemIds = ds!.items.map((i) => i.id);
      expect(itemIds).toContain('typescript');
      expect(itemIds).toContain('react');
      expect(itemIds).toContain('yarn');
      expect(itemIds).toContain('vitest');
      expect(itemIds).toContain('eslint');
    });

    it('detectedStack.summary includes versioned and unversioned items', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.3.1' },
            devDependencies: { vitest: '^1.6.0' },
          }),
        },
        {
          allFiles: ['src/App.tsx', 'package.json', 'pnpm-lock.yaml'],
          packageFiles: ['package.json'],
        },
      );
      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      // Summary should contain versioned and unversioned items
      expect(ds!.summary).toContain('react=18.3.1');
      expect(ds!.summary).toContain('vitest=1.6.0');
      expect(ds!.summary).toContain('pnpm');
    });

    it('detectedStack.items includes database kind from compose evidence', async () => {
      const input = inputWithFiles(
        {
          'docker-compose.yml': `services:
  db:
    image: postgres:16
`,
        },
        {
          allFiles: ['docker-compose.yml'],
          packageFiles: [],
          configFiles: ['docker-compose.yml'],
        },
      );

      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      const dbItem = ds!.items.find((i) => i.kind === 'database' && i.id === 'postgresql');
      expect(dbItem).toBeDefined();
      expect(dbItem?.version).toBe('16');

      const dbVersion = ds!.versions.find((v) => v.target === 'database' && v.id === 'postgresql');
      expect(dbVersion).toBeDefined();
      expect(dbVersion?.version).toBe('16');
    });

    it('detectedStack.items includes Python/Rust/Go ecosystem facts from root manifests', async () => {
      const input = inputWithFiles(
        {
          '.python-version': '3.12.2\n',
          'pyproject.toml': `[project]
name = "demo"
requires-python = ">=3.12"

[tool.pytest.ini_options]
minversion = "8.0"
`,
          'Cargo.toml': `[package]
name = "demo"
edition = "2021"
`,
          'rust-toolchain.toml': `[toolchain]
channel = "1.78.0"
components = ["clippy", "rustfmt"]
`,
          'go.mod': 'module example.com/demo\n\ngo 1.23\n',
        },
        {
          allFiles: [
            '.python-version',
            'pyproject.toml',
            'poetry.lock',
            'Cargo.toml',
            'rust-toolchain.toml',
            'go.mod',
            '.golangci.yml',
          ],
          packageFiles: ['pyproject.toml', 'Cargo.toml', 'go.mod'],
          configFiles: ['.golangci.yml'],
        },
      );

      const result = await runDiscovery(input);
      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      const itemIds = ds!.items.map((item) => `${item.kind}:${item.id}`);
      expect(itemIds).toContain('language:python');
      expect(itemIds).toContain('buildTool:poetry');
      expect(itemIds).toContain('testFramework:pytest');
      expect(itemIds).toContain('language:rust');
      expect(itemIds).toContain('buildTool:cargo');
      expect(itemIds).toContain('qualityTool:clippy');
      expect(itemIds).toContain('qualityTool:rustfmt');
      expect(itemIds).toContain('language:go');
      expect(itemIds).toContain('buildTool:go-modules');
      expect(itemIds).toContain('qualityTool:golangci-lint');

      expect(ds!.versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'python', version: '3.12.2', target: 'language' }),
          expect.objectContaining({ id: 'rust', version: '1.78.0', target: 'language' }),
          expect.objectContaining({ id: 'go', version: '1.23', target: 'language' }),
        ]),
      );
    });
  });

  // ─── PERF ─────────────────────────────────────────────────
  describe('PERF', () => {
    it('full JS ecosystem detection completes in < 50ms', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: {
              react: '^18.3.1',
              next: '14.2.3',
              'react-dom': '^18.3.1',
            },
            devDependencies: {
              vitest: '^1.6.0',
              eslint: '^8.57.0',
              prettier: '^3.2.5',
              '@biomejs/biome': '^1.7.0',
              '@playwright/test': '^1.44.0',
              typescript: '^5.4.5',
              vite: '^5.2.11',
              tailwindcss: '^3.4.3',
            },
          }),
        },
        {
          allFiles: [
            'src/App.tsx',
            'src/index.ts',
            'package.json',
            'vite.config.ts',
            'vitest.config.ts',
            '.eslintrc.json',
            '.prettierrc',
            'tailwind.config.js',
            'next.config.mjs',
            'pnpm-lock.yaml',
          ],
          packageFiles: ['package.json'],
          configFiles: [
            'vite.config.ts',
            'vitest.config.ts',
            '.eslintrc.json',
            '.prettierrc',
            'tailwind.config.js',
            'next.config.mjs',
          ],
        },
      );

      const start = performance.now();
      const result = await collectStack(input);
      const elapsed = performance.now() - start;

      expect(result.status).toBe('complete');
      expect(elapsed).toBeLessThan(50);
      // Verify breadth of detection
      expect(result.data.frameworks.length).toBeGreaterThanOrEqual(4);
      expect(result.data.testFrameworks.length).toBeGreaterThanOrEqual(1);
      expect(result.data.qualityTools.length).toBeGreaterThanOrEqual(2);
    });

    it('root-first Python/Rust/Go ecosystem detection completes in < 70ms', async () => {
      const input = inputWithFiles(
        {
          '.python-version': '3.12.2\n',
          'pyproject.toml': `[project]
name = "demo"
requires-python = ">=3.12"

[tool.pytest.ini_options]
minversion = "8.0"

[tool.ruff]
line-length = 100
`,
          'Cargo.toml': `[package]
name = "demo"
edition = "2021"
`,
          'rust-toolchain.toml': `[toolchain]
channel = "1.78.0"
components = ["clippy", "rustfmt"]
`,
          'go.mod': 'module example.com/demo\n\ngo 1.23\n',
          'requirements-dev.txt': 'black==24.4.2\nmypy==1.10.0\n',
        },
        {
          allFiles: [
            '.python-version',
            'pyproject.toml',
            'requirements-dev.txt',
            'uv.lock',
            'Cargo.toml',
            'rust-toolchain.toml',
            'go.mod',
            '.golangci.yaml',
          ],
          packageFiles: ['pyproject.toml', 'Cargo.toml', 'go.mod'],
          configFiles: ['.golangci.yaml'],
        },
      );

      const start = performance.now();
      const result = await collectStack(input);
      const elapsed = performance.now() - start;

      expect(result.status).toBe('complete');
      expect(elapsed).toBeLessThan(70);
      expect(result.data.languages.find((l) => l.id === 'python')).toBeDefined();
      expect(result.data.languages.find((l) => l.id === 'rust')).toBeDefined();
      expect(result.data.languages.find((l) => l.id === 'go')).toBeDefined();
    });
  });
});
