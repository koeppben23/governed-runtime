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

      const ds = await extractDetectedStack(result);
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
