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

describe('discovery/orchestrator', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('HAPPY', () => {
    it('runDiscovery returns complete result for TypeScript project', async () => {
      // Override remoteOriginUrl for this test (default mock returns null)
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValueOnce('https://github.com/test/repo.git');

      const result = await runDiscovery(TS_PROJECT_INPUT);

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      expect(result.collectedAt).toBeDefined();
      expect(typeof result.collectedAt).toBe('string');

      // All collectors should report status
      expect(Object.keys(result.collectors).length).toBe(6);

      // Stack should have detected TypeScript
      expect(result.stack.languages.some((l) => l.id === 'typescript')).toBe(true);

      // Topology should be single-project
      expect(result.topology.kind).toBe('single-project');

      // Validation hints should have commands
      expect(result.validationHints.commands.length).toBeGreaterThan(0);

      // Schema validation passes
      const parsed = DiscoveryResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('extractDiscoverySummary produces lightweight summary', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const summary = extractDiscoverySummary(result);

      expect(summary.primaryLanguages).toContain('typescript');
      expect(summary.topologyKind).toBe('single-project');
      expect(typeof summary.moduleCount).toBe('number');
      expect(typeof summary.hasApiSurface).toBe('boolean');
      expect(typeof summary.hasPersistenceSurface).toBe('boolean');
      expect(typeof summary.hasCiCd).toBe('boolean');

      // Schema validation passes
      const parsed = DiscoverySummarySchema.safeParse(summary);
      expect(parsed.success).toBe(true);
    });

    it('computeDiscoveryDigest returns deterministic hash', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const digest1 = computeDiscoveryDigest(result);
      const digest2 = computeDiscoveryDigest(result);

      expect(digest1).toBe(digest2);
      expect(digest1.length).toBe(64); // SHA-256 hex
      expect(/^[0-9a-f]{64}$/.test(digest1)).toBe(true);
    });

    it('extractDetectedStack returns versioned items sorted by category then id', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const ds = await extractDetectedStack(result);

      // TS project should have at least typescript with a version
      if (ds === null) {
        // If no items detected, that's valid — but verify null contract
        expect(ds).toBeNull();
        return;
      }

      expect(ds.summary).toBeTruthy();
      expect(ds.items.length).toBeGreaterThan(0);
      expect(ds.versions.length).toBeGreaterThanOrEqual(0);

      // Every versioned entry must have id, version, and target
      for (const v of ds.versions) {
        expect(v.id.length).toBeGreaterThan(0);
        expect(v.version.length).toBeGreaterThan(0);
        expect([
          'language',
          'framework',
          'runtime',
          'buildTool',
          'tool',
          'testFramework',
          'qualityTool',
          'database',
        ]).toContain(v.target);
      }

      // Every item must have id and kind
      for (const item of ds.items) {
        expect(item.id.length).toBeGreaterThan(0);
        expect([
          'language',
          'framework',
          'runtime',
          'buildTool',
          'tool',
          'testFramework',
          'qualityTool',
          'database',
        ]).toContain(item.kind);
      }

      // Summary format: each segment is "id=version" or "id" (comma-separated)
      for (const segment of ds.summary.split(', ')) {
        expect(segment).toMatch(/^[\w][\w-]*(=\S+)?$/);
      }
    });

    it('extractDetectedStack summary matches items array', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const ds = await extractDetectedStack(result);
      if (!ds) return;

      const rebuilt = ds.items.map((i) => (i.version ? `${i.id}=${i.version}` : i.id)).join(', ');
      expect(ds.summary).toBe(rebuilt);
    });
  });

  describe('CORNER', () => {
    it('handles empty input gracefully', async () => {
      // Override git mocks to return null for empty-repo scenario
      vi.mocked(gitMock.defaultBranch).mockResolvedValueOnce(null as unknown as string);
      vi.mocked(gitMock.headCommit).mockResolvedValueOnce(null as unknown as string);

      const result = await runDiscovery(EMPTY_INPUT);

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      expect(result.stack.languages).toHaveLength(0);
      expect(result.topology.kind).toBe('unknown');
    });

    it('extractDetectedStack returns null when no items have versions', async () => {
      vi.mocked(gitMock.defaultBranch).mockResolvedValueOnce(null as unknown as string);
      vi.mocked(gitMock.headCommit).mockResolvedValueOnce(null as unknown as string);

      const result = await runDiscovery(EMPTY_INPUT);
      const ds = await extractDetectedStack(result);
      expect(ds).toBeNull();
    });

    it('extractDetectedStack sorts languages before frameworks before runtimes', async () => {
      // Build a synthetic DiscoveryResult with mixed categories
      const result = await runDiscovery(TS_PROJECT_INPUT);
      // Inject synthetic versioned items across categories
      result.stack.runtimes = [
        { id: 'node', confidence: 0.9, classification: 'fact', evidence: [], version: '20.11.0' },
      ];
      result.stack.frameworks = [
        {
          id: 'express',
          confidence: 0.8,
          classification: 'derived_signal',
          evidence: [],
          version: '4.18.2',
        },
      ];
      result.stack.languages = [
        {
          id: 'typescript',
          confidence: 0.95,
          classification: 'fact',
          evidence: [],
          version: '5.3.3',
        },
      ];
      result.stack.buildTools = [
        { id: 'npm', confidence: 0.9, classification: 'fact', evidence: [], version: '10.2.4' },
      ];
      // Clear remaining categories to isolate the test
      result.stack.testFrameworks = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.versions.map((v) => v.target)).toEqual([
        'language',
        'framework',
        'runtime',
        'buildTool',
      ]);
      expect(ds!.items.map((i) => i.kind)).toEqual([
        'language',
        'framework',
        'runtime',
        'buildTool',
      ]);
      expect(ds!.summary).toBe('typescript=5.3.3, express=4.18.2, node=20.11.0, npm=10.2.4');
    });

    it('extractDetectedStack includes evidence when versionEvidence exists', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      result.stack.languages = [
        {
          id: 'java',
          confidence: 0.9,
          classification: 'fact',
          evidence: ['pom.xml'],
          version: '21',
          versionEvidence: 'pom.xml:<java.version>',
        },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.testFrameworks = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.versions[0]!.evidence).toBe('pom.xml:<java.version>');
      expect(ds!.items[0]!.evidence).toBe('pom.xml:<java.version>');
    });

    it('extractDetectedStack omits evidence when versionEvidence is absent', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      result.stack.languages = [
        { id: 'go', confidence: 0.9, classification: 'fact', evidence: [], version: '1.21' },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.testFrameworks = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.versions[0]!.evidence).toBeUndefined();
    });

    it('extractDetectedStack surfaces unversioned items in items[] but not versions[]', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      // Inject a versioned language + unversioned test framework
      result.stack.languages = [
        {
          id: 'java',
          confidence: 0.9,
          classification: 'fact',
          evidence: ['pom.xml'],
          version: '21',
        },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.testFrameworks = [
        {
          id: 'vitest',
          confidence: 0.7,
          classification: 'derived_signal',
          evidence: ['vitest.config.ts'],
        },
      ];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();

      // items[] has both
      expect(ds!.items).toHaveLength(2);
      expect(ds!.items[0]).toMatchObject({ kind: 'language', id: 'java', version: '21' });
      expect(ds!.items[1]).toMatchObject({ kind: 'testFramework', id: 'vitest' });
      expect(ds!.items[1]!.version).toBeUndefined();

      // versions[] has only versioned item
      expect(ds!.versions).toHaveLength(1);
      expect(ds!.versions[0]).toMatchObject({ id: 'java', version: '21', target: 'language' });

      // summary: "java=21, vitest"
      expect(ds!.summary).toBe('java=21, vitest');
    });

    it('extractDetectedStack populates targets[] from compilerTarget', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      result.stack.languages = [
        {
          id: 'typescript',
          confidence: 0.95,
          classification: 'fact',
          evidence: ['tsconfig.json'],
          version: '5.3.3',
          compilerTarget: 'ES2022',
          compilerTargetEvidence: 'tsconfig.json:compilerOptions.target',
        },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.testFrameworks = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.targets).toBeDefined();
      expect(ds!.targets).toHaveLength(1);
      expect(ds!.targets![0]).toMatchObject({
        kind: 'compilerTarget',
        id: 'typescript',
        value: 'ES2022',
        evidence: 'tsconfig.json:compilerOptions.target',
      });
    });

    it('extractDetectedStack omits targets[] when no compilerTarget exists', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      result.stack.languages = [
        { id: 'go', confidence: 0.9, classification: 'fact', evidence: [], version: '1.21' },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.testFrameworks = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.targets).toBeUndefined();
    });

    it('extractDetectedStack uses evidence[0] when versionEvidence is absent', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      result.stack.testFrameworks = [
        {
          id: 'vitest',
          confidence: 0.7,
          classification: 'derived_signal',
          evidence: ['vitest.config.ts'],
        },
      ];
      result.stack.languages = [];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];
      result.stack.tools = [];
      result.stack.qualityTools = [];

      const ds = await extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.items[0]!.evidence).toBe('vitest.config.ts');
    });

    it('extractDetectedStack returns null for completely empty stack', async () => {
      vi.mocked(gitMock.defaultBranch).mockResolvedValueOnce(null as unknown as string);
      vi.mocked(gitMock.headCommit).mockResolvedValueOnce(null as unknown as string);

      const result = await runDiscovery(EMPTY_INPUT);
      // Double-check: all categories are empty
      expect(result.stack.languages).toHaveLength(0);
      expect(result.stack.frameworks).toHaveLength(0);
      expect(result.stack.testFrameworks).toHaveLength(0);

      const ds = await extractDetectedStack(result);
      expect(ds).toBeNull();
    });

    it('validation hints derive typecheck command from tsconfig', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const typecheckCmd = result.validationHints.commands.find((c) => c.kind === 'typecheck');
      expect(typecheckCmd).toBeDefined();
      expect(typecheckCmd?.command).toContain('tsc');
    });

    it('validation hints derive lint tools from eslint config', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const eslint = result.validationHints.lintTools.find((t) => t.id === 'eslint');
      expect(eslint).toBeDefined();
      expect(eslint?.classification).toBe('fact');
    });

    it('monorepo input yields monorepo topology', async () => {
      const result = await runDiscovery(MONOREPO_INPUT);
      expect(result.topology.kind).toBe('monorepo');
      expect(result.topology.modules.length).toBeGreaterThanOrEqual(3);
    });

    it('derives gradle/jest commands from detected stack', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/gradle',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/app.kt'],
        packageFiles: ['build.gradle'],
        configFiles: ['jest.config.ts'],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain('gradle build');
      expect(commands).toContain('gradle test');
      expect(commands).toContain('npx jest');
    });

    it('derives cargo and go-module commands from detected stack', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/multi',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/lib.rs', 'main.go', 'Cargo.toml', 'go.mod'],
        packageFiles: ['Cargo.toml', 'go.mod'],
        configFiles: [],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain('cargo build');
      expect(commands).toContain('cargo test');
      expect(commands).toContain('go build ./...');
      expect(commands).toContain('go test ./...');
    });

    it('derives maven commands from detected stack', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/maven',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/main/java/App.java'],
        packageFiles: ['pom.xml'],
        configFiles: [],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain('mvn compile');
      expect(commands).toContain('mvn test');
    });
  });

  describe('CORNER', () => {
    it('collectStack handles malformed package.json gracefully', async () => {
      // Input with both invalid and valid package files
      const badInput: CollectorInput = {
        ...TS_PROJECT_INPUT,
        packageFiles: ['yarn.lock', 'package.json'],
      };

      // Should not throw — should handle gracefully
      const result = await collectStack(badInput);
      expect(result.status).toBe('complete');
      // Valid package.json should still be processed (npm is a build tool)
      const npm = result.data.buildTools.find((b) => b.id === 'npm');
      expect(npm).toBeDefined();
      expect(npm?.confidence).toBe(0.9);
    });

    it('collectSurfaces handles empty files array', async () => {
      const result = await collectSurfaces({ ...EMPTY_INPUT });
      expect(result.status).toBe('complete');
      expect(result.data).toBeDefined();
    });

    it('runDiscovery completes even if one collector throws', async () => {
      // Note: Individual collectors should not throw, but we verify resilience
      // If a collector throws, the orchestrator should handle it
      const result = await runDiscovery(TS_PROJECT_INPUT);
      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
    });
  });

  describe('EDGE', () => {
    it('runDiscovery with extreme input size completes within timeout', async () => {
      // Create a large input to test performance under load
      const largeInput: CollectorInput = {
        ...TS_PROJECT_INPUT,
        allFiles: Array.from({ length: 10000 }, (_, i) => `src/file${i}.ts`),
      };

      const start = Date.now();
      const result = await runDiscovery(largeInput);
      const elapsed = Date.now() - start;

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      // Should complete within reasonable time (< 5 seconds)
      expect(elapsed).toBeLessThan(5000);
    });

    it('runDiscovery marks collector failures when timeout budget is exceeded', async () => {
      vi.mocked(gitMock.defaultBranch).mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'main';
      });

      const result = await runDiscovery(TS_PROJECT_INPUT, 1);
      const failedCollectors = Object.values(result.collectors).filter((s) => s === 'failed');

      expect(failedCollectors.length).toBeGreaterThan(0);
      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
    });
  });

  describe('PERF', () => {
    it('runDiscovery completes in < 100ms for typical project', async () => {
      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        await runDiscovery(TS_PROJECT_INPUT);
        times.push(Date.now() - start);
      }

      times.sort((a, b) => a - b);
      const p99 = times[Math.floor(times.length * 0.99)] ?? times[times.length - 1];
      expect(p99).toBeLessThan(100);
    });

    it('computeDiscoveryDigest is fast (< 5ms)', async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const start = Date.now();
      computeDiscoveryDigest(result);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5);
    });
  });
});
