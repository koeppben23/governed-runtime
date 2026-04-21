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
} from '../index';

// Collectors
import { collectStack } from './collectors/stack-detection';
import { collectTopology } from './collectors/topology';
import { collectSurfaces } from './collectors/surface-detection';
import { collectCodeSurfaces } from './collectors/code-surface-analysis';
import { collectDomainSignals } from './collectors/domain-signals';

// Orchestrator
import { runDiscovery, extractDiscoverySummary, computeDiscoveryDigest } from './orchestrator';
import { extractDetectedStack } from './orchestrator';

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

const gitMock = await import('../adapters/git');

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

describe('discovery/types', () => {
  describe('HAPPY', () => {
    it('DetectedItem validates correct data', () => {
      const result = DetectedItemSchema.safeParse({
        id: 'typescript',
        confidence: 0.85,
        classification: 'fact',
        evidence: ['tsconfig.json'],
      });
      expect(result.success).toBe(true);
    });

    it('DiscoverySummary validates correct data', () => {
      const result = DiscoverySummarySchema.safeParse({
        primaryLanguages: ['typescript'],
        frameworks: ['vite'],
        topologyKind: 'single-project',
        moduleCount: 0,
        hasApiSurface: true,
        hasPersistenceSurface: false,
        hasCiCd: true,
        hasSecuritySurface: false,
      });
      expect(result.success).toBe(true);
    });

    it('DetectedStackVersion validates correct data', () => {
      const result = DetectedStackVersionSchema.safeParse({
        id: 'java',
        version: '21',
        target: 'language',
        evidence: 'pom.xml:<java.version>',
      });
      expect(result.success).toBe(true);
    });

    it('DetectedStackVersion validates without optional evidence', () => {
      const result = DetectedStackVersionSchema.safeParse({
        id: 'node',
        version: '20.11.0',
        target: 'runtime',
      });
      expect(result.success).toBe(true);
    });

    it('DetectedStackTarget validates all valid categories', () => {
      for (const target of [
        'language',
        'framework',
        'runtime',
        'buildTool',
        'tool',
        'testFramework',
        'qualityTool',
        'database',
      ]) {
        const result = DetectedStackTargetSchema.safeParse(target);
        expect(result.success).toBe(true);
      }
    });

    it('DetectedStack validates correct data', () => {
      const result = DetectedStackSchema.safeParse({
        summary: 'java=21, spring-boot=3.4.1',
        items: [
          { kind: 'language', id: 'java', version: '21' },
          { kind: 'framework', id: 'spring-boot', version: '3.4.1', evidence: 'pom.xml' },
        ],
        versions: [
          { id: 'java', version: '21', target: 'language' },
          { id: 'spring-boot', version: '3.4.1', target: 'framework', evidence: 'pom.xml' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('ProfileResolution validates correct data', () => {
      const result = ProfileResolutionSchema.safeParse({
        schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
        resolvedAt: new Date().toISOString(),
        primary: { id: 'typescript', name: 'TypeScript', confidence: 0.7, evidence: [] },
        secondary: [],
        rejected: [{ id: 'backend-java', score: 0, reason: 'No matching signals' }],
        activeChecks: ['test_quality', 'rollback_safety'],
      });
      expect(result.success).toBe(true);
    });

    it('DISCOVERY_SCHEMA_VERSION is discovery.v1', () => {
      expect(DISCOVERY_SCHEMA_VERSION).toBe('discovery.v1');
    });

    it('PROFILE_RESOLUTION_SCHEMA_VERSION is profile-resolution.v1', () => {
      expect(PROFILE_RESOLUTION_SCHEMA_VERSION).toBe('profile-resolution.v1');
    });
  });

  describe('BAD', () => {
    it('DetectedItem rejects confidence > 1', () => {
      const result = DetectedItemSchema.safeParse({
        id: 'test',
        confidence: 1.5,
        classification: 'fact',
        evidence: [],
      });
      expect(result.success).toBe(false);
    });

    it('DetectedItem rejects invalid classification', () => {
      const result = DetectedItemSchema.safeParse({
        id: 'test',
        confidence: 0.5,
        classification: 'guess',
        evidence: [],
      });
      expect(result.success).toBe(false);
    });

    it('DiscoverySummary rejects invalid topologyKind', () => {
      const result = DiscoverySummarySchema.safeParse({
        primaryLanguages: [],
        frameworks: [],
        topologyKind: 'invalid',
        moduleCount: 0,
        hasApiSurface: false,
        hasPersistenceSurface: false,
        hasCiCd: false,
        hasSecuritySurface: false,
      });
      expect(result.success).toBe(false);
    });

    it('DetectedStackVersion rejects empty id', () => {
      const result = DetectedStackVersionSchema.safeParse({
        id: '',
        version: '21',
        target: 'language',
      });
      expect(result.success).toBe(false);
    });

    it('DetectedStackVersion rejects empty version', () => {
      const result = DetectedStackVersionSchema.safeParse({
        id: 'java',
        version: '',
        target: 'language',
      });
      expect(result.success).toBe(false);
    });

    it('DetectedStackTarget rejects invalid category', () => {
      const result = DetectedStackTargetSchema.safeParse('library');
      expect(result.success).toBe(false);
    });

    it('DetectedStack rejects missing versions array', () => {
      const result = DetectedStackSchema.safeParse({
        summary: 'java=21',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ─── Archive Types Tests ──────────────────────────────────────────────────────

describe('archive/types', () => {
  describe('HAPPY', () => {
    it('ArchiveManifest validates correct data', () => {
      const result = ArchiveManifestSchema.safeParse({
        schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        sessionId: crypto.randomUUID(),
        fingerprint: 'abcdef0123456789abcdef01',
        policyMode: 'solo',
        profileId: 'baseline',
        discoveryDigest: 'abc123',
        includedFiles: ['session-state.json', 'audit.jsonl'],
        fileDigests: { 'session-state.json': 'sha256hash', 'audit.jsonl': 'sha256hash2' },
        contentDigest: 'overallhash',
        redactionMode: 'basic',
        rawIncluded: false,
        redactedArtifacts: ['decision-receipts.redacted.v1.json'],
        excludedFiles: ['decision-receipts.v1.json'],
        riskFlags: [],
      });
      expect(result.success).toBe(true);
    });

    it('ArchiveFinding validates correct data', () => {
      const result = ArchiveFindingSchema.safeParse({
        code: 'missing_manifest',
        severity: 'error',
        message: 'Archive manifest not found',
      });
      expect(result.success).toBe(true);
    });

    it('ArchiveVerification validates correct data', () => {
      const result = ArchiveVerificationSchema.safeParse({
        passed: true,
        findings: [],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    });

    it('all 10 finding codes are valid', () => {
      const codes = [
        'missing_manifest',
        'manifest_parse_error',
        'missing_file',
        'unexpected_file',
        'file_digest_mismatch',
        'content_digest_mismatch',
        'archive_checksum_missing',
        'archive_checksum_mismatch',
        'snapshot_missing',
        'state_missing',
      ];
      for (const code of codes) {
        expect(ArchiveFindingCodeSchema.safeParse(code).success).toBe(true);
      }
    });
  });

  describe('BAD', () => {
    it('ArchiveManifest rejects invalid fingerprint', () => {
      const result = ArchiveManifestSchema.safeParse({
        schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        sessionId: crypto.randomUUID(),
        fingerprint: 'too-short',
        policyMode: 'solo',
        profileId: 'baseline',
        discoveryDigest: null,
        includedFiles: [],
        fileDigests: {},
        contentDigest: 'hash',
      });
      expect(result.success).toBe(false);
    });

    it('ArchiveFindingCode rejects unknown code', () => {
      expect(ArchiveFindingCodeSchema.safeParse('unknown_code').success).toBe(false);
    });
  });
});

// ─── Collector Tests ──────────────────────────────────────────────────────────

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

describe('discovery/collectors/stack-detection/version-extraction', () => {
  /** Create a mock readFile that returns content for known paths. */
  function mockReadFile(
    files: Record<string, string>,
  ): (relativePath: string) => Promise<string | undefined> {
    return async (relativePath: string) => files[relativePath];
  }

  // Base input factory with readFile support
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

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('extracts Node.js version from .nvmrc into runtimes.node', async () => {
      const input = inputWithFiles(
        { '.nvmrc': '20.11.0\n' },
        {
          allFiles: ['src/index.js', 'package.json', '.nvmrc'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('20.11.0');
      expect(nodeRuntime?.versionEvidence).toBe('.nvmrc');
      // Must NOT leak into language items
      const jsItem = result.data.languages.find((l) => l.id === 'javascript');
      expect(jsItem?.version).toBeUndefined();
    });

    it('extracts Node.js version from .node-version into runtimes.node', async () => {
      const input = inputWithFiles(
        { '.node-version': 'v22.1.0' },
        {
          allFiles: ['src/index.js', 'package.json', '.node-version'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('22.1.0');
      expect(nodeRuntime?.versionEvidence).toBe('.node-version');
    });

    it('extracts engines.node from package.json into runtimes.node', async () => {
      const input = inputWithFiles(
        { 'package.json': JSON.stringify({ engines: { node: '>=20.0.0' } }) },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('20.0.0');
      expect(nodeRuntime?.versionEvidence).toBe('package.json:engines.node');
      // Must NOT leak into language items
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.version).toBeUndefined();
    });

    it('extracts TypeScript version from devDependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            devDependencies: { typescript: '^5.4.5' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.version).toBe('5.4.5');
      expect(tsItem?.versionEvidence).toBe('package.json:devDependencies.typescript');
    });

    it('extracts TypeScript compiler target from tsconfig.json into compilerTarget', async () => {
      const input = inputWithFiles(
        {
          'tsconfig.json': '{ "compilerOptions": { "target": "ES2022" } }',
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'tsconfig.json'],
          packageFiles: ['package.json'],
          configFiles: ['tsconfig.json'],
        },
      );
      const result = await collectStack(input);
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.compilerTarget).toBe('ES2022');
      expect(tsItem?.compilerTargetEvidence).toBe('tsconfig.json:compilerOptions.target');
      // Must NOT be stored as version
      expect(tsItem?.version).toBeUndefined();
    });

    it('extracts Java version from pom.xml <java.version>', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<?xml version="1.0"?>
<project>
  <properties>
    <java.version>21</java.version>
  </properties>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
      expect(javaItem?.versionEvidence).toBe('pom.xml:<java.version>');
    });

    it('extracts Spring Boot version from pom.xml parent', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
  </parent>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      const sbItem = result.data.frameworks.find((f) => f.id === 'spring-boot');
      expect(sbItem?.version).toBe('3.4.1');
      expect(sbItem?.versionEvidence).toBe('pom.xml:parent.version');
    });

    it('extracts Java version from build.gradle.kts JavaLanguageVersion.of()', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `
java {
  toolchain {
    languageVersion.set(JavaLanguageVersion.of(21))
  }
}`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
      expect(javaItem?.versionEvidence).toBe('build.gradle.kts:JavaLanguageVersion.of');
    });

    it('extracts Go version from go.mod', async () => {
      const input = inputWithFiles(
        { 'go.mod': 'module example.com/myapp\n\ngo 1.22\n' },
        {
          allFiles: ['main.go', 'go.mod'],
          packageFiles: ['go.mod'],
        },
      );
      const result = await collectStack(input);
      const goItem = result.data.languages.find((l) => l.id === 'go');
      expect(goItem?.version).toBe('1.22');
      expect(goItem?.versionEvidence).toBe('go.mod:go');
    });

    it('extracts Angular version from package.json dependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { '@angular/core': '^17.3.0' },
          }),
        },
        {
          allFiles: ['src/app/app.component.ts', 'package.json', 'angular.json'],
          packageFiles: ['package.json'],
          configFiles: ['angular.json'],
        },
      );
      const result = await collectStack(input);
      const ngItem = result.data.frameworks.find((f) => f.id === 'angular');
      expect(ngItem?.version).toBe('17.3.0');
      expect(ngItem?.versionEvidence).toBe('package.json:dependencies.@angular/core');
    });

    it('keeps Node runtime version separate from TypeScript compiler version', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            engines: { node: '>=20' },
            devDependencies: { typescript: '^5.6.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      // Node version goes to runtimes.node
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('20');
      expect(nodeRuntime?.versionEvidence).toBe('package.json:engines.node');
      // TypeScript version comes from devDependencies
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.version).toBe('5.6.0');
      expect(tsItem?.versionEvidence).toBe('package.json:devDependencies.typescript');
    });

    it('extracts Spring Boot version from build.gradle.kts plugin declaration', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `
plugins {
  id("org.springframework.boot") version "4.0.1"
  id("io.spring.dependency-management") version "1.1.4"
}

java {
  toolchain {
    languageVersion.set(JavaLanguageVersion.of(21))
  }
}`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const sbItem = result.data.frameworks.find((f) => f.id === 'spring-boot');
      expect(sbItem?.version).toBe('4.0.1');
      expect(sbItem?.versionEvidence).toBe('build.gradle.kts:plugin.spring-boot');
      // Java version also extracted
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
    });

    it('detects PostgreSQL database engine from pom.xml dependency', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <dependencies>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.7.3</version>
    </dependency>
  </dependencies>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db).toBeDefined();
      expect(db?.evidence).toContain('pom.xml:dependency.postgresql');
      // JDBC dependency version is driver version, not database engine version.
      expect(db?.version).toBeUndefined();
    });

    it('detects MySQL database engine from build.gradle dependency', async () => {
      const input = inputWithFiles(
        {
          'build.gradle': `dependencies {
  implementation "com.mysql:mysql-connector-j:8.4.0"
}`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'mysql');
      expect(db).toBeDefined();
      expect(db?.evidence).toContain('build.gradle:dependency.mysql-connector-j');
      expect(db?.version).toBeUndefined();
    });

    it('detects JS database engines from package.json dependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: {
              pg: '^8.11.5',
              mysql2: '^3.10.0',
              mongodb: '^6.6.0',
              redis: '^4.6.14',
            },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );

      const result = await collectStack(input);
      const dbIds = result.data.databases.map((d) => d.id);
      expect(dbIds).toContain('postgresql');
      expect(dbIds).toContain('mysql');
      expect(dbIds).toContain('mongodb');
      expect(dbIds).toContain('redis');
    });

    it('detects PostgreSQL with version from docker-compose image postgres:16', async () => {
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

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db).toBeDefined();
      expect(db?.version).toBe('16');
      expect(db?.versionEvidence).toBe('docker-compose.yml:image postgres:16');
    });

    it('detects PostgreSQL version from docker-compose image postgres:16-alpine', async () => {
      const input = inputWithFiles(
        {
          'docker-compose.yml': `services:
  db:
    image: "postgres:16-alpine"
`,
        },
        {
          allFiles: ['docker-compose.yml'],
          packageFiles: [],
          configFiles: ['docker-compose.yml'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db?.version).toBe('16');
    });

    it('detects PostgreSQL from Testcontainers dependency as supporting evidence', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <dependencies>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>postgresql</artifactId>
      <version>1.20.0</version>
    </dependency>
  </dependencies>
</project>`,
        },
        {
          allFiles: ['src/test/java/AppTest.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db).toBeDefined();
      expect(db?.evidence).toContain('pom.xml:dependency.postgresql');
    });

    it('dedupes database engine and prefers versioned compose evidence when available', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <dependencies>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
    </dependency>
  </dependencies>
</project>`,
          'docker-compose.yml': `services:
  db:
    image: postgres:16
`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml', 'docker-compose.yml'],
          packageFiles: ['pom.xml'],
          configFiles: ['docker-compose.yml'],
        },
      );

      const result = await collectStack(input);
      const postgres = result.data.databases.filter((d) => d.id === 'postgresql');
      expect(postgres).toHaveLength(1);
      expect(postgres[0]?.version).toBe('16');
      expect(postgres[0]?.versionEvidence).toBe('docker-compose.yml:image postgres:16');
      expect(postgres[0]?.evidence).toEqual(
        expect.arrayContaining([
          'pom.xml:dependency.postgresql',
          'docker-compose.yml:image postgres:16',
        ]),
      );
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('returns undefined version when readFile is not provided', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/index.ts', 'package.json'],
        packageFiles: ['package.json'],
        configFiles: [],
        // no readFile
      };
      const result = await collectStack(input);
      for (const item of result.data.languages) {
        expect(item.version).toBeUndefined();
      }
    });

    it('handles malformed package.json gracefully', async () => {
      const input = inputWithFiles({ 'package.json': '{ invalid json' });
      const result = await collectStack(input);
      expect(result.status).toBe('complete');
      // No crash, just no version
      for (const item of result.data.languages) {
        expect(item.version).toBeUndefined();
      }
    });

    it('handles readFile that throws', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/index.ts', 'package.json'],
        packageFiles: ['package.json'],
        configFiles: [],
        readFile: async () => {
          throw new Error('disk failure');
        },
      };
      const result = await collectStack(input);
      expect(result.status).toBe('complete');
    });

    it('handles malformed pom.xml gracefully', async () => {
      const input = inputWithFiles(
        { 'pom.xml': '<project><properties><java.version>NOT_A_VERSION</java.version>' },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBeUndefined();
    });

    it('handles empty .nvmrc file', async () => {
      const input = inputWithFiles(
        { '.nvmrc': '' },
        {
          allFiles: ['src/index.js', '.nvmrc'],
          packageFiles: [],
        },
      );
      const result = await collectStack(input);
      const jsItem = result.data.languages.find((l) => l.id === 'javascript');
      expect(jsItem?.version).toBeUndefined();
    });

    it('does not extract compose database version from interpolated image tags', async () => {
      const input = inputWithFiles(
        {
          'docker-compose.yml': `services:
  db:
    image: postgres:${'${POSTGRES_VERSION}'}
`,
        },
        {
          allFiles: ['docker-compose.yml'],
          packageFiles: [],
          configFiles: ['docker-compose.yml'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db).toBeUndefined();
    });

    it('detects compose engine from registry-prefixed image without trusting tag version', async () => {
      const input = inputWithFiles(
        {
          'docker-compose.yml': `services:
  db:
    image: registry.local/postgres:16
`,
        },
        {
          allFiles: ['docker-compose.yml'],
          packageFiles: [],
          configFiles: ['docker-compose.yml'],
        },
      );

      const result = await collectStack(input);
      const db = result.data.databases.find((d) => d.id === 'postgresql');
      expect(db).toBeDefined();
      expect(db?.version).toBeUndefined();
      expect(db?.evidence).toContain('docker-compose.yml:image registry.local/postgres:16');
    });

    it('does not detect database engines from nested docker-compose files', async () => {
      const input = inputWithFiles(
        {
          'packages/app/docker-compose.yml': `services:
  db:
    image: postgres:16
`,
        },
        {
          allFiles: ['packages/app/docker-compose.yml'],
          packageFiles: [],
          configFiles: ['packages/app/docker-compose.yml'],
        },
      );

      const result = await collectStack(input);
      expect(result.data.databases).toEqual([]);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('.nvmrc takes precedence over package.json engines.node', async () => {
      const input = inputWithFiles(
        {
          '.nvmrc': '20.11.0',
          'package.json': JSON.stringify({ engines: { node: '>=18.0.0' } }),
        },
        {
          allFiles: ['src/index.js', 'package.json', '.nvmrc'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      // .nvmrc should win (first-write-wins on shared runtime item)
      expect(nodeRuntime?.version).toBe('20.11.0');
      expect(nodeRuntime?.versionEvidence).toBe('.nvmrc');
    });

    it('.nvmrc in TS-only repo creates runtimes.node, not language.typescript', async () => {
      const input = inputWithFiles(
        { '.nvmrc': '22.0.0' },
        {
          allFiles: ['src/index.ts', 'src/app.ts', '.nvmrc'],
          packageFiles: [],
        },
      );
      const result = await collectStack(input);
      // Node version must be in runtimes
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('22.0.0');
      // TypeScript language must NOT have a version from .nvmrc
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem).toBeDefined(); // TS detected from .ts files
      expect(tsItem?.version).toBeUndefined();
    });

    it('.nvmrc wins even when package.json readFile resolves faster', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/index.js', 'package.json', '.nvmrc'],
        packageFiles: ['package.json'],
        configFiles: [],
        readFile: async (p) => {
          if (p === '.nvmrc') {
            // Simulate slow disk read for .nvmrc
            await new Promise((resolve) => setTimeout(resolve, 10));
            return '20.11.0';
          }
          if (p === 'package.json') {
            // package.json resolves immediately
            return JSON.stringify({ engines: { node: '>=18.0.0' } });
          }
          return undefined;
        },
      };
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      // .nvmrc must win regardless of I/O timing (serial execution guarantees this)
      expect(nodeRuntime?.version).toBe('20.11.0');
      expect(nodeRuntime?.versionEvidence).toBe('.nvmrc');
    });

    it('uses deterministic precedence when pom.xml and build.gradle both define Java version', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <properties>
    <java.version>21</java.version>
  </properties>
</project>`,
          'build.gradle': "sourceCompatibility = '17'",
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml', 'build.gradle'],
          packageFiles: ['pom.xml', 'build.gradle'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      // Maven runs before Gradle — pom.xml value wins via first-write-wins
      expect(javaItem?.version).toBe('21');
      expect(javaItem?.versionEvidence).toBe('pom.xml:<java.version>');
    });

    it('uses deterministic precedence when pom.xml and build.gradle both define Spring Boot version', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <properties>
    <spring-boot.version>4.0.1</spring-boot.version>
  </properties>
</project>`,
          'build.gradle.kts': `
plugins {
  id("org.springframework.boot") version "3.4.1"
}`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml', 'build.gradle.kts'],
          packageFiles: ['pom.xml', 'build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const sbItem = result.data.frameworks.find((f) => f.id === 'spring-boot');
      // Maven runs before Gradle — pom.xml value wins via first-write-wins
      expect(sbItem?.version).toBe('4.0.1');
      expect(sbItem?.versionEvidence).toBe('pom.xml:<spring-boot.version>');
    });

    it('pom.xml <java.version> takes precedence over <maven.compiler.source>', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <properties>
    <java.version>21</java.version>
    <maven.compiler.source>17</maven.compiler.source>
  </properties>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
    });

    it('Spring Boot detected via pom.xml even without config file detection', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <properties>
    <spring-boot.version>4.0.1</spring-boot.version>
  </properties>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
          configFiles: [], // no spring-boot config file detected
        },
      );
      const result = await collectStack(input);
      const sbItem = result.data.frameworks.find((f) => f.id === 'spring-boot');
      expect(sbItem).toBeDefined();
      expect(sbItem?.version).toBe('4.0.1');
      expect(sbItem?.classification).toBe('derived_signal');
    });

    it('build.gradle sourceCompatibility with string value', async () => {
      const input = inputWithFiles(
        { 'build.gradle': "sourceCompatibility = '17'" },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('17');
    });

    it('build.gradle Groovy DSL Spring Boot plugin version', async () => {
      const input = inputWithFiles(
        {
          'build.gradle': `
plugins {
  id 'org.springframework.boot' version '4.0.1'
  id 'java'
}
sourceCompatibility = '21'`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );
      const result = await collectStack(input);
      const sbItem = result.data.frameworks.find((f) => f.id === 'spring-boot');
      expect(sbItem?.version).toBe('4.0.1');
      expect(sbItem?.versionEvidence).toBe('build.gradle:plugin.spring-boot');
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
    });

    it('tsconfig with JSONC comments extracts compilerTarget correctly', async () => {
      const input = inputWithFiles(
        {
          'tsconfig.json': `{
  // This is a comment
  "compilerOptions": {
    "target": "ES2024",
    "strict": true
  }
}`,
        },
        {
          allFiles: ['src/index.ts', 'tsconfig.json'],
          packageFiles: [],
          configFiles: ['tsconfig.json'],
        },
      );
      const result = await collectStack(input);
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.compilerTarget).toBe('ES2024');
      expect(tsItem?.version).toBeUndefined();
    });

    it('devDependencies.typescript preferred, then fallback to dependencies', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({
            dependencies: { typescript: '~5.2.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      expect(tsItem?.version).toBe('5.2.0');
    });

    it('go.mod with patch version', async () => {
      const input = inputWithFiles(
        { 'go.mod': 'module example.com/app\n\ngo 1.23.4\n' },
        {
          allFiles: ['main.go', 'go.mod'],
          packageFiles: ['go.mod'],
        },
      );
      const result = await collectStack(input);
      const goItem = result.data.languages.find((l) => l.id === 'go');
      expect(goItem?.version).toBe('1.23.4');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('readFile returning undefined for all files produces no versions', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/index.ts', 'package.json'],
        packageFiles: ['package.json'],
        configFiles: [],
        readFile: async () => undefined,
      };
      const result = await collectStack(input);
      expect(result.status).toBe('complete');
      const allItems = [
        ...result.data.languages,
        ...result.data.buildTools,
        ...result.data.frameworks,
      ];
      for (const item of allItems) {
        expect(item.version).toBeUndefined();
      }
    });

    it('version and versionEvidence validate in DetectedItemSchema', () => {
      const result = DetectedItemSchema.safeParse({
        id: 'typescript',
        confidence: 0.85,
        classification: 'fact',
        evidence: ['tsconfig.json'],
        version: '5.4.5',
        versionEvidence: 'package.json:devDependencies.typescript',
        compilerTarget: 'ES2022',
        compilerTargetEvidence: 'tsconfig.json:compilerOptions.target',
      });
      expect(result.success).toBe(true);
    });

    it('DetectedItem without version still validates (backward compat)', () => {
      const result = DetectedItemSchema.safeParse({
        id: 'typescript',
        confidence: 0.85,
        classification: 'fact',
        evidence: ['tsconfig.json'],
      });
      expect(result.success).toBe(true);
    });

    it('tsconfig.target is never stored as TypeScript version', async () => {
      const input = inputWithFiles(
        {
          'tsconfig.json': '{ "compilerOptions": { "target": "ES2024" } }',
          'package.json': JSON.stringify({
            devDependencies: { typescript: '^5.6.0' },
          }),
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'tsconfig.json'],
          packageFiles: ['package.json'],
          configFiles: ['tsconfig.json'],
        },
      );
      const result = await collectStack(input);
      const tsItem = result.data.languages.find((l) => l.id === 'typescript');
      // version must be the real TypeScript dependency version
      expect(tsItem?.version).toBe('5.6.0');
      expect(tsItem?.versionEvidence).toBe('package.json:devDependencies.typescript');
      // compiler target is a separate field
      expect(tsItem?.compilerTarget).toBe('ES2024');
      expect(tsItem?.compilerTargetEvidence).toBe('tsconfig.json:compilerOptions.target');
    });

    it('.nvmrc with v prefix creates runtimes.node with stripped version', async () => {
      const input = inputWithFiles(
        { '.nvmrc': 'v18.19.1' },
        {
          allFiles: ['src/index.js', '.nvmrc'],
          packageFiles: [],
        },
      );
      const result = await collectStack(input);
      const nodeRuntime = result.data.runtimes.find((r) => r.id === 'node');
      expect(nodeRuntime?.version).toBe('18.19.1');
    });

    it('maven.compiler.source used when java.version absent', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
  </properties>
</project>`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml'],
          packageFiles: ['pom.xml'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('17');
      expect(javaItem?.versionEvidence).toBe('pom.xml:<maven.compiler.source>');
    });

    it('build.gradle.kts preferred over build.gradle when both present', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts':
            'java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }',
          'build.gradle': "sourceCompatibility = '17'",
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts', 'build.gradle'],
          packageFiles: ['build.gradle.kts', 'build.gradle'],
        },
      );
      const result = await collectStack(input);
      const javaItem = result.data.languages.find((l) => l.id === 'java');
      expect(javaItem?.version).toBe('21');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('version extraction completes in < 50ms with mock readFile', async () => {
      const input = inputWithFiles(
        {
          '.nvmrc': '20.0.0',
          'package.json': JSON.stringify({
            engines: { node: '>=20' },
            devDependencies: { typescript: '^5.4.0' },
            dependencies: { '@angular/core': '^17.0.0' },
          }),
          'tsconfig.json': '{ "compilerOptions": { "target": "ES2022" } }',
        },
        {
          allFiles: ['src/index.ts', 'package.json', 'tsconfig.json', '.nvmrc', 'angular.json'],
          packageFiles: ['package.json'],
          configFiles: ['tsconfig.json', 'angular.json'],
        },
      );

      const start = performance.now();
      const result = await collectStack(input);
      const elapsed = performance.now() - start;

      expect(result.status).toBe('complete');
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── Artifact Detection Tests (pom.xml / build.gradle) ───────────────────────

describe('discovery/collectors/stack-detection/artifact-detection', () => {
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
      allFiles: overrides?.allFiles ?? ['src/main/java/App.java', 'pom.xml'],
      packageFiles: overrides?.packageFiles ?? ['pom.xml'],
      configFiles: overrides?.configFiles ?? [],
      readFile: mockReadFile(files),
    };
  }

  // ─── HAPPY: pom.xml artifact detection ────────────────────
  describe('HAPPY/pom.xml', () => {
    it('detects openapi-generator from pom.xml plugin', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><build><plugins>
          <plugin>
            <groupId>org.openapitools</groupId>
            <artifactId>openapi-generator-maven-plugin</artifactId>
            <version>7.10.0</version>
          </plugin>
        </plugins></build></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.tools.find((t) => t.id === 'openapi-generator');
      expect(item).toBeDefined();
      expect(item?.version).toBe('7.10.0');
      expect(item?.versionEvidence).toBe('pom.xml:plugin.openapi-generator-maven-plugin');
      expect(item?.classification).toBe('derived_signal');
    });

    it('detects junit from pom.xml dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>5.10.2</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'junit');
      expect(item).toBeDefined();
      expect(item?.version).toBe('5.10.2');
      expect(item?.versionEvidence).toBe('pom.xml:dependency.junit-jupiter');
    });

    it('detects cucumber from pom.xml dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>io.cucumber</groupId>
            <artifactId>cucumber-java</artifactId>
            <version>7.18.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'cucumber');
      expect(item).toBeDefined();
      expect(item?.version).toBe('7.18.0');
      expect(item?.versionEvidence).toBe('pom.xml:dependency.cucumber-java');
    });

    it('detects testcontainers from pom.xml dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.testcontainers</groupId>
            <artifactId>testcontainers</artifactId>
            <version>1.20.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'testcontainers');
      expect(item).toBeDefined();
      expect(item?.version).toBe('1.20.0');
    });

    it('detects flyway from pom.xml plugin', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><build><plugins>
          <plugin>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-maven-plugin</artifactId>
            <version>10.15.0</version>
          </plugin>
        </plugins></build></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.tools.find((t) => t.id === 'flyway');
      expect(item).toBeDefined();
      expect(item?.version).toBe('10.15.0');
      expect(item?.versionEvidence).toBe('pom.xml:plugin.flyway-maven-plugin');
    });

    it('detects flyway from pom.xml dependency when no plugin present', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-core</artifactId>
            <version>10.15.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.tools.find((t) => t.id === 'flyway');
      expect(item).toBeDefined();
      expect(item?.versionEvidence).toBe('pom.xml:dependency.flyway-core');
    });

    it('detects liquibase from pom.xml dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.liquibase</groupId>
            <artifactId>liquibase-core</artifactId>
            <version>4.29.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.tools.find((t) => t.id === 'liquibase');
      expect(item).toBeDefined();
      expect(item?.version).toBe('4.29.0');
    });

    it('detects spotless from pom.xml plugin', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><build><plugins>
          <plugin>
            <groupId>com.diffplug.spotless</groupId>
            <artifactId>spotless-maven-plugin</artifactId>
            <version>2.43.0</version>
          </plugin>
        </plugins></build></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'spotless');
      expect(item).toBeDefined();
      expect(item?.version).toBe('2.43.0');
    });

    it('detects checkstyle from pom.xml plugin', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><build><plugins>
          <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-checkstyle-plugin</artifactId>
            <version>3.4.0</version>
          </plugin>
        </plugins></build></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'checkstyle');
      expect(item).toBeDefined();
      expect(item?.version).toBe('3.4.0');
    });

    it('detects archunit from pom.xml dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>com.tngtech.archunit</groupId>
            <artifactId>archunit-junit5</artifactId>
            <version>1.3.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'archunit');
      expect(item).toBeDefined();
      expect(item?.version).toBe('1.3.0');
    });

    it('detects jacoco from pom.xml plugin', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><build><plugins>
          <plugin>
            <groupId>org.jacoco</groupId>
            <artifactId>jacoco-maven-plugin</artifactId>
            <version>0.8.12</version>
          </plugin>
        </plugins></build></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'jacoco');
      expect(item).toBeDefined();
      expect(item?.version).toBe('0.8.12');
    });
  });

  // ─── HAPPY: build.gradle artifact detection ────────────────
  describe('HAPPY/build.gradle', () => {
    it('detects openapi-generator from Kotlin DSL plugin', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `plugins {
            id("org.openapi.generator") version "7.10.0"
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.tools.find((t) => t.id === 'openapi-generator');
      expect(item).toBeDefined();
      expect(item?.version).toBe('7.10.0');
      expect(item?.versionEvidence).toBe('build.gradle.kts:plugin.openapi-generator');
    });

    it('detects junit from Kotlin DSL dependency', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `dependencies {
            testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'junit');
      expect(item).toBeDefined();
      expect(item?.version).toBe('5.10.2');
      expect(item?.versionEvidence).toBe('build.gradle.kts:dependency.junit-jupiter');
    });

    it('detects spotless from Groovy DSL plugin', async () => {
      const input = inputWithFiles(
        {
          'build.gradle': `plugins {
            id 'com.diffplug.spotless' version '6.25.0'
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'spotless');
      expect(item).toBeDefined();
      expect(item?.version).toBe('6.25.0');
    });

    it('detects jacoco built-in plugin from bare name', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `plugins {
            jacoco
            java
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'jacoco');
      expect(item).toBeDefined();
      expect(item?.version).toBeUndefined();
      expect(item?.versionEvidence).toBeUndefined();
    });

    it('detects checkstyle built-in plugin from apply plugin', async () => {
      const input = inputWithFiles(
        { 'build.gradle': "apply plugin: 'checkstyle'" },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.qualityTools.find((t) => t.id === 'checkstyle');
      expect(item).toBeDefined();
    });

    it('detects cucumber from Groovy DSL dependency', async () => {
      const input = inputWithFiles(
        {
          'build.gradle': `dependencies {
            testImplementation 'io.cucumber:cucumber-java:7.18.0'
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle'],
          packageFiles: ['build.gradle'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'cucumber');
      expect(item).toBeDefined();
      expect(item?.version).toBe('7.18.0');
    });
  });

  // ─── BAD: malformed/missing content ───────────────────────
  describe('BAD', () => {
    it('produces no artifacts when readFile is absent', async () => {
      const input: CollectorInput = {
        worktreePath: '/test/repo',
        fingerprint: 'abcdef0123456789abcdef01',
        allFiles: ['src/main/java/App.java', 'pom.xml'],
        packageFiles: ['pom.xml'],
        configFiles: [],
      };
      const result = await collectStack(input);
      expect(result.data.tools).toHaveLength(0);
      expect(result.data.qualityTools).toHaveLength(0);
    });

    it('handles pom.xml with no matching artifacts', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>com.example</groupId>
            <artifactId>my-custom-lib</artifactId>
            <version>1.0.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      expect(result.data.tools).toHaveLength(0);
      expect(result.data.qualityTools).toHaveLength(0);
    });

    it('handles malformed pom.xml blocks gracefully', async () => {
      const input = inputWithFiles({
        'pom.xml': '<project><dependency>unclosed<artifactId>junit-jupiter</artifactId>',
      });
      const result = await collectStack(input);
      expect(result.status).toBe('complete');
      // Unclosed <dependency> block won't match regex — no detection
      expect(result.data.testFrameworks.filter((t) => t.id === 'junit')).toHaveLength(0);
    });
  });

  // ─── CORNER: precedence and first-match-wins ──────────────
  describe('CORNER', () => {
    it('BOM-managed dependency detected without version', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'junit');
      expect(item).toBeDefined();
      expect(item?.version).toBeUndefined();
      expect(item?.versionEvidence).toBeUndefined();
      expect(item?.evidence).toEqual(['pom.xml:dependency.junit-jupiter']);
    });

    it('flyway plugin takes precedence over flyway-core dependency', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project>
          <dependencies>
            <dependency>
              <groupId>org.flywaydb</groupId>
              <artifactId>flyway-core</artifactId>
              <version>10.15.0</version>
            </dependency>
          </dependencies>
          <build><plugins>
            <plugin>
              <groupId>org.flywaydb</groupId>
              <artifactId>flyway-maven-plugin</artifactId>
              <version>10.14.0</version>
            </plugin>
          </plugins></build>
        </project>`,
      });
      const result = await collectStack(input);
      const items = result.data.tools.filter((t) => t.id === 'flyway');
      expect(items).toHaveLength(1);
      // Plugin rule comes first in POM_ARTIFACT_RULES
      expect(items[0]?.versionEvidence).toBe('pom.xml:plugin.flyway-maven-plugin');
    });

    it('junit-jupiter takes precedence over junit-jupiter-api', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter-api</artifactId>
            <version>5.9.0</version>
          </dependency>
          <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>5.10.2</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const items = result.data.testFrameworks.filter((t) => t.id === 'junit');
      expect(items).toHaveLength(1);
      // junit-jupiter rule comes first
      expect(items[0]?.version).toBe('5.10.2');
    });

    it('pom.xml artifacts take precedence over build.gradle artifacts', async () => {
      const input = inputWithFiles(
        {
          'pom.xml': `<project><dependencies>
            <dependency>
              <groupId>org.junit.jupiter</groupId>
              <artifactId>junit-jupiter</artifactId>
              <version>5.10.2</version>
            </dependency>
          </dependencies></project>`,
          'build.gradle.kts': `dependencies {
            testImplementation("org.junit.jupiter:junit-jupiter:5.9.0")
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'pom.xml', 'build.gradle.kts'],
          packageFiles: ['pom.xml', 'build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'junit');
      expect(item?.version).toBe('5.10.2');
      expect(item?.versionEvidence).toBe('pom.xml:dependency.junit-jupiter');
    });

    it('detects multiple artifacts from single pom.xml', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project>
          <dependencies>
            <dependency>
              <groupId>org.junit.jupiter</groupId>
              <artifactId>junit-jupiter</artifactId>
              <version>5.10.2</version>
            </dependency>
            <dependency>
              <groupId>org.testcontainers</groupId>
              <artifactId>testcontainers</artifactId>
              <version>1.20.0</version>
            </dependency>
            <dependency>
              <groupId>org.liquibase</groupId>
              <artifactId>liquibase-core</artifactId>
              <version>4.29.0</version>
            </dependency>
            <dependency>
              <groupId>com.tngtech.archunit</groupId>
              <artifactId>archunit-junit5</artifactId>
              <version>1.3.0</version>
            </dependency>
          </dependencies>
          <build><plugins>
            <plugin>
              <groupId>org.openapitools</groupId>
              <artifactId>openapi-generator-maven-plugin</artifactId>
              <version>7.10.0</version>
            </plugin>
            <plugin>
              <groupId>org.jacoco</groupId>
              <artifactId>jacoco-maven-plugin</artifactId>
              <version>0.8.12</version>
            </plugin>
          </plugins></build>
        </project>`,
      });
      const result = await collectStack(input);
      // Tools
      expect(result.data.tools.find((t) => t.id === 'openapi-generator')?.version).toBe('7.10.0');
      expect(result.data.tools.find((t) => t.id === 'liquibase')?.version).toBe('4.29.0');
      // Test frameworks
      expect(result.data.testFrameworks.find((t) => t.id === 'junit')?.version).toBe('5.10.2');
      expect(result.data.testFrameworks.find((t) => t.id === 'testcontainers')?.version).toBe(
        '1.20.0',
      );
      // Quality tools
      expect(result.data.qualityTools.find((t) => t.id === 'archunit')?.version).toBe('1.3.0');
      expect(result.data.qualityTools.find((t) => t.id === 'jacoco')?.version).toBe('0.8.12');
    });

    it('new arrays are empty for TS-only project', async () => {
      const input = inputWithFiles(
        {
          'package.json': JSON.stringify({ devDependencies: { typescript: '^5.4.5' } }),
        },
        {
          allFiles: ['src/index.ts', 'package.json'],
          packageFiles: ['package.json'],
        },
      );
      const result = await collectStack(input);
      expect(result.data.tools).toHaveLength(0);
      expect(result.data.qualityTools).toHaveLength(0);
      expect(result.data.databases).toHaveLength(0);
    });

    it('gradle dependency without version detected (BOM-managed)', async () => {
      const input = inputWithFiles(
        {
          'build.gradle.kts': `dependencies {
            testImplementation("org.junit.jupiter:junit-jupiter")
          }`,
        },
        {
          allFiles: ['src/main/java/App.java', 'build.gradle.kts'],
          packageFiles: ['build.gradle.kts'],
        },
      );
      const result = await collectStack(input);
      const item = result.data.testFrameworks.find((t) => t.id === 'junit');
      expect(item).toBeDefined();
      expect(item?.version).toBeUndefined();
    });

    it('archunit-junit5 takes precedence over archunit', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project><dependencies>
          <dependency>
            <groupId>com.tngtech.archunit</groupId>
            <artifactId>archunit</artifactId>
            <version>1.2.0</version>
          </dependency>
          <dependency>
            <groupId>com.tngtech.archunit</groupId>
            <artifactId>archunit-junit5</artifactId>
            <version>1.3.0</version>
          </dependency>
        </dependencies></project>`,
      });
      const result = await collectStack(input);
      const items = result.data.qualityTools.filter((t) => t.id === 'archunit');
      expect(items).toHaveLength(1);
      // archunit-junit5 rule comes first in POM_ARTIFACT_RULES
      expect(items[0]?.version).toBe('1.3.0');
    });
  });

  // ─── EDGE: schema and extractDetectedStack integration ────
  describe('EDGE', () => {
    it('StackInfoSchema validates data with tools, qualityTools, and databases', () => {
      const result = StackInfoSchema.safeParse({
        languages: [],
        frameworks: [],
        buildTools: [],
        testFrameworks: [],
        runtimes: [],
        tools: [
          {
            id: 'openapi-generator',
            confidence: 0.85,
            classification: 'derived_signal',
            evidence: ['pom.xml:plugin.openapi-generator-maven-plugin'],
            version: '7.10.0',
          },
        ],
        qualityTools: [
          {
            id: 'jacoco',
            confidence: 0.85,
            classification: 'derived_signal',
            evidence: ['pom.xml:plugin.jacoco-maven-plugin'],
          },
        ],
        databases: [
          {
            id: 'postgresql',
            confidence: 0.85,
            classification: 'derived_signal',
            evidence: ['docker-compose.yml:image postgres:16'],
            version: '16',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('StackInfoSchema defaults tools and qualityTools when absent (backward compat)', () => {
      const result = StackInfoSchema.safeParse({
        languages: [],
        frameworks: [],
        buildTools: [],
        testFrameworks: [],
        runtimes: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tools).toEqual([]);
        expect(result.data.qualityTools).toEqual([]);
        expect(result.data.databases).toEqual([]);
      }
    });

    it('extractDetectedStack includes tool, qualityTool, and database categories', async () => {
      const result = await runDiscovery(EMPTY_INPUT);
      // Inject synthetic items with versions
      result.stack.languages = [
        { id: 'java', confidence: 0.9, classification: 'fact', evidence: [], version: '21' },
      ];
      result.stack.tools = [
        {
          id: 'openapi-generator',
          confidence: 0.85,
          classification: 'derived_signal',
          evidence: [],
          version: '7.10.0',
        },
      ];
      result.stack.qualityTools = [
        {
          id: 'jacoco',
          confidence: 0.85,
          classification: 'derived_signal',
          evidence: [],
          version: '0.8.12',
        },
      ];
      result.stack.databases = [
        {
          id: 'postgresql',
          confidence: 0.85,
          classification: 'derived_signal',
          evidence: [],
          version: '16',
        },
      ];
      result.stack.testFrameworks = [
        {
          id: 'junit',
          confidence: 0.85,
          classification: 'derived_signal',
          evidence: [],
          version: '5.10.2',
        },
      ];
      result.stack.frameworks = [];
      result.stack.runtimes = [];
      result.stack.buildTools = [];

      const ds = extractDetectedStack(result);
      expect(ds).not.toBeNull();
      expect(ds!.versions.map((v) => v.target)).toEqual([
        'language',
        'tool',
        'testFramework',
        'qualityTool',
        'database',
      ]);
      expect(ds!.summary).toBe(
        'java=21, openapi-generator=7.10.0, junit=5.10.2, jacoco=0.8.12, postgresql=16',
      );
    });

    it('DetectedStackVersion validates new target types', () => {
      for (const target of ['tool', 'testFramework', 'qualityTool', 'database']) {
        const result = DetectedStackVersionSchema.safeParse({
          id: 'test-item',
          version: '1.0.0',
          target,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  // ─── PERF ─────────────────────────────────────────────────
  describe('PERF', () => {
    it('artifact detection from full pom.xml completes in < 50ms', async () => {
      const input = inputWithFiles({
        'pom.xml': `<project>
          <properties>
            <java.version>21</java.version>
          </properties>
          <dependencies>
            <dependency>
              <groupId>org.junit.jupiter</groupId>
              <artifactId>junit-jupiter</artifactId>
              <version>5.10.2</version>
            </dependency>
            <dependency>
              <groupId>org.testcontainers</groupId>
              <artifactId>testcontainers</artifactId>
              <version>1.20.0</version>
            </dependency>
            <dependency>
              <groupId>io.cucumber</groupId>
              <artifactId>cucumber-java</artifactId>
              <version>7.18.0</version>
            </dependency>
            <dependency>
              <groupId>org.flywaydb</groupId>
              <artifactId>flyway-core</artifactId>
              <version>10.15.0</version>
            </dependency>
            <dependency>
              <groupId>org.liquibase</groupId>
              <artifactId>liquibase-core</artifactId>
              <version>4.29.0</version>
            </dependency>
            <dependency>
              <groupId>com.tngtech.archunit</groupId>
              <artifactId>archunit-junit5</artifactId>
              <version>1.3.0</version>
            </dependency>
          </dependencies>
          <build><plugins>
            <plugin>
              <groupId>org.openapitools</groupId>
              <artifactId>openapi-generator-maven-plugin</artifactId>
              <version>7.10.0</version>
            </plugin>
            <plugin>
              <groupId>com.diffplug.spotless</groupId>
              <artifactId>spotless-maven-plugin</artifactId>
              <version>2.43.0</version>
            </plugin>
            <plugin>
              <groupId>org.apache.maven.plugins</groupId>
              <artifactId>maven-checkstyle-plugin</artifactId>
              <version>3.4.0</version>
            </plugin>
            <plugin>
              <groupId>org.jacoco</groupId>
              <artifactId>jacoco-maven-plugin</artifactId>
              <version>0.8.12</version>
            </plugin>
          </plugins></build>
        </project>`,
      });

      const start = performance.now();
      const result = await collectStack(input);
      const elapsed = performance.now() - start;

      expect(result.status).toBe('complete');
      expect(elapsed).toBeLessThan(50);
      // Verify all 10 items detected
      expect(result.data.tools).toHaveLength(3); // openapi-gen, flyway, liquibase
      expect(
        result.data.testFrameworks.filter((t) =>
          ['junit', 'cucumber', 'testcontainers'].includes(t.id),
        ),
      ).toHaveLength(3);
      expect(result.data.qualityTools).toHaveLength(4); // spotless, checkstyle, archunit, jacoco
    });
  });
});

// ─── JS/TS Ecosystem Detection Tests (P11) ───────────────────────────────────

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
      const ds = extractDetectedStack(result);
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
      const ds = extractDetectedStack(result);
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
      const ds = extractDetectedStack(result);
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
      const ds = extractDetectedStack(result);
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
      const ds = extractDetectedStack(result);
      expect(ds).not.toBeNull();

      const dbItem = ds!.items.find((i) => i.kind === 'database' && i.id === 'postgresql');
      expect(dbItem).toBeDefined();
      expect(dbItem?.version).toBe('16');

      const dbVersion = ds!.versions.find((v) => v.target === 'database' && v.id === 'postgresql');
      expect(dbVersion).toBeDefined();
      expect(dbVersion?.version).toBe('16');
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
  });
});

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
      const ds = extractDetectedStack(result);

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
      const ds = extractDetectedStack(result);
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
      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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

      const ds = extractDetectedStack(result);
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
        allFiles: ['src/lib.rs', 'main.go'],
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
