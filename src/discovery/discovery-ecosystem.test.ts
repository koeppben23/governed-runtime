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

// Discovery types & schemas (direct imports — not via root barrel)
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  DiscoverySummarySchema,
  DetectedItemSchema,
  DetectedStackSchema,
  DetectedStackVersionSchema,
  DetectedStackTargetSchema,
  StackInfoSchema,
  DISCOVERY_SCHEMA_VERSION,
  PROFILE_RESOLUTION_SCHEMA_VERSION,
  type CollectorInput,
  type DiscoveryResult,
} from './types.js';
import {
  ArchiveManifestSchema,
  ArchiveVerificationSchema,
  ArchiveFindingSchema,
  ArchiveFindingCodeSchema,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
} from '../archive/types.js';

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
});

