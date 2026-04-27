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
