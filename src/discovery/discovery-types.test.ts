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

    it('all 11 finding codes are valid', () => {
      const codes = [
        'missing_manifest',
        'manifest_parse_error',
        'missing_file',
        'unexpected_file',
        'file_digest_mismatch',
        'content_digest_mismatch',
        'archive_checksum_missing',
        'archive_checksum_mismatch',
        'audit_chain_invalid',
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
