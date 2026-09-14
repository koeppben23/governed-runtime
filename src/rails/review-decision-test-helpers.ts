/**
 * Shared review-assurance fixtures for the /review-decision rail tests.
 * Import target only — never executed as a test suite.
 */

import {
  REVIEW_ASSURANCE_SCHEMA_VERSION,
  type ReviewAssuranceState,
} from '../state/evidence-review.js';

export const ARCH_OBLIGATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ARCH_INVOCATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export interface AssuranceEntry {
  obligationId: string;
  obligationType?: 'architecture' | 'plan';
  subjectDigest: string;
  status: 'fulfilled' | 'consumed' | 'pending';
  iteration?: number;
  createdAt?: string;
  /** Plan version the obligation reviewed (default 1 — PLAN_RECORD's version). */
  planVersion?: number;
  /** `null` = obligation without linkage; `undefined` = no invocation entry. */
  invocationId?: string | null;
  findingsHash?: string;
  invokedAt?: string;
  consumedByObligationId?: string | null;
  capturedVerdict?: string;
  claimDeclarationsDigest?: string;
}

/** Linkage attempt identity for the Nth assurance entry. */
function attemptIdForIndex(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function invocationsFromEntries(entries: AssuranceEntry[]): ReviewAssuranceState['invocations'] {
  return entries
    .filter((e) => e.invocationId !== undefined)
    .map((e, index) => {
      const createdAt = e.createdAt ?? '2026-01-01T00:00:00.000Z';
      return {
        invocationId:
          e.invocationId === null
            ? `${e.obligationId}-inv-${(e.findingsHash ?? 'x').slice(0, 8)}`
            : (e.invocationId as string),
        attemptId: attemptIdForIndex(index),
        obligationId: e.obligationId,
        obligationType: e.obligationType ?? 'architecture',
        parentSessionId: `parent-${index}`,
        childSessionId: `child-${index}`,
        agentType: 'flowguard-reviewer',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: 'prompt-hash',
        mandateDigest: 'm'.repeat(64),
        criteriaVersion: 'criteria-v1',
        findingsHash: e.findingsHash ?? 'f'.repeat(64),
        invokedAt: e.invokedAt ?? createdAt,
        fulfilledAt: e.invokedAt ?? createdAt,
        consumedByObligationId: e.consumedByObligationId ?? null,
        ...(e.capturedVerdict ? { capturedVerdict: e.capturedVerdict } : {}),
        reviewOutputMode: 'structured_output',
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high',
      };
    });
}

function attemptsFromEntries(entries: AssuranceEntry[]): ReviewAssuranceState['attempts'] {
  return entries
    .filter((e) => e.invocationId !== undefined)
    .map((e, index) => ({
      attemptId: attemptIdForIndex(index),
      obligationId: e.obligationId,
      obligationType: e.obligationType ?? 'architecture',
      subjectDigest: e.subjectDigest,
      ordinal: index,
      childSessionId: `child-${index}`,
      status: 'bound' as const,
      origin: { kind: 'initial' } as const,
      repositoryDiscovery: { kind: 'not_applicable' } as const,
      createdAt: e.createdAt ?? '2026-01-01T00:00:00.000Z',
      completedAt: e.createdAt ?? '2026-01-01T00:00:00.000Z',
    }));
}

/** Arbitrary assurance chains for resolver tests (one obligation per entry). */
export function assuranceChain(entries: AssuranceEntry[]): ReviewAssuranceState {
  const obligations: ReviewAssuranceState['obligations'] = entries.map((e) => {
    const createdAt = e.createdAt ?? '2026-01-01T00:00:00.000Z';
    const subjectDigest = e.subjectDigest;
    const defaultInvocationId = `${e.obligationId}-inv`;
    return {
      obligationId: e.obligationId,
      obligationType: e.obligationType ?? 'architecture',
      iteration: e.iteration ?? 0,
      planVersion: e.planVersion ?? 1,
      criteriaVersion: 'criteria-v1',
      mandateDigest: 'm'.repeat(64),
      createdAt,
      pluginHandshakeAt: null,
      status: e.status,
      // Default linkage is derived per obligation so multi-entry chains stay
      // identity-unique (the assurance schema rejects duplicate invocation ids).
      invocationId: e.invocationId === undefined ? defaultInvocationId : e.invocationId,
      blockedCode: null,
      fulfilledAt: createdAt,
      consumedAt: e.status === 'consumed' ? createdAt : null,
      subjectDigest,
      reviewProfile: 'core' as const,
      profileSource: 'policy_default' as const,
      requiredChallengeCount: 0,
      requiredChallengeKind: 'design_challenge',
      challengePolicyVersion: 'challenge-policy.v1',
      ...(e.claimDeclarationsDigest ? { claimDeclarationsDigest: e.claimDeclarationsDigest } : {}),
      reviewMaterial: {
        content: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        materialDigest: 'material-digest-of-architecture-review',
        subjectDigest,
      },
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          kind: 'adr',
          digest: subjectDigest,
          sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
        },
      },
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      maxReviewerOutputRepairAttempts: 0,
    };
  });
  return {
    assuranceSchemaVersion: REVIEW_ASSURANCE_SCHEMA_VERSION,
    obligations,
    invocations: invocationsFromEntries(entries),
    attempts: attemptsFromEntries(entries),
    dispatches: [],
  };
}
