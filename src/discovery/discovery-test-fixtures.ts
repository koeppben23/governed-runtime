/**
 * @module discovery/discovery-test-fixtures
 * @description DiscoveryResult fixtures for tests outside the discovery package.
 *
 * Tests outside discovery use this helper to construct canonical v2 artifacts.
 */

import { DISCOVERY_SCHEMA_VERSION, type DiscoveryResult } from './types.js';

export function makeDiscoveryResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    collectedAt: '2026-01-01T00:00:00.000Z',
    diagnostics: [
      { name: 'repo-metadata', status: 'complete', durationMs: 1, timedOut: false },
      { name: 'stack-detection', status: 'complete', durationMs: 1, timedOut: false },
      { name: 'topology', status: 'complete', durationMs: 1, timedOut: false },
      { name: 'surface-detection', status: 'complete', durationMs: 1, timedOut: false },
      { name: 'domain-signals', status: 'complete', durationMs: 1, timedOut: false },
    ],
    repoMetadata: {
      defaultBranch: 'main',
      headCommit: 'abc123',
      isDirty: false,
      worktreePath: '/repo',
      canonicalRemote: null,
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
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
      kind: 'single-project',
      modules: [{ path: 'src/auth', name: 'auth', manifestFile: 'package.json' }],
      entryPoints: [],
      rootConfigs: ['package.json', 'tsconfig.json'],
      ignorePaths: [],
    },
    surfaces: {
      api: [
        {
          id: 'login-route',
          label: 'Login API route',
          classification: 'fact',
          evidence: ['src/auth/login.ts'],
        },
      ],
      persistence: [],
      cicd: [],
      security: [],
      layers: [],
    },
    codeSurfaces: {
      status: 'ok',
      endpoints: [
        {
          id: 'login-handler',
          label: 'login handler',
          confidence: 0.9,
          classification: 'fact',
          evidence: ['src/auth/login.ts'],
          location: 'src/auth/login.ts',
        },
      ],
      authBoundaries: [],
      dataAccess: [],
      integrations: [],
      budget: {
        scannedFiles: 5,
        scannedBytes: 1000,
        maxFiles: 100,
        maxBytesPerFile: 100_000,
        maxTotalBytes: 1_000_000,
        timedOut: false,
        budgetExhausted: false,
      },
    },
    domainSignals: { keywords: [], glossarySources: [] },
    ...overrides,
  };
}
