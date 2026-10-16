/**
 * @module integration/review/discovery-provenance-projection
 * @description Regression coverage for reviewer-visible Discovery provenance.
 */
import type { DiscoveryDriftStatusProjection } from '../../discovery/discovery-drift-status.js';
import { REVIEW_DISCOVERY_PROVIDER } from '../../discovery/review-discovery-provider.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeState } from '../../../fixtures.js';
import { RepositoryDiscoverySnapshot } from '../../../state/evidence-review-attempt-discovery.js';
import { buildReviewDiscoveryContext } from './discovery-context-loader.js';
import { buildRepositoryDiscoverySnapshotSection } from '../prompting/discovery-context-prompt.js';
import type { DiscoveryReviewContext } from './discovery-port.js';
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
    } as DiscoveryDriftStatusProjection,
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
        assertionCapability: 'unsupported',
        kind: 'test',
        command: 'npm run test --',
        source: 'package.json:scripts.test',
        confidence: 'high',
        reason: 'repo-native test script',
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

  it('renders correlation identities in the attempt-bound snapshot', () => {
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
      discoveryProvider: REVIEW_DISCOVERY_PROVIDER,
    });

    expect(resolved.kind).toBe('repository');
    if (resolved.kind !== 'repository' || resolved.context.kind !== 'repository') return;
    expect(resolved.context.snapshot.drift.currentDigest).toBe(CURRENT_DIGEST);
    expect(resolved.context.snapshot.drift.persistedDigest).toBe(PERSISTED_DRIFT_DIGEST);
    expect(resolved.context.snapshot.verificationCandidates[0]?.candidateId).toBe(CANDIDATE_ID);
  });

  it('rejects non-canonical persisted snapshots at the schema boundary', () => {
    const canonical = snapshot();
    const {
      currentDigest: _current,
      persistedDigest: _persisted,
      ...driftWithoutDigests
    } = canonical.drift;
    const { changedContributorNames: _contributors, ...driftWithoutContributors } = canonical.drift;
    const { candidateId: _candidateId, ...candidateWithoutId } =
      canonical.verificationCandidates[0]!;

    const rejected: Record<string, unknown> = {
      'drift digests absent': { ...canonical, drift: driftWithoutDigests },
      'legacy changedCollectorNames': {
        ...canonical,
        drift: { ...driftWithoutContributors, changedCollectorNames: ['code-surface-analysis'] },
      },
      'changedContributorNames absent': { ...canonical, drift: driftWithoutContributors },
      'candidate without candidateId': {
        ...canonical,
        verificationCandidates: [candidateWithoutId],
      },
    };
    for (const [label, input] of Object.entries(rejected)) {
      expect(RepositoryDiscoverySnapshot.safeParse(input).success, label).toBe(false);
    }
    expect(RepositoryDiscoverySnapshot.safeParse(canonical).success).toBe(true);
  });
});

describe('Discovery reviewer verification candidates', () => {
  const KINDS = ['build', 'test', 'lint', 'typecheck', 'format', 'security', 'coverage'] as const;

  function candidate(kind: string, index: number) {
    return {
      candidateId: `vc_${String(index).repeat(64)}`,
      assertionCapability: 'unsupported' as const,
      kind,
      command: `npm run ${kind} --`,
      source: `package.json:scripts.${kind}`,
      confidence: 'high' as const,
      reason: 'repo-native script',
    };
  }

  it('renders every candidate with kind, command and candidateId, without truncation', () => {
    // Seven canonical kinds plus an alternate `test` profile (vitest/pytest).
    const candidates = [
      ...KINDS.map((kind, index) => candidate(kind, index)),
      { ...candidate('test', 8), source: 'vitest-junit-aggregate' },
    ];
    const section = buildRepositoryDiscoverySnapshotSection(
      RepositoryDiscoverySnapshot.parse({ ...snapshot(), verificationCandidates: candidates }),
    );

    for (const entry of candidates) {
      expect(section).toContain(
        `- ${entry.kind}: ${entry.command} (source: ${entry.source}; confidence: high; candidateId: ${entry.candidateId}; assertionCapability: unsupported)`,
      );
    }
    expect(section.split('\n').filter((line) => line.includes('candidateId: vc_'))).toHaveLength(8);
    expect(section).not.toContain('omitted');
  });

  it('renders the assertion capability and report spec for a structured candidate', () => {
    const structured = {
      candidateId: `vc_${'s'.repeat(64)}`,
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: 'npm run test --',
      source: 'package.json:scripts.test',
      confidence: 'high' as const,
      reason: 'structured surefire reports',
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as const,
        providerId: 'junit',
        standardPatterns: ['target/surefire-reports/TEST-*.xml'],
      },
    };
    const section = buildRepositoryDiscoverySnapshotSection(
      RepositoryDiscoverySnapshot.parse({ ...snapshot(), verificationCandidates: [structured] }),
    );
    expect(section).toContain('assertionCapability: structured');
    expect(section).toContain('assertionReport: snapshot_diff/file/junit_xml via junit');
  });

  it('keeps the explicit NOT_VERIFIED marker when no candidate is available', () => {
    const section = buildRepositoryDiscoverySnapshotSection(
      RepositoryDiscoverySnapshot.parse({ ...snapshot(), verificationCandidates: [] }),
    );
    expect(section).toContain(
      '- NOT_VERIFIED: No repo-native verification candidates are available; do not invent them.',
    );
  });
});
