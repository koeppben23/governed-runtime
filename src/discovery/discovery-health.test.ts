/**
 * @module discovery/discovery-health.test
 * @description Unit tests for extractDiscoveryHealth().
 *
 * Coverage:
 * - Healthy result (all complete, no budget/read issues)
 * - Degraded: failed collectors
 * - Degraded: partial collectors
 * - Degraded: budget exhaustion
 * - Degraded: read failures
 * - Degraded: multiple degradation types → healthy: false
 * - No healthy when any degradation present
 * - ageWarning computed from collectedAt
 * - ageWarning null for recent discovery
 * - ageWarning null for missing/NaN collectedAt
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDiscoveryHealthUnavailable,
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
} from './discovery-health.js';
import type {
  DiscoveryHealthAvailableProjection,
  DiscoveryHealthUnavailableReason,
} from './discovery-health.js';
import type { DiscoveryResult } from './types.js';
import { PersistenceError } from '../adapters/persistence.js';
import type { PersistenceErrorCode } from '../adapters/persistence.js';

function makeHealthyResult(overrides?: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    schemaVersion: 'discovery.v2',
    collectedAt: new Date().toISOString(),
    diagnostics: [
      { name: 'repo-metadata', status: 'complete', durationMs: 12, timedOut: false },
      { name: 'stack-detection', status: 'complete', durationMs: 34, timedOut: false },
      { name: 'topology', status: 'complete', durationMs: 8, timedOut: false },
      { name: 'surface-detection', status: 'complete', durationMs: 22, timedOut: false },
      { name: 'code-surface-analysis', status: 'complete', durationMs: 45, timedOut: false },
      { name: 'domain-signals', status: 'complete', durationMs: 5, timedOut: false },
    ],
    repoMetadata: {
      defaultBranch: null,
      headCommit: null,
      isDirty: false,
      worktreePath: '/test',
      canonicalRemote: null,
      fingerprint: 'abcdef0123456789abcdef01',
    },
    stack: {
      languages: [],
      frameworks: [],
      buildTools: [],
      testFrameworks: [],
      runtimes: [],
      tools: [],
      qualityTools: [],
      databases: [],
    },
    topology: {
      kind: 'unknown',
      modules: [],
      entryPoints: [],
      rootConfigs: [],
      ignorePaths: [],
    },
    surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
    codeSurfaces: {
      status: 'ok',
      endpoints: [],
      authBoundaries: [],
      dataAccess: [],
      integrations: [],
      budget: {
        scannedFiles: 0,
        scannedBytes: 0,
        maxFiles: 200,
        maxBytesPerFile: 65536,
        maxTotalBytes: 2097152,
        timedOut: false,
      },
    },
    domainSignals: { keywords: [], glossarySources: [] },
    ...overrides,
  };
}

function extractAvailableHealth(result: DiscoveryResult): DiscoveryHealthAvailableProjection {
  const health = extractDiscoveryHealth(result);
  if (health.status !== 'available') {
    throw new TypeError('Expected an available discovery health projection');
  }
  return health;
}

describe('discovery-health', () => {
  describe('extractDiscoveryHealth', () => {
    it('healthy result: all complete, no budget/read issues', () => {
      const result = makeHealthyResult();
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(true);
      expect(health.completeCollectors).toBe(6);
      expect(health.partialCollectors).toBe(0);
      expect(health.failedCollectors).toBe(0);
      expect(health.failedCollectorNames).toEqual([]);
      expect(health.hasBudgetExhaustion).toBe(false);
      expect(health.readFailureCount).toBe(0);
      expect(health.codeSurfaceStatus).toBe('ok');
      expect(health.kind).toBe('derived_discovery_health');
      expect(health.advisory).toBe(true);
      expect(health.source).toBe('persisted_discovery_result');
      expect(health.status).toBe('available');
    });

    it('healthy: false when a collector failed', () => {
      const result = makeHealthyResult({
        diagnostics: [
          { name: 'repo-metadata', status: 'complete', durationMs: 12, timedOut: false },
          {
            name: 'stack-detection',
            status: 'failed',
            durationMs: 34,
            timedOut: true,
            errorCode: 'TIMEOUT',
          },
          { name: 'topology', status: 'complete', durationMs: 8, timedOut: false },
          { name: 'surface-detection', status: 'complete', durationMs: 22, timedOut: false },
          { name: 'code-surface-analysis', status: 'complete', durationMs: 45, timedOut: false },
          { name: 'domain-signals', status: 'complete', durationMs: 5, timedOut: false },
        ],
      });
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.completeCollectors).toBe(5);
      expect(health.failedCollectors).toBe(1);
      expect(health.failedCollectorNames).toEqual(['stack-detection']);
      expect(health.partialCollectors).toBe(0);
    });

    it('healthy: false when a collector is partial', () => {
      const result = makeHealthyResult({
        diagnostics: [
          { name: 'repo-metadata', status: 'complete', durationMs: 12, timedOut: false },
          { name: 'stack-detection', status: 'complete', durationMs: 34, timedOut: false },
          { name: 'topology', status: 'complete', durationMs: 8, timedOut: false },
          {
            name: 'surface-detection',
            status: 'partial',
            durationMs: 22,
            timedOut: false,
            degradedReason: 'partial',
          },
          { name: 'code-surface-analysis', status: 'complete', durationMs: 45, timedOut: false },
          { name: 'domain-signals', status: 'complete', durationMs: 5, timedOut: false },
        ],
      });
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.completeCollectors).toBe(5);
      expect(health.partialCollectors).toBe(1);
      expect(health.failedCollectors).toBe(0);
    });

    it('healthy: false when budget is exhausted', () => {
      const result = makeHealthyResult({
        codeSurfaces: {
          status: 'partial',
          endpoints: [],
          authBoundaries: [],
          dataAccess: [],
          integrations: [],
          budget: {
            scannedFiles: 200,
            scannedBytes: 1024,
            maxFiles: 200,
            maxBytesPerFile: 65536,
            maxTotalBytes: 2097152,
            timedOut: false,
            totalSourceCandidates: 300,
            budgetExhausted: true,
          },
        },
      });
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.hasBudgetExhaustion).toBe(true);
      expect(health.codeSurfaceStatus).toBe('partial');
    });

    it('healthy: false when there are read failures', () => {
      const result = makeHealthyResult({
        codeSurfaces: {
          status: 'ok',
          endpoints: [],
          authBoundaries: [],
          dataAccess: [],
          integrations: [],
          budget: {
            scannedFiles: 10,
            scannedBytes: 512,
            maxFiles: 200,
            maxBytesPerFile: 65536,
            maxTotalBytes: 2097152,
            timedOut: false,
          },
          readStatuses: {
            'file1.ts': 'read_ok',
            'file2.ts': 'parse_failed',
            'file3.ts': 'not_found',
          },
        },
      });
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.readFailureCount).toBe(2);
    });

    it('multiple degradations: all counted correctly', () => {
      const result = makeHealthyResult({
        diagnostics: [
          { name: 'repo-metadata', status: 'complete', durationMs: 12, timedOut: false },
          {
            name: 'stack-detection',
            status: 'failed',
            durationMs: 34,
            timedOut: true,
            errorCode: 'TIMEOUT',
          },
          {
            name: 'topology',
            status: 'partial',
            durationMs: 8,
            timedOut: false,
            degradedReason: 'x',
          },
          { name: 'surface-detection', status: 'complete', durationMs: 22, timedOut: false },
          {
            name: 'code-surface-analysis',
            status: 'failed',
            durationMs: 45,
            timedOut: true,
            errorCode: 'ERROR',
          },
          { name: 'domain-signals', status: 'complete', durationMs: 5, timedOut: false },
        ],
        codeSurfaces: {
          status: 'partial',
          endpoints: [],
          authBoundaries: [],
          dataAccess: [],
          integrations: [],
          budget: {
            scannedFiles: 200,
            scannedBytes: 1024,
            maxFiles: 200,
            maxBytesPerFile: 65536,
            maxTotalBytes: 2097152,
            timedOut: false,
            budgetExhausted: true,
          },
          readStatuses: { 'a.ts': 'denied' },
        },
      });
      const health = extractAvailableHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.completeCollectors).toBe(3);
      expect(health.partialCollectors).toBe(1);
      expect(health.failedCollectors).toBe(2);
      expect(health.failedCollectorNames).toEqual(['stack-detection', 'code-surface-analysis']);
      expect(health.hasBudgetExhaustion).toBe(true);
      expect(health.readFailureCount).toBe(1);
    });

    it('ageWarning computed correctly for old discovery', () => {
      const oldDate = new Date(Date.now() - 48 * 3_600_000).toISOString();
      const result = makeHealthyResult({ collectedAt: oldDate });
      const health = extractAvailableHealth(result);
      expect(health.ageWarning).not.toBeNull();
      expect(health.ageWarning).toContain('48h');
    });

    it('ageWarning null for recent discovery', () => {
      const result = makeHealthyResult({ collectedAt: new Date().toISOString() });
      const health = extractAvailableHealth(result);
      expect(health.ageWarning).toBeNull();
    });

    it('ageWarning null when collectedAt is missing', () => {
      const result = makeHealthyResult({ collectedAt: '' as unknown as string });
      const health = extractAvailableHealth(result);
      expect(health.ageWarning).toBeNull();
    });
  });

  describe('unavailableDiscoveryHealth', () => {
    it.each([
      ['missing', 'Run /hydrate to recreate discovery artifacts'],
      ['corrupt', 'Repair or remove the corrupt discovery artifact'],
      ['schema_invalid', 'regenerate schema-valid discovery artifacts'],
      ['read_failed', 'Fix discovery artifact filesystem access'],
    ] as const)('projects %s as an explicit unavailable health state', (reason, recovery) => {
      const health = unavailableDiscoveryHealth(reason);

      expect(health).toMatchObject({
        kind: 'derived_discovery_health',
        advisory: true,
        source: 'persisted_discovery_result',
        status: 'unavailable',
        healthy: false,
        reason,
      });
      expect(health.recovery).toContain(recovery);
      expect(health.notVerified).toEqual([
        'Discovery health is unavailable; mark discovery-dependent claims NOT_VERIFIED.',
      ]);
    });
  });

  describe('classifyDiscoveryHealthUnavailable', () => {
    /**
     * Compile-time exhaustive mapping: adding a `PersistenceErrorCode` without
     * deciding its health classification fails the typecheck of this record.
     */
    const EXPECTED_BY_CODE: Record<PersistenceErrorCode, DiscoveryHealthUnavailableReason> = {
      PARSE_FAILED: 'corrupt',
      SCHEMA_VALIDATION_FAILED: 'schema_invalid',
      SESSION_STATE_INCOMPATIBLE: 'schema_invalid',
      READ_FAILED: 'read_failed',
      WRITE_FAILED: 'read_failed',
      LOCK_TIMEOUT: 'read_failed',
      LOCK_TIMEOUT_EXHAUSTED: 'read_failed',
    };

    it('maps every PersistenceErrorCode to its pinned unavailable reason', () => {
      for (const [code, expected] of Object.entries(EXPECTED_BY_CODE)) {
        expect(
          classifyDiscoveryHealthUnavailable(
            new PersistenceError(code as PersistenceErrorCode, 'x'),
          ),
          code,
        ).toBe(expected);
      }
      expect(Object.keys(EXPECTED_BY_CODE)).toHaveLength(7);
    });

    it('maps unknown errors and non-errors to read_failed', () => {
      expect(classifyDiscoveryHealthUnavailable(new Error('boom'))).toBe('read_failed');
      expect(classifyDiscoveryHealthUnavailable('not an error')).toBe('read_failed');
      expect(classifyDiscoveryHealthUnavailable(undefined)).toBe('read_failed');
    });
  });
});
