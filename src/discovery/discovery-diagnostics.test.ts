/**
 * @module discovery/discovery-diagnostics.test
 * @description Tests for Issue #372 — discovery diagnostics, read statuses,
 * code-surface partial fix, drift detection, and profile evidence.
 *
 * Coverage:
 * - Phase 1: Per-collector diagnostics (timing, errorCode, timedOut)
 * - Phase 2: Read/parse status outcomes
 * - Phase 4: Code-surface partial based on source-candidate count, not total files
 * - Phase 5: validationHints deprecated, verificationCandidates canonical
 * - Phase 7: Drift detection (read-only)
 * - Negative paths: timeout, unreadable files, parse failures, budget exhaustion
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DiscoveryResultSchema,
  CollectorDiagnosticSchema,
  ReadOutcomeSchema,
  CodeSurfaceBudgetSchema,
  type CollectorInput,
} from './types.js';
import { runDiscovery, computeDiscoveryDigest } from './orchestrator.js';
import { runCollectorWithDiagnostics } from './collector-runner.js';
import { collectCodeSurfaces } from './collectors/code-surface-analysis.js';

// Mock git adapter for orchestrator tests
vi.mock('../adapters/git', () => ({
  defaultBranch: vi.fn().mockResolvedValue('main'),
  headCommit: vi.fn().mockResolvedValue('abc1234'),
  isClean: vi.fn().mockResolvedValue(true),
  remoteOriginUrl: vi.fn().mockResolvedValue(null),
  listRepoSignals: vi.fn().mockResolvedValue({
    files: [],
    packageFiles: [],
    configFiles: [],
    packageFilePaths: [],
    configFilePaths: [],
  }),
}));

vi.mock('../adapters/persistence-discovery', () => ({
  readDiscovery: vi.fn().mockResolvedValue(null),
}));

const EMPTY_INPUT: CollectorInput = {
  worktreePath: '/test/repo',
  fingerprint: 'abcdef0123456789abcdef01',
  allFiles: [],
  packageFiles: [],
  configFiles: [],
};

describe('discovery/diagnostics (#372)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Phase 1: Per-Collector Diagnostics ───────────────────────────────────

  describe('Phase 1: collector diagnostics', () => {
    it('runDiscovery produces diagnostics array for all 6 collectors', async () => {
      const result = await runDiscovery(EMPTY_INPUT);

      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics!.length).toBe(6);

      for (const diag of result.diagnostics!) {
        const parsed = CollectorDiagnosticSchema.safeParse(diag);
        expect(parsed.success).toBe(true);
        expect(diag.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof diag.timedOut).toBe('boolean');
      }

      // Schema validation passes with diagnostics present
      const schemaParsed = DiscoveryResultSchema.safeParse(result);
      expect(schemaParsed.success).toBe(true);
    });

    it('diagnostics are consistent with legacy collectors map', async () => {
      const result = await runDiscovery(EMPTY_INPUT);

      for (const diag of result.diagnostics!) {
        expect(result.collectors[diag.name]).toBe(diag.status);
      }
    });

    it('collector timeout produces timedOut diagnostic', async () => {
      const slowPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Collector timed out after 50ms')), 200);
      });

      const run = await runCollectorWithDiagnostics('test-collector', slowPromise as never, 50, {
        fallback: true,
      });

      expect(run.diagnostic.status).toBe('failed');
      expect(run.diagnostic.timedOut).toBe(true);
      expect(run.diagnostic.errorCode).toBe('COLLECTOR_TIMEOUT');
      expect(run.diagnostic.durationMs).toBeGreaterThanOrEqual(40);
      expect(run.data).toEqual({ fallback: true });
    });

    it('collector error produces errorCode diagnostic', async () => {
      const errorPromise = Promise.reject(new TypeError('Cannot read properties'));

      const run = await runCollectorWithDiagnostics(
        'broken-collector',
        errorPromise as never,
        10_000,
        { empty: true },
      );

      expect(run.diagnostic.status).toBe('failed');
      expect(run.diagnostic.timedOut).toBe(false);
      expect(run.diagnostic.errorCode).toBe('TypeError');
      expect(run.diagnostic.degradedReason).toContain('Cannot read properties');
      expect(run.data).toEqual({ empty: true });
    });

    it('partial collector records degradedReason', async () => {
      const partialPromise = Promise.resolve({
        status: 'partial' as const,
        data: { items: [] },
      });

      const run = await runCollectorWithDiagnostics('partial-collector', partialPromise, 10_000, {
        items: [],
      });

      expect(run.diagnostic.status).toBe('partial');
      expect(run.diagnostic.timedOut).toBe(false);
      expect(run.diagnostic.degradedReason).toBe('collector_reported_partial');
    });
  });

  // ─── Phase 2: Read/Parse Status ───────────────────────────────────────────

  describe('Phase 2: read outcomes', () => {
    it('ReadOutcomeSchema validates all valid outcomes', () => {
      const outcomes = ['read_ok', 'not_found', 'denied', 'parse_failed', 'too_large'];
      for (const o of outcomes) {
        expect(ReadOutcomeSchema.safeParse(o).success).toBe(true);
      }
    });

    it('ReadOutcomeSchema rejects invalid outcomes', () => {
      expect(ReadOutcomeSchema.safeParse('unknown').success).toBe(false);
      expect(ReadOutcomeSchema.safeParse(42).success).toBe(false);
    });

    it('code-surface collector records read statuses for unreadable files', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csa-read-'));
      try {
        // Create one readable and one that will not exist
        await fs.writeFile(path.join(tmpDir, 'good.ts'), 'const x = 1;');

        const input: CollectorInput = {
          worktreePath: tmpDir,
          fingerprint: 'abcdef0123456789abcdef01',
          allFiles: ['good.ts', 'missing.ts'],
          packageFiles: [],
          configFiles: [],
        };

        const result = await collectCodeSurfaces(input);
        expect(result.data.readStatuses).toBeDefined();
        expect(result.data.readStatuses!['good.ts']).toBe('read_ok');
        expect(result.data.readStatuses!['missing.ts']).toBe('not_found');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Phase 4: Code-Surface Partial Fix ────────────────────────────────────

  describe('Phase 4: code-surface partial calculation', () => {
    it('reports ok when source candidates < MAX_FILES even if total files > MAX_FILES', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csa-partial-'));
      try {
        // Create 10 source files
        for (let i = 0; i < 10; i++) {
          await fs.writeFile(path.join(tmpDir, `file${i}.ts`), `export const x${i} = ${i};`);
        }

        // Total files = 300 (many non-source), but only 10 source
        const allFiles: string[] = [];
        for (let i = 0; i < 10; i++) allFiles.push(`file${i}.ts`);
        for (let i = 0; i < 290; i++) allFiles.push(`doc${i}.md`);

        const input: CollectorInput = {
          worktreePath: tmpDir,
          fingerprint: 'abcdef0123456789abcdef01',
          allFiles,
          packageFiles: [],
          configFiles: [],
        };

        const result = await collectCodeSurfaces(input);
        // Key fix: partial should be based on source candidates (10), not total (300)
        expect(result.data.status).toBe('ok');
        expect(result.data.budget.totalSourceCandidates).toBe(10);
        expect(result.data.budget.budgetExhausted).toBe(false);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('reports partial when source candidates > MAX_FILES', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csa-budget-'));
      try {
        // We don't need 200+ real files — just craft allFiles to simulate
        const allFiles: string[] = [];
        for (let i = 0; i < 250; i++) allFiles.push(`src/module${i}.ts`);

        // Create just one file so the collector can read at least something
        await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'src', 'module0.ts'), 'export const a = 1;');

        const input: CollectorInput = {
          worktreePath: tmpDir,
          fingerprint: 'abcdef0123456789abcdef01',
          allFiles,
          packageFiles: [],
          configFiles: [],
        };

        const result = await collectCodeSurfaces(input);
        expect(result.data.status).toBe('partial');
        expect(result.data.budget.totalSourceCandidates).toBe(250);
        expect(result.data.budget.budgetExhausted).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('sorts deterministically: shallow files first, then alphabetical', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csa-sort-'));
      try {
        // Create files at different depths
        await fs.mkdir(path.join(tmpDir, 'deep', 'nested'), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, 'deep', 'nested', 'z.ts'),
          'export const deep = "deep-endpoint";\napp.get("/deep", () => {});',
        );
        await fs.writeFile(
          path.join(tmpDir, 'a.ts'),
          'export const shallow = "shallow-endpoint";\napp.get("/shallow", () => {});',
        );

        const input: CollectorInput = {
          worktreePath: tmpDir,
          fingerprint: 'abcdef0123456789abcdef01',
          // Intentionally list deep file first to test sorting
          allFiles: ['deep/nested/z.ts', 'a.ts'],
          packageFiles: [],
          configFiles: [],
        };

        const result = await collectCodeSurfaces(input);
        // Shallow file should be scanned first (a.ts has depth 1, deep/nested/z.ts has depth 3)
        const locations = result.data.endpoints.map((e) => e.location);
        expect(locations[0]).toMatch(/^a\.ts/);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('budget schema validates new fields', () => {
      const budget = {
        scannedFiles: 50,
        scannedBytes: 1024,
        maxFiles: 200,
        maxBytesPerFile: 65536,
        maxTotalBytes: 2097152,
        timedOut: false,
        totalSourceCandidates: 150,
        budgetExhausted: false,
      };
      const parsed = CodeSurfaceBudgetSchema.safeParse(budget);
      expect(parsed.success).toBe(true);
    });
  });

  // ─── Phase 5: Advisory Authority ──────────────────────────────────────────

  describe('Phase 5: advisory authority consolidation', () => {
    it('validationHints remains in DiscoveryResult for digest stability', async () => {
      const result = await runDiscovery(EMPTY_INPUT);
      expect(result.validationHints).toBeDefined();
      expect(result.validationHints.commands).toBeDefined();
      expect(result.validationHints.lintTools).toBeDefined();
    });

    it('DiscoveryResult schema still requires validationHints', () => {
      const incomplete = {
        schemaVersion: 'discovery.v1',
        collectedAt: new Date().toISOString(),
        collectors: {},
        repoMetadata: {
          defaultBranch: null,
          headCommit: null,
          isDirty: false,
          worktreePath: '/x',
          canonicalRemote: null,
          fingerprint: 'abcdef0123456789abcdef01',
        },
        stack: {
          languages: [],
          frameworks: [],
          buildTools: [],
          testFrameworks: [],
          runtimes: [],
        },
        topology: {
          kind: 'unknown',
          modules: [],
          entryPoints: [],
          rootConfigs: [],
          ignorePaths: [],
        },
        surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
        domainSignals: { keywords: [], glossarySources: [] },
        // Missing validationHints
      };
      const parsed = DiscoveryResultSchema.safeParse(incomplete);
      expect(parsed.success).toBe(false);
    });
  });

  // ─── Schema Backward Compat ───────────────────────────────────────────────

  describe('Schema backward compatibility', () => {
    it('DiscoveryResult without diagnostics field parses successfully', () => {
      const legacyResult = {
        schemaVersion: 'discovery.v1',
        collectedAt: new Date().toISOString(),
        collectors: { 'repo-metadata': 'complete' },
        repoMetadata: {
          defaultBranch: 'main',
          headCommit: 'abc123',
          isDirty: false,
          worktreePath: '/x',
          canonicalRemote: null,
          fingerprint: 'abcdef0123456789abcdef01',
        },
        stack: {
          languages: [],
          frameworks: [],
          buildTools: [],
          testFrameworks: [],
          runtimes: [],
        },
        topology: {
          kind: 'unknown',
          modules: [],
          entryPoints: [],
          rootConfigs: [],
          ignorePaths: [],
        },
        surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
        domainSignals: { keywords: [], glossarySources: [] },
        validationHints: { commands: [], lintTools: [] },
      };
      const parsed = DiscoveryResultSchema.safeParse(legacyResult);
      expect(parsed.success).toBe(true);
    });

    it('CodeSurfacesInfo without readStatuses/budget extensions parses', async () => {
      const legacy = {
        status: 'ok',
        endpoints: [],
        authBoundaries: [],
        dataAccess: [],
        integrations: [],
        budget: {
          scannedFiles: 10,
          scannedBytes: 1024,
          maxFiles: 200,
          maxBytesPerFile: 65536,
          maxTotalBytes: 2097152,
          timedOut: false,
        },
      };
      // Imported schema allows optional new fields
      const { CodeSurfacesInfoSchema } = await import('./types.js');
      const parsed = CodeSurfacesInfoSchema.safeParse(legacy);
      expect(parsed.success).toBe(true);
    });
  });

  // ─── Phase 7: Drift Detection ─────────────────────────────────────────────

  describe('Phase 7: stable drift digest', () => {
    it('computeStableDriftDigest returns deterministic hash', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const d2 = computeStableDriftDigest(result);
      expect(d1).toBe(d2);
      expect(d1.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(d1)).toBe(true);
    });

    it('stable digest unchanged when collectedAt differs', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const shifted = { ...result, collectedAt: new Date(Date.now() + 86_400_000).toISOString() };
      const d2 = computeStableDriftDigest(shifted);
      expect(d1).toBe(d2);
    });

    it('stable digest unchanged when diagnostics[].durationMs differs', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const shifted = {
        ...result,
        diagnostics: result.diagnostics!.map((d) => ({ ...d, durationMs: d.durationMs + 5000 })),
      };
      const d2 = computeStableDriftDigest(shifted);
      expect(d1).toBe(d2);
    });

    it('stable digest unchanged when both volatile fields differ', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const shifted = {
        ...result,
        collectedAt: new Date(Date.now() + 86_400_000).toISOString(),
        diagnostics: result.diagnostics!.map((d) => ({ ...d, durationMs: d.durationMs + 5000 })),
      };
      const d2 = computeStableDriftDigest(shifted);
      expect(d1).toBe(d2);
    });

    it('stable digest changes when collectors status differs', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const changed = {
        ...result,
        collectors: { ...result.collectors, 'repo-metadata': 'failed' as const },
      };
      const d2 = computeStableDriftDigest(changed);
      expect(d1).not.toBe(d2);
    });

    it('stable digest changes when stack content differs', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const d1 = computeStableDriftDigest(result);
      const changed = {
        ...result,
        stack: { ...result.stack, languages: [{ id: 'typescript', confidence: 1.0 }] },
      };
      const d2 = computeStableDriftDigest(changed);
      expect(d1).not.toBe(d2);
    });

    it('full digest changes when collectedAt changes, stable digest does not', async () => {
      const { computeStableDriftDigest } = await import('./discovery-digest.js');
      const result = await runDiscovery(EMPTY_INPUT);
      const full1 = computeDiscoveryDigest(result);
      const stable1 = computeStableDriftDigest(result);
      const shifted = { ...result, collectedAt: new Date(Date.now() + 86_400_000).toISOString() };
      const full2 = computeDiscoveryDigest(shifted);
      const stable2 = computeStableDriftDigest(shifted);
      expect(full1).not.toBe(full2);
      expect(stable1).toBe(stable2);
    });
  });

  describe('Phase 7b: checkDiscoveryDrift behavior', () => {
    it('unchanged repo with different timestamps reports drifted: false', async () => {
      // Use same worktree path so runDiscovery produces consistent metadata
      const result = await runDiscovery({
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: [],
        packageFiles: [],
        configFiles: [],
      });

      const { readDiscovery } = await import('../adapters/persistence-discovery.js');
      (readDiscovery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(result);

      const { listRepoSignals } = await import('../adapters/git.js');
      (listRepoSignals as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: [],
        packageFiles: [],
        configFiles: [],
        packageFilePaths: [],
        configFilePaths: [],
      });

      const { checkDiscoveryDrift } = await import('./drift.js');
      const drift = await checkDiscoveryDrift(
        '/workspace',
        '/test/repo',
        'abcdef0123456789abcdef01',
      );
      expect(drift.drifted).toBe(false);
      expect(drift.persistedDigest).toBeTypeOf('string');
    });

    it('changed content reports drifted: true without collector status changes', async () => {
      const persisted = await runDiscovery(EMPTY_INPUT);

      const { readDiscovery } = await import('../adapters/persistence-discovery.js');
      (readDiscovery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(persisted);

      const { listRepoSignals } = await import('../adapters/git.js');
      (listRepoSignals as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: ['src/index.ts'],
        packageFiles: ['package.json'],
        configFiles: ['tsconfig.json'],
        packageFilePaths: ['package.json'],
        configFilePaths: ['tsconfig.json'],
      });

      const { checkDiscoveryDrift } = await import('./drift.js');
      const drift = await checkDiscoveryDrift(
        '/workspace',
        '/test/ts-repo',
        'abcdef0123456789abcdef01',
      );
      expect(drift.drifted).toBe(true);
      expect(drift.currentDigest).not.toBe(drift.persistedDigest);
    });

    it('drifted: true with changedCollectors when collector status changes', async () => {
      const persisted = await runDiscovery(EMPTY_INPUT);
      // Mutate a collector status to 'failed'
      const tampered = {
        ...persisted,
        collectors: { ...persisted.collectors, 'stack-detection': 'failed' as const },
      };

      const { readDiscovery } = await import('../adapters/persistence-discovery.js');
      (readDiscovery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(tampered);

      const { listRepoSignals } = await import('../adapters/git.js');
      (listRepoSignals as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: [],
        packageFiles: [],
        configFiles: [],
        packageFilePaths: [],
        configFilePaths: [],
      });

      const { checkDiscoveryDrift } = await import('./drift.js');
      const drift = await checkDiscoveryDrift(
        '/workspace',
        '/test/repo',
        'abcdef0123456789abcdef01',
      );
      expect(drift.drifted).toBe(true);
      expect(drift.changedCollectors).toContain('stack-detection');
    });
  });
});
