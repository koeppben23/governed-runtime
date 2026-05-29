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
 * - Missing diagnostics: sensible defaults
 * - Missing codeSurfaces: null status, no budget/read data
 * - ageWarning computed from collectedAt
 * - ageWarning null for recent discovery
 * - ageWarning null for missing/NaN collectedAt
 */

import { describe, it, expect } from 'vitest';
import { extractDiscoveryHealth } from './discovery-health.js';
import type { DiscoveryResult } from './types.js';

function makeHealthyResult(overrides?: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    schemaVersion: 'discovery.v1',
    collectedAt: new Date().toISOString(),
    collectors: {
      'repo-metadata': 'complete',
      'stack-detection': 'complete',
      topology: 'complete',
      'surface-detection': 'complete',
      'code-surface-analysis': 'complete',
      'domain-signals': 'complete',
    },
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
    ...overrides,
  };
}

describe('discovery-health', () => {
  describe('extractDiscoveryHealth', () => {
    it('healthy result: all complete, no budget/read issues', () => {
      const result = makeHealthyResult();
      const health = extractDiscoveryHealth(result);
      expect(health.healthy).toBe(true);
      expect(health.completeCollectors).toBe(6);
      expect(health.partialCollectors).toBe(0);
      expect(health.failedCollectors).toBe(0);
      expect(health.failedCollectorNames).toEqual([]);
      expect(health.hasBudgetExhaustion).toBe(false);
      expect(health.readFailureCount).toBe(0);
      expect(health.codeSurfaceStatus).toBe(null);
      expect(health.kind).toBe('derived_discovery_health');
      expect(health.advisory).toBe(true);
      expect(health.source).toBe('persisted_discovery_result');
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
      const health = extractDiscoveryHealth(result);
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
      const health = extractDiscoveryHealth(result);
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
      const health = extractDiscoveryHealth(result);
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
      const health = extractDiscoveryHealth(result);
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
      const health = extractDiscoveryHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.completeCollectors).toBe(3);
      expect(health.partialCollectors).toBe(1);
      expect(health.failedCollectors).toBe(2);
      expect(health.failedCollectorNames).toEqual(['stack-detection', 'code-surface-analysis']);
      expect(health.hasBudgetExhaustion).toBe(true);
      expect(health.readFailureCount).toBe(1);
    });

    it('missing diagnostics: defaults to zero counts', () => {
      const result = makeHealthyResult({ diagnostics: undefined });
      const health = extractDiscoveryHealth(result);
      expect(health.completeCollectors).toBe(0);
      expect(health.partialCollectors).toBe(0);
      expect(health.failedCollectors).toBe(0);
      expect(health.failedCollectorNames).toEqual([]);
      expect(health.healthy).toBe(true);
    });

    it('missing codeSurfaces: null status, no budget/read data', () => {
      const result = makeHealthyResult({ codeSurfaces: undefined });
      const health = extractDiscoveryHealth(result);
      expect(health.codeSurfaceStatus).toBe(null);
      expect(health.hasBudgetExhaustion).toBe(false);
      expect(health.readFailureCount).toBe(0);
    });

    it('ageWarning computed correctly for old discovery', () => {
      const oldDate = new Date(Date.now() - 48 * 3_600_000).toISOString();
      const result = makeHealthyResult({ collectedAt: oldDate });
      const health = extractDiscoveryHealth(result);
      expect(health.ageWarning).not.toBeNull();
      expect(health.ageWarning).toContain('48h');
    });

    it('ageWarning null for recent discovery', () => {
      const result = makeHealthyResult({ collectedAt: new Date().toISOString() });
      const health = extractDiscoveryHealth(result);
      expect(health.ageWarning).toBeNull();
    });

    it('ageWarning null when collectedAt is missing', () => {
      const result = makeHealthyResult({ collectedAt: '' as unknown as string });
      const health = extractDiscoveryHealth(result);
      expect(health.ageWarning).toBeNull();
    });
  });
});
