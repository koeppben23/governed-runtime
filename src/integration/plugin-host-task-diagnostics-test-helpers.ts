/**
 * @module integration/plugin-host-task-diagnostics-test-helpers
 * @description Shared test factories and constants for plugin-host-task-diagnostics test suites.
 */

import { createSessionState, onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import * as fs from 'node:fs/promises';
import { isTerminalPhase } from '../machine/topology.js';
import { writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { makePlanRevision } from '../state/evidence-test-constants.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { canonicalBinding } from './test-helpers.js';
import { reviewDispatchRequired } from './review/enforcement/dispatch-signal.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/obligations/assurance.js';
import { mintObservationCapability } from './review/obligations/attempt-lifecycle.js';
import type {
  RepositoryDiscoverySnapshot,
  ReviewAttempt,
  ReviewObligation,
} from '../state/evidence.js';
import type { SessionState } from '../state/schema.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOW = '2026-05-10T12:00:00.000Z';
export const SESSION_ID = 'ses_parent_001';
export const CHILD_SESSION_ID = 'ses_child_001';
const MODE_A_OBLIGATION_ID = '44444444-4444-4444-8444-444444444444';

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Build a Mode A response carrying the structured review-dispatch signal with
 * iteration and planVersion. `obligationId` defaults to a realistic fixture
 * obligation identity so the pending review satisfies the host
 * attestation-constants invariant; pass `null` to deliberately model a signal
 * without obligation/host attestation.
 */
export function modeAResponse(
  iteration = 0,
  planVersion = 1,
  obligationId: string | null = MODE_A_OBLIGATION_ID,
): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    reviewDispatch: reviewDispatchRequired(),
    ...(obligationId
      ? {
          reviewAttemptId: `att-${obligationId}`,
          reviewObligation: {
            obligationId,
            obligationType: 'plan',
            iteration,
            planVersion,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge',
          },
          requiredReviewAttestation: {
            reviewedBy: REVIEWER_SUBAGENT_TYPE,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            toolObligationId: obligationId,
            iteration,
            planVersion,
          },
        }
      : {}),
  });
}

/** Build a substantive prompt for the subagent. */
export function validPrompt(iteration = 0, planVersion = 1): string {
  return (
    `Review this plan critically. The plan proposes implementing a new feature ` +
    `for user authentication with OAuth2 integration. ` +
    `Ticket: PROJ-123 - Add OAuth2 login flow. ` +
    `iteration=${iteration}, planVersion=${planVersion}. ` +
    `Check for completeness, correctness, feasibility, risk, and quality. ` +
    `Return structured ReviewFindings JSON with your assessment.`
  );
}

/** Build task result JSON with strict reviewer-owned findings input. */
export function taskResultWithAttestation(
  obligationId: string,
  opts: {
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
    verdict?: string;
  } = {},
): string {
  const {
    childSessionId: _childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
    verdict = 'accept',
  } = opts;
  return JSON.stringify({
    iteration,
    planVersion,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: {
      toolObligationId: obligationId,
    },
  });
}

/** Create a pending obligation with matching iteration/planVersion/mandate/criteria. */
export function pendingObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  const base = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'diagnostics-test-subject',
    reviewMaterial: freezeReviewMaterial('# Diagnostics\nBody', 'diagnostics-test-subject'),
    reviewSubjectScope: artifactReviewSubjectScope(
      'plan',
      '# Diagnostics\nBody',
      'diagnostics-test-subject',
    ),
    changedFiles: ['docs/test.md'],
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    repositoryAuthority: {
      kind: 'context',
      context: {
        kind: 'commit',
        repositoryIdentity: { host: 'github.com', owner: 'diag', name: 'repo' },
        objectSha: 'a'.repeat(40),
      },
    },
    repositoryEvidenceFreeze: { kind: 'available' },
  });
  return { ...base, ...overrides };
}

/**
 * Build the invocation attempt that production records BEFORE the reviewer
 * subagent runs, already bound to its child session.
 *
 * Binding resolves a callback against this envelope, so a test that exercises a
 * successful bind must provide it exactly as `createObligationAndAttempt` plus
 * the Task-start child-session binding would have produced it.
 */
function attemptFor(
  obligation: ReviewObligation,
  childSessionId: string = CHILD_SESSION_ID,
  overrides: Partial<ReviewAttempt> = {},
): ReviewAttempt {
  return {
    attemptId: `att-${obligation.obligationId}`,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest ?? 'diagnostics-test-subject',
    ordinal: 0,
    childSessionId,
    status: 'created',
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observations: [],
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * Set up a structured-review requirement and its corresponding attempt fixture.
 */
export function setupFullCycle(
  opts: {
    obligationId?: string;
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
  } = {},
) {
  const {
    obligationId: customObligationId,
    childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
  } = opts;

  const state = createSessionState();
  // Step 1: Mode A — FlowGuard tool carries the review-dispatch signal
  onFlowGuardToolAfter(state, TOOL_FLOWGUARD_PLAN, {}, modeAResponse(iteration, planVersion), {
    now: NOW,
    isTerminalPhase,
  });

  const obligation = pendingObligation({
    ...(customObligationId ? { obligationId: customObligationId } : {}),
    iteration,
    planVersion,
  });

  return { state, obligation, attempts: [attemptFor(obligation, childSessionId)] };
}

/** Minimal valid repository Discovery snapshot for a repository-governed attempt. */
function repositoryDiscoverySnapshot(): RepositoryDiscoverySnapshot {
  return {
    observedAt: NOW,
    discoveryDigest: null,
    workspaceFingerprint: null,
    health: {
      status: 'available',
      healthy: true,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: [],
    },
    drift: { status: 'clean', drifted: false, changedContributorNames: [], notVerified: [] },
    detectedStack: null,
    verificationCandidates: [],
    riskSurfaces: [],
    warnings: [],
    notVerified: [],
  };
}

/**
 * Rewrite a seeded plan session so its obligation carries a head-only frozen
 * repository context and its first attempt is repository-governed. This lets a
 * structured citation reach canonical evidence binding instead of failing at
 * the frozen-revision scope gate.
 */
export function withRepositoryHeadAuthority(state: SessionState): SessionState {
  const headSha = 'c'.repeat(40);
  const obligation = state.reviewAssurance!.obligations[0]!;
  const attempt = state.reviewAssurance!.attempts[0]!;
  return {
    ...state,
    reviewAssurance: {
      ...state.reviewAssurance!,
      obligations: [
        {
          ...obligation,
          repositoryAuthority: {
            kind: 'context',
            context: {
              kind: 'commit',
              repositoryIdentity: { host: 'github.com', owner: 'acme', name: 'repo' },
              objectSha: headSha,
            },
          },
          repositoryRevisionProvenance: { kind: 'available', headSha },
          repositoryEvidenceFreeze: { kind: 'available' },
        },
      ],
      attempts: [
        {
          ...attempt,
          repositoryDiscovery: { kind: 'repository', snapshot: repositoryDiscoverySnapshot() },
          observationCapability: mintObservationCapability(),
        },
      ],
    },
  };
}

/**
 * Structured findings whose artifact-anchored relation cites one unobserved
 * head repository path. The path is attacker-influenced data, never a prompt
 * instruction.
 */
export function unobservedEvidenceFindings(
  obligationId: string,
  path: string,
): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [
      {
        severity: 'major',
        category: 'correctness',
        message: 'cited but not observed',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section',
              artifactKind: 'plan',
              artifactDigest: 'test-subject-digest',
              sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Plan' }],
            },
          ],
          evidenceLocations: [{ path, revision: 'head' }],
        },
      },
    ],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: obligationId },
  };
}

// ─── Session Seeding ─────────────────────────────────────────────────────────

/**
 * Seed a strict PLAN-phase session with one pending plan review obligation and
 * its first attempt, plus frozen review material for the native reviewer Task.
 * Shared by the plugin native-review transport suites.
 */
export async function seedStrictPlanSession(worktree: string, sessionID: string) {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const obligationId = '11111111-1111-4111-8111-111111111111';
  const reviewMaterial = freezeReviewMaterial('## Plan\n1. Fix auth', 'test-subject-digest');
  const planCurrent = makePlanRevision({ body: '## Plan\n1. Fix auth', createdAt: now });

  await fs.mkdir(sessDir, { recursive: true });
  await writeState(
    sessDir,
    makeState('PLAN', {
      binding: await canonicalBinding(worktree, sessionID),
      ticket: {
        text: 'Fix auth issue',
        digest: 'ticket-digest',
        source: 'user',
        createdAt: now,
        riskDeclaration: { kind: 'absent' },
      },
      plan: {
        current: planCurrent,
        history: [],
        reviewCompletion: 'pending',
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: planCurrent.digest,
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      policySnapshot: {
        ...makeState('PLAN').policySnapshot,
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v7' as const,
        obligations: [
          {
            obligationId,
            obligationType: 'plan',
            reviewCycle: 1,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge',
            challengePolicyVersion: 'challenge-policy.v1',
            repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
            subjectDigest: 'test-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerAttempts: 1,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            reviewSubjectScope: {
              kind: 'artifact',
              artifact: {
                kind: 'plan',
                digest: 'test-subject-digest',
                sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Plan' }]],
              },
            },
            reviewMaterial,
          },
        ],
        invocations: [],
        attempts: [
          {
            attemptId: '11111111-2222-4111-8111-111111111111',
            obligationId,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            ordinal: 0,
            status: 'created' as const,
            origin: { kind: 'initial' } as const,
            repositoryDiscovery: { kind: 'not_applicable' } as const,
            observations: [],
            createdAt: now,
          },
        ],
        dispatches: [],
      },
    }),
  );

  return { sessDir, obligationId };
}
