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

describe('discovery/collectors/topology', () => {
  describe('HAPPY', () => {
    it('detects single-project topology', async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.kind).toBe('single-project');
    });

    it('detects monorepo topology with nx.json', async () => {
      const result = await collectTopology(MONOREPO_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.kind).toBe('monorepo');
    });

    it('detects modules in monorepo', async () => {
      const result = await collectTopology(MONOREPO_INPUT);
      // packages/api, packages/web, packages/shared, libs/common
      expect(result.data.modules.length).toBeGreaterThanOrEqual(3);
    });

    it('detects entry points', async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      const entryPoints = result.data.entryPoints;
      expect(entryPoints.some((e) => e.path.includes('index.ts'))).toBe(true);
    });

    it('includes standard ignore paths', async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.data.ignorePaths).toContain('node_modules');
      expect(result.data.ignorePaths).toContain('dist');
    });
  });

  describe('CORNER', () => {
    it('returns unknown for empty input', async () => {
      const result = await collectTopology(EMPTY_INPUT);
      expect(result.data.kind).toBe('unknown');
      expect(result.data.modules).toHaveLength(0);
    });

    it('detects root-level config files', async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.data.rootConfigs).toContain('tsconfig.json');
      expect(result.data.rootConfigs).toContain('package.json');
    });
  });
});

describe('discovery/collectors/surface-detection', () => {
  describe('HAPPY', () => {
    it('detects API surface from controller paths', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.api.length).toBeGreaterThan(0);
    });

    it('detects persistence surface from prisma', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.persistence.length).toBeGreaterThan(0);
      expect(result.data.persistence.some((s) => s.id === 'prisma')).toBe(true);
    });

    it('detects CI/CD surface from GitHub Actions', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.cicd.length).toBeGreaterThan(0);
      expect(result.data.cicd.some((s) => s.id === 'github-actions')).toBe(true);
    });

    it('detects security surface from auth paths', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.security.length).toBeGreaterThan(0);
    });

    it('detects architectural layers', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      const layerNames = result.data.layers.map((l) => l.name);
      expect(layerNames).toContain('controller');
      expect(layerNames).toContain('service');
      expect(layerNames).toContain('model');
    });
  });

  describe('CORNER', () => {
    it('returns empty arrays for empty input', async () => {
      const result = await collectSurfaces(EMPTY_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.api).toHaveLength(0);
      expect(result.data.persistence).toHaveLength(0);
      expect(result.data.layers).toHaveLength(0);
    });

    it('all surfaces have valid classification', async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      const allSurfaces = [
        ...result.data.api,
        ...result.data.persistence,
        ...result.data.cicd,
        ...result.data.security,
      ];
      for (const surface of allSurfaces) {
        expect(['fact', 'derived_signal', 'hypothesis']).toContain(surface.classification);
        expect(surface.evidence.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('discovery/collectors/domain-signals', () => {
  describe('HAPPY', () => {
    it('detects auth domain keyword from auth path', async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.keywords.some((k) => k.term === 'authentication')).toBe(true);
    });

    it('detects glossary source from README', async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      expect(result.data.glossarySources.some((s) => s.includes('README'))).toBe(true);
    });

    it('keywords sorted by occurrences descending', async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      const keywords = result.data.keywords;
      for (let i = 1; i < keywords.length; i++) {
        expect(keywords[i - 1].occurrences).toBeGreaterThanOrEqual(keywords[i].occurrences);
      }
    });
  });

  describe('CORNER', () => {
    it('returns empty for empty input', async () => {
      const result = await collectDomainSignals(EMPTY_INPUT);
      expect(result.status).toBe('complete');
      expect(result.data.keywords).toHaveLength(0);
      expect(result.data.glossarySources).toHaveLength(0);
    });

    it('all keywords have derived_signal classification', async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      for (const kw of result.data.keywords) {
        expect(kw.classification).toBe('derived_signal');
      }
    });
  });
});

describe('discovery/collectors/code-surface-analysis', () => {
  async function withTempProject(
    files: Record<string, string>,
    run: (input: CollectorInput) => Promise<void>,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-code-surface-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tmp, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf-8');
      }
      await run({
        worktreePath: tmp,
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: Object.keys(files),
        packageFiles: ['package.json'],
        configFiles: ['tsconfig.json'],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  describe('HAPPY', () => {
    it('detects endpoint/auth/data/integration signals from source content', async () => {
      await withTempProject(
        {
          'src/api/users.ts':
            "router.get('/users', authMiddleware, async () => prisma.user.findMany());",
          'src/integration/client.ts': "await axios('/external/service');",
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.status).toBe('complete');
          expect(result.data.status).toBe('ok');
          expect(result.data.endpoints.length).toBeGreaterThan(0);
          expect(result.data.authBoundaries.length).toBeGreaterThan(0);
          expect(result.data.dataAccess.length).toBeGreaterThan(0);
          expect(result.data.integrations.length).toBeGreaterThan(0);
        },
      );
    });
  });

  describe('BAD', () => {
    it('degrades to partial when candidate files cannot be read', async () => {
      const result = await collectCodeSurfaces({
        worktreePath: '/definitely/missing/worktree',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/api/missing.ts'],
        packageFiles: [],
        configFiles: [],
      });
      expect(result.status).toBe('partial');
      expect(result.data.status).toBe('partial');
    });

    it('returns failed when candidate file entries are malformed', async () => {
      const malformed = {
        worktreePath: '/tmp',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: [null as unknown as string],
        packageFiles: [],
        configFiles: [],
      } as CollectorInput;

      const result = await collectCodeSurfaces(malformed);
      expect(result.status).toBe('failed');
      expect(result.data.status).toBe('failed');
      expect(result.data.budget.timedOut).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('returns empty signals for files without matching patterns', async () => {
      await withTempProject(
        {
          'src/plain.ts': 'export const answer = 42;',
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.data.endpoints).toHaveLength(0);
          expect(result.data.authBoundaries).toHaveLength(0);
          expect(result.data.dataAccess).toHaveLength(0);
          expect(result.data.integrations).toHaveLength(0);
        },
      );
    });
  });

  describe('EDGE', () => {
    it('marks partial when candidate set exceeds file budget', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 260; i++) {
        files[`src/file-${i}.ts`] = `export const n${i} = ${i};`;
      }
      await withTempProject(files, async (input) => {
        const result = await collectCodeSurfaces(input);
        expect(result.status).toBe('partial');
        expect(result.data.status).toBe('partial');
        expect(result.data.budget.scannedFiles).toBeLessThanOrEqual(200);
      });
    });

    it('marks partial and truncates when a source file exceeds per-file byte budget', async () => {
      await withTempProject(
        {
          'src/oversized.ts': `router.get('/x', () => {})\n${'x'.repeat(80 * 1024)}`,
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.status).toBe('partial');
          expect(result.data.status).toBe('partial');
          expect(result.data.budget.scannedBytes).toBeLessThanOrEqual(64 * 1024);
          expect(result.data.endpoints.length).toBeGreaterThan(0);
        },
      );
    });

    it('marks partial when cumulative bytes exceed total budget', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 32; i++) {
        files[`src/heavy-${i}.ts`] = `export const n${i} = ${i};\n${'y'.repeat(65480)}`;
      }
      files['src/heavy-overflow.ts'] = `export const overflow = true;\n${'z'.repeat(2048)}`;

      await withTempProject(files, async (input) => {
        const result = await collectCodeSurfaces(input);
        expect(result.status).toBe('partial');
        expect(result.data.status).toBe('partial');
        expect(result.data.budget.scannedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(result.data.budget.scannedFiles).toBeLessThan(Object.keys(files).length);
      });
    });
  });
});

// ─── Orchestrator Tests ───────────────────────────────────────────────────────
