/**
 * @module integration/review/discovery-envelope-contract
 * @description Contract: the attempt-bound repository Discovery envelope is
 *              delivered by the host reviewer Task prompt, is scoped to
 *              repository reviews only, and renders BEFORE the frozen material
 *              marker — including the repair prompt variant.
 */
import { describe, expect, it } from 'vitest';
import type { RepositoryDiscoverySnapshot } from '../../../state/evidence.js';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import type { FrozenReviewerContext } from '../../../state/review-continuation.js';
import { CANONICAL_PROMPT_APPEND_MARKER } from '../enforcement/types.js';
import { CORE_REVIEW_PROFILE_MARKER } from './prompt-sections.js';
import type { PendingReviewRetryDiagnostic } from '../types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function snapshot(): RepositoryDiscoverySnapshot {
  return {
    observedAt: NOW,
    discoveryDigest: 'd'.repeat(64),
    workspaceFingerprint: 'fp-test',
    health: {
      status: 'available',
      healthy: true,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: [],
    },
    drift: {
      status: 'clean',
      drifted: false,
      changedContributorNames: [],
      notVerified: [],
    },
    detectedStack: {
      summary: 'java=21',
      items: [{ kind: 'language', id: 'java', version: '21', evidence: 'pom.xml' }],
    },
    verificationCandidates: [
      {
        candidateId: 'vc-1',
        kind: 'build',
        command: 'npm run build --',
        source: 'package.json:scripts.build',
        confidence: 'high',
      },
    ],
    riskSurfaces: ['data-access'],
    warnings: [{ code: 'high_risk_surface_present', message: 'risk surface present' }],
    notVerified: ['advisory only'],
  };
}

function repositoryFrozenContext(): FrozenReviewerContext {
  return {
    reviewMaterial: {
      content: 'diff --git a/x b/x\n+x\n',
      materialDigest: 'm'.repeat(64),
      subjectDigest: 's'.repeat(64),
    },
    reviewSubject: {
      kind: 'repository_change',
      source: { kind: 'branch', branch: 'feature/x', requestedBase: 'main' },
      baseRepository: { kind: 'local', rootCommitDigest: 'r'.repeat(64) },
      headRepository: { kind: 'local', rootCommitDigest: 'r'.repeat(64) },
      baseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40),
      changedPaths: ['x'],
      materialDigest: 'm'.repeat(64),
      subjectDigest: 's'.repeat(64),
    },
    reviewSubjectScope: { kind: 'repository_change', paths: ['x'], revisions: ['base', 'head'] },
    anchorContract: {
      kind: 'repository_change',
      allowedSubjectAnchorKinds: ['repository_location'],
      allowedRevisionAliases: ['base', 'head'],
      contractText: 'repository anchors',
    },
  };
}

function hostPrompt(
  snapshotValue: RepositoryDiscoverySnapshot,
  retryDiagnostics?: readonly PendingReviewRetryDiagnostic[],
): string {
  return renderReviewerTaskPrompt({
    iteration: 1,
    planVersion: 1,
    obligationId: '00000000-0000-4000-8000-0000000000aa',
    mandateDigest: 'mandate',
    criteriaVersion: 'p40-v1',
    subjectLabel: 'the branch diff',
    repositoryReview: true,
    frozenReviewerContext: repositoryFrozenContext(),
    repositoryDiscoverySnapshot: snapshotValue,
    ...(retryDiagnostics ? { retryDiagnostics } : {}),
  });
}

describe('repository Discovery envelope (both transports)', () => {
  it('host prompt carries the scoped contract and snapshot before the material marker', () => {
    const prompt = hostPrompt(snapshot());
    expect(prompt).toContain('## Repository Discovery Context (advisory, host-observed)');
    expect(prompt).toContain('## Repository Discovery Contract');
    expect(prompt).toContain('MUST inspect its health and drift status');
    expect(prompt).toContain('### Health');
    expect(prompt).toContain('java=21');
    expect(prompt.indexOf('## Repository Discovery Context')).toBeGreaterThan(-1);
    expect(prompt.indexOf('## Repository Discovery Context')).toBeLessThan(
      prompt.indexOf(CANONICAL_PROMPT_APPEND_MARKER),
    );
    expect(prompt.indexOf(CANONICAL_PROMPT_APPEND_MARKER)).toBeLessThan(
      prompt.indexOf('diff --git'),
    );
  });

  it('renders the core profile marker in the trusted region before the append marker', () => {
    const prompt = hostPrompt(snapshot());
    expect(prompt).toContain(CORE_REVIEW_PROFILE_MARKER);
    expect(prompt.indexOf(CORE_REVIEW_PROFILE_MARKER)).toBeGreaterThan(-1);
    expect(prompt.indexOf(CORE_REVIEW_PROFILE_MARKER)).toBeLessThan(
      prompt.indexOf(CANONICAL_PROMPT_APPEND_MARKER),
    );
    expect(prompt.indexOf(CORE_REVIEW_PROFILE_MARKER)).toBeLessThan(prompt.indexOf('diff --git'));
  });

  it('host prompt carries the repository-scoped Discovery rules only for repository reviews', () => {
    const prompt = hostPrompt(snapshot());
    expect(prompt).toContain('Check supplied Discovery health/drift before repo-dependent claims');
  });

  it('repair prompt keeps the envelope before the material marker', () => {
    const prompt = hostPrompt(snapshot(), [{ code: 'HOST_STRUCTURED_OUTPUT_REQUIRED' }]);
    expect(prompt).toContain('## Prior Output Rejected — Contract Errors');
    expect(prompt).toContain('Return a fresh complete result.');
    expect(prompt).not.toContain('Return a fresh complete ReviewFindings object');
    expect(prompt).toContain('## Repository Discovery Contract');
    expect(prompt.indexOf('## Repository Discovery Context')).toBeLessThan(
      prompt.indexOf(CANONICAL_PROMPT_APPEND_MARKER),
    );
  });

  it('non-repository prompts carry NO Discovery contract and NO Discovery rule', () => {
    const prompt = renderReviewerTaskPrompt({
      iteration: 1,
      planVersion: 1,
      obligationId: '00000000-0000-4000-8000-0000000000aa',
      mandateDigest: 'mandate',
      criteriaVersion: 'p40-v1',
      subjectLabel: 'the artifact',
      frozenReviewerContext: {
        reviewMaterial: {
          content: 'text',
          materialDigest: 'm'.repeat(64),
          subjectDigest: 's'.repeat(64),
        },
        reviewSubject: {
          kind: 'content',
          source: { kind: 'inline', mediaType: 'text' },
          materialDigest: 'm'.repeat(64),
          subjectDigest: 's'.repeat(64),
          lineCount: 1,
        },
        reviewSubjectScope: { kind: 'content', subjectDigest: 's'.repeat(64), lineCount: 1 },
        anchorContract: {
          kind: 'content',
          requiredSubjectDigest: 's'.repeat(64),
          contractText: '',
        },
      },
      repositoryDiscoverySnapshot: null,
    });
    expect(prompt).not.toContain('Repository Discovery Context');
    expect(prompt).not.toContain('Repository Discovery Contract');
    expect(prompt).not.toContain('Check the supplied Discovery health');
  });
});
