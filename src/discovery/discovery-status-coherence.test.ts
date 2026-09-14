import { describe, expect, it } from 'vitest';

import { extractDiscoveryHealth } from './discovery-health.js';
import { DiscoveryResultSchema, type DiscoveryResult } from './types.js';

const COMPLETE_DIAGNOSTICS = [
  { name: 'repo-metadata', status: 'complete', durationMs: 0, timedOut: false },
  { name: 'stack-detection', status: 'complete', durationMs: 0, timedOut: false },
  { name: 'topology', status: 'complete', durationMs: 0, timedOut: false },
  { name: 'surface-detection', status: 'complete', durationMs: 0, timedOut: false },
  { name: 'code-surface-analysis', status: 'complete', durationMs: 0, timedOut: false },
  { name: 'domain-signals', status: 'complete', durationMs: 0, timedOut: false },
] as const;

const BASE_RESULT = {
  schemaVersion: 'discovery.v2' as const,
  collectedAt: '2026-09-14T16:00:00.000Z',
  diagnostics: COMPLETE_DIAGNOSTICS,
  repoMetadata: {
    defaultBranch: 'main',
    headCommit: 'abc123',
    isDirty: false,
    worktreePath: '/repo',
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
    kind: 'single-project' as const,
    modules: [],
    entryPoints: [],
    rootConfigs: [],
    ignorePaths: [],
  },
  surfaces: {
    api: [],
    persistence: [],
    cicd: [],
    security: [],
    layers: [],
  },
  codeSurfaces: {
    status: 'ok' as const,
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
};

function withCodeSurfaceStatuses(
  outputStatus: 'ok' | 'partial' | 'failed',
  diagnosticStatus: 'complete' | 'partial' | 'failed',
) {
  return {
    ...BASE_RESULT,
    diagnostics: BASE_RESULT.diagnostics.map((diagnostic) =>
      diagnostic.name === 'code-surface-analysis'
        ? { ...diagnostic, status: diagnosticStatus }
        : diagnostic,
    ),
    codeSurfaces: { ...BASE_RESULT.codeSurfaces, status: outputStatus },
  };
}

describe('DiscoveryResult code-surface status coherence', () => {
  it('accepts the canonical ok/complete mapping', () => {
    expect(DiscoveryResultSchema.safeParse(withCodeSurfaceStatuses('ok', 'complete')).success).toBe(
      true,
    );
  });

  it('accepts matching degraded mappings', () => {
    expect(
      DiscoveryResultSchema.safeParse(withCodeSurfaceStatuses('partial', 'partial')).success,
    ).toBe(true);
    expect(
      DiscoveryResultSchema.safeParse(withCodeSurfaceStatuses('failed', 'failed')).success,
    ).toBe(true);
  });

  it('rejects failed output with a complete diagnostic', () => {
    expect(
      DiscoveryResultSchema.safeParse(withCodeSurfaceStatuses('failed', 'complete')).success,
    ).toBe(false);
  });

  it('rejects partial output with a complete diagnostic', () => {
    expect(
      DiscoveryResultSchema.safeParse(withCodeSurfaceStatuses('partial', 'complete')).success,
    ).toBe(false);
  });

  it('does not report an inconsistent code-surface failure as healthy even if schema validation is bypassed', () => {
    const inconsistent = withCodeSurfaceStatuses(
      'failed',
      'complete',
    ) as unknown as DiscoveryResult;
    expect(extractDiscoveryHealth(inconsistent).healthy).toBe(false);
  });
});
