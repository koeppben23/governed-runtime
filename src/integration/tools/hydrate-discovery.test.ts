/**
 * @module integration/tools/hydrate-discovery.test
 * @description Tests for hydrate-discovery pure functions — evidence building,
 *              profile resolution assembly, and candidate collection.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import {
  buildProfileEvidence,
  buildProfileResolution,
  collectProfileCandidates,
} from './hydrate-discovery.js';
import type { FlowGuardProfile } from '../../config/profile-registry.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import type { RepoSignals } from '../../adapters/git.js';
import type { HydrateConfig } from './hydrate.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function profile(overrides: Partial<FlowGuardProfile> = {}): FlowGuardProfile {
  return {
    id: 'node-typescript',
    name: 'Node.js / TypeScript',
    detect: () => 0.9,
    activeChecks: ['test_quality', 'lint_check'],
    profileRules: { plan: [], implement: [], arch: [], review: [] },
    ...overrides,
  } as FlowGuardProfile;
}

function detectionInput(overrides = {}) {
  return {
    repoSignals: {
      packageFiles: ['package.json'],
      configFiles: ['tsconfig.json'],
    } as RepoSignals,
    discovery: {
      schemaVersion: 1,
      stack: {
        languages: [{ id: 'typescript', name: 'TypeScript', version: '5.0' }],
        frameworks: [{ id: 'node', name: 'Node.js', version: '20' }],
      },
    } as unknown as DiscoveryResult,
    ...overrides,
  };
}

function hydrateConfig(overrides = {}): HydrateConfig {
  return {
    idp: null,
    trustAnchors: [],
    tsaUrl: '',
    profile: { defaultId: '', activeChecks: [] },
    policy: {
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 5,
      requireVerifiedActorsForApproval: false,
      identityProvider: null,
      identityProviderMode: 'optional' as const,
      minimumActorAssuranceForApproval: null,
      enforceRiskClassification: false,
      allowRiskDowngradeOverride: false,
      allowReducedCeremony: false,
    },
    ...overrides,
  } as HydrateConfig;
}

// ─── buildProfileEvidence ─────────────────────────────────────────────────────

describe('buildProfileEvidence', () => {
  it('finds matching package files', () => {
    const evidence = buildProfileEvidence(profile({ id: 'node-typescript' }), detectionInput());
    expect(evidence).toContain('packageFile:package.json');
  });

  it('finds matching languages', () => {
    const evidence = buildProfileEvidence(profile({ id: 'typescript' }), detectionInput());
    expect(evidence).toContain('language:typescript');
  });

  it('finds matching frameworks', () => {
    const evidence = buildProfileEvidence(profile({ id: 'node-default' }), detectionInput());
    expect(evidence).toContain('framework:node');
  });

  it('returns empty array when nothing matches', () => {
    const evidence = buildProfileEvidence(profile({ id: 'python-django' }), detectionInput());
    expect(evidence).toHaveLength(0);
  });

  it('detects Python profile via pyproject.toml', () => {
    const input = detectionInput({
      repoSignals: { packageFiles: ['pyproject.toml'], configFiles: [] },
    });
    const evidence = buildProfileEvidence(profile({ id: 'python' }), input);
    expect(evidence).toContain('packageFile:pyproject.toml');
  });
});

// ─── buildProfileResolution ───────────────────────────────────────────────────

describe('buildProfileResolution', () => {
  it('uses primary profile id and name when selected', () => {
    const resolution = buildProfileResolution(
      detectionInput(),
      profile({ id: 'node-typescript', name: 'Node.js / TypeScript' }),
      hydrateConfig(),
      '2026-01-01T00:00:00.000Z',
    );
    expect(resolution.primary.id).toBe('node-typescript');
    expect(resolution.primary.name).toBe('Node.js / TypeScript');
  });

  it('defaults to baseline when no profile selected', () => {
    const resolution = buildProfileResolution(
      detectionInput(),
      undefined,
      hydrateConfig(),
      '2026-01-01T00:00:00.000Z',
    );
    expect(resolution.primary.id).toBe('baseline');
    expect(resolution.primary.name).toBe('Baseline FlowGuard');
  });

  it('includes secondary and rejected candidates', () => {
    const resolution = buildProfileResolution(
      detectionInput(),
      profile({ id: 'node-typescript' }),
      hydrateConfig(),
      '2026-01-01T00:00:00.000Z',
    );
    expect(Array.isArray(resolution.secondary)).toBe(true);
    expect(Array.isArray(resolution.rejected)).toBe(true);
  });

  it('preserves activeChecks from config when profile has none', () => {
    const config = hydrateConfig({
      profile: { defaultId: '', activeChecks: ['config_check'] },
    });
    const resolution = buildProfileResolution(
      detectionInput(),
      profile({ id: 'custom', activeChecks: undefined }),
      config,
      '2026-01-01T00:00:00.000Z',
    );
    expect(resolution.activeChecks).toContain('config_check');
  });
});

// ─── collectProfileCandidates ─────────────────────────────────────────────────

describe('collectProfileCandidates', () => {
  it('groups candidates into secondary (score > 0) and rejected (score = 0)', () => {
    const candidates = collectProfileCandidates(
      detectionInput(),
      profile({ id: 'node-typescript' }),
    );
    for (const s of candidates.secondary) {
      expect(s.confidence).toBeGreaterThan(0);
    }
    for (const r of candidates.rejected) {
      expect(r.score).toBe(0);
    }
  });
});
