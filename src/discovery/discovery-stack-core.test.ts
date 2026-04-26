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

describe('discovery/collectors/stack-detection', () => {
  describe('HAPPY', () => {
    it('detects TypeScript language from .ts files', async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.languages.some((l) => l.id === 'typescript')).toBe(true);
    });

    it('detects npm build tool from package.json', async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.data.buildTools.some((t) => t.id === 'npm')).toBe(true);
    });

    it('detects vitest test framework from config', async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.data.testFrameworks.some((t) => t.id === 'vitest')).toBe(true);
    });

    it('ignores non-framework config files', async () => {
      // Config files not matching FRAMEWORK_CONFIG_RULES are ignored
      // This ensures only relevant framework configs are collected
      const result = await collectStack(TS_PROJECT_INPUT);
      // Verify that unrelated config files don't create phantom frameworks
      const frameworkIds = result.data.frameworks.map((f) => f.id);
      expect(frameworkIds.filter((id) => id !== 'vitest')).toHaveLength(0);
    });
  });

  describe('CORNER', () => {
    it('returns empty arrays for empty input', async () => {
      const result = await collectStack(EMPTY_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.languages).toHaveLength(0);
      expect(result.data.frameworks).toHaveLength(0);
      expect(result.data.buildTools).toHaveLength(0);
    });

    it('languages sorted by confidence descending', async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      const langs = result.data.languages;
      for (let i = 1; i < langs.length; i++) {
        expect(langs[i - 1].confidence).toBeGreaterThanOrEqual(langs[i].confidence);
      }
    });

    it('all detected items have valid classification', async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      const allItems = [
        ...result.data.languages,
        ...result.data.buildTools,
        ...result.data.frameworks,
        ...result.data.testFrameworks,
        ...result.data.runtimes,
      ];
      for (const item of allItems) {
        expect(['fact', 'derived_signal', 'hypothesis']).toContain(item.classification);
        expect(item.confidence).toBeGreaterThanOrEqual(0);
        expect(item.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});

// ─── Version Extraction Tests ─────────────────────────────────────────────────
