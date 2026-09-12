/**
 * @module integration/review/discovery-provenance-projection
 * @description Regression coverage for reviewer-visible Discovery provenance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeState } from '../../fixtures.js';
import { RepositoryDiscoverySnapshot } from '../../state/evidence-review-attempt-discovery.js';
import { buildReviewDiscoveryContext } from './discovery-context-loader.js';
import {
  buildDiscoveryContextSection,
  buildRepositoryDiscoverySnapshotSection,
  type DiscoveryReviewContext,
} from './discovery-context-prompt.js';
import { resolveReviewAttemptDiscoveryContext } from './discovery-attempt-context.js';

vi.mock('./discovery-context-loader.js', () => ({
  buildReviewDiscoveryContext: vi.fn(),
}));

const NOW = '2026-09-12T19:10:19.767Z';
const DISCOVERY_DIGEST = 'd'.repeat(64);
const CURRENT_DIGEST = 'c'.repeat(64);
const PERSISTED_DRIFT_DIGEST = 'p'.repeat(64);
const CANDIDATE_ID = `vc_${'1'.repeat(64)}`;

function reviewContext(): DiscoveryReviewContext {
  return {
    health: {
      kind: 'derived_discovery_health',
      advisory: true,
      source: 'persisted_discovery_result',
      status: 'available',
      completeCollectors: 6,
      partialCollectors: 0,
      failedCollectors: 0,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      readFailureCount: 0,
      codeSurfaceStatus: 'ok',
      collectedAt: NOW,
      ageWarning: null,
      healthy: true,
    },
    drift: {
      kind: 'derived_discovery_drift',
      advisory: true,
      runtimeOnly: true,
      source: 'checkDiscoveryDrift',
      status: 'drifted',
      drifted: true,
      currentDigest: CURRENT_DIGEST,
      persistedDigest: PERSISTED_DRIFT_DIGEST,
      changedContributorNames: ['code-surface-analysis'],
      diagnostics: [],
      notVerified: ['NOT_VERIFIED: Discovery drift is advisory.'],
      warnings: [],
    },
    verificationCandidates: [
      {
        candidateId: CANDIDATE_ID,
        assertionCapability: 'unsupported',
        kind: 'test',
        command: 'npm run test --',
        source: 'package.json:scripts.test',
        confidence: 'high',
        reason: 'repo-native test script',
      },
    ],
  };
}

function snapshot() {
  return RepositoryDiscoverySnapshot.parse({
    observedAt: NOW,
    discoveryDigest: DISCOVERY_DIGEST,
    workspaceFingerprint: 'workspace-fingerprint',
    health: {
      status: 'available',
      healthy: true,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: [],
    },
    drift: {
      status: 'drifted',
      drifted: true,
      currentDigest: CURRENT_DIGEST,
      persistedDigest: PERSISTED_DRIFT_DIGEST,
      changedContributorNames: ['code-surface-analysis'],
      notVerified: ['NOT_VERIFIED: Discovery drift is advisory.'],
    },
    detectedStack: null,
    verificationCandidates: [
      {
        candidateId: CANDIDATE_ID,
        kind: 'test',
        command: 'npm run test --',
        source: 'package.json:scripts.test',
        confidence: 'high',
      },
    ],
    riskSurfaces: [],
    warnings: [],
    notVerified: [],
  });
}

describe('Discovery reviewer provenance projection', () => {
  beforeEach(() => {
    vi.mocked(buildReviewDiscoveryContext).mockReset();
  });

  it('renders correlation identities in the live Discovery review context', () => {
    const section = buildDiscoveryContextSection(reviewContext());

    expect(section).toContain(`currentDigest: ${CURRENT_DIGEST}`);
    expect(section).toContain(`persistedDigest: ${PERSISTED_DRIFT_DIGEST}`);
    expect(section).toContain(`candidateId: ${CANDIDATE_ID}`);
  });

  it('renders the same correlation identities in the attempt-bound snapshot', () => {
    const section = buildRepositoryDiscoverySnapshotSection(snapshot());

    expect(section).toContain(`discoveryDigest: ${DISCOVERY_DIGEST}`);
    expect(section).toContain(`currentDigest: ${CURRENT_DIGEST}`);
    expect(section).toContain(`persistedDigest: ${PERSISTED_DRIFT_DIGEST}`);
    expect(section).toContain(`candidateId: ${CANDIDATE_ID}`);
  });

  it('carries runtime drift digests and candidate identity into the minted attempt snapshot', async () => {
    vi.mocked(buildReviewDiscoveryContext).mockResolvedValue(reviewContext());
    const state = makeState('PLAN', { discoveryDigest: DISCOVERY_DIGEST });

    const resolved = await resolveReviewAttemptDiscoveryContext({
      state,
      worktree: '/tmp/repository',
      repositoryGoverned: true,
      now: NOW,
      fingerprint: 'workspace-fingerprint',
    });

    expect(resolved.kind).toBe('repository');
    if (resolved.kind !== 'repository' || resolved.context.kind !== 'repository') return;
    expect(resolved.context.snapshot.drift.currentDigest).toBe(CURRENT_DIGEST);
    expect(resolved.context.snapshot.drift.persistedDigest).toBe(PERSISTED_DRIFT_DIGEST);
    expect(resolved.context.snapshot.verificationCandidates[0]?.candidateId).toBe(CANDIDATE_ID);
  });

  it('keeps persisted pre-fix snapshots readable when drift digest fields are absent', () => {
    const legacy = {
      ...snapshot(),
      drift: {
        status: 'clean' as const,
        drifted: false,
        changedContributorNames: [],
        notVerified: [],
      },
    };

    expect(() => RepositoryDiscoverySnapshot.parse(legacy)).not.toThrow();
  });
});
