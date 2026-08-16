import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import {
  makeState,
  ARCHITECTURE_DECISION,
  IMPL_EVIDENCE,
  PLAN_RECORD,
  FIXED_TIME,
} from '../fixtures.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';
import { hashText } from '../shared/hashing.js';

const baseCtx = {
  now: () => FIXED_TIME,
  digest: (text: string) => `sha256:${text.length}`,
  policy: TEAM_POLICY,
};

const ARCH_OBLIGATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARCH_INVOCATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Bound architecture review evidence in the canonical assurance chain: one
 * fulfilled/consumed obligation plus its invocation with a findingsHash.
 * `obligationInvocationId: false` reproduces the direct host-task shape where
 * the obligation's invocationId is unset and the invocation links back via
 * obligationId only.
 */
function architectureAssurance(input: {
  subjectDigest: string;
  status: 'fulfilled' | 'consumed';
  iteration?: number;
  findingsHash?: string;
  capturedVerdict?: string;
  obligationInvocationId?: boolean;
}): ReviewAssuranceState {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const findingsHash = input.findingsHash ?? 'f'.repeat(64);
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
    obligations: [
      {
        obligationId: ARCH_OBLIGATION_ID,
        obligationType: 'architecture',
        iteration: input.iteration ?? 0,
        planVersion: 1,
        criteriaVersion: 'criteria-v1',
        mandateDigest: 'm'.repeat(64),
        createdAt,
        pluginHandshakeAt: null,
        status: input.status,
        invocationId: input.obligationInvocationId === false ? null : ARCH_INVOCATION_ID,
        blockedCode: null,
        fulfilledAt: createdAt,
        consumedAt: input.status === 'consumed' ? createdAt : null,
        subjectDigest: input.subjectDigest,
        reviewMaterial: {
          content: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          materialDigest: 'material-digest-of-architecture-review',
          subjectDigest: input.subjectDigest,
        },
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'adr',
            digest: input.subjectDigest,
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
          },
        },
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        maxReviewerOutputRepairAttempts: 0,
      },
    ],
    invocations: [
      {
        invocationId: ARCH_INVOCATION_ID,
        obligationId: ARCH_OBLIGATION_ID,
        obligationType: 'architecture',
        parentSessionId: 'parent-session-1',
        childSessionId: 'child-session-1',
        agentType: 'flowguard-reviewer',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: 'prompt-hash',
        mandateDigest: 'm'.repeat(64),
        criteriaVersion: 'criteria-v1',
        findingsHash,
        invokedAt: createdAt,
        fulfilledAt: createdAt,
        consumedByObligationId: input.status === 'consumed' ? ARCH_OBLIGATION_ID : null,
        ...(input.capturedVerdict ? { capturedVerdict: input.capturedVerdict } : {}),
        reviewOutputMode: 'structured_output',
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high',
      },
    ],
    attempts: [],
  };
}

function withPolicy(overrides: Partial<FlowGuardPolicy>): FlowGuardPolicy {
  return { ...TEAM_POLICY, ...overrides };
}

const PLAN_OBLIGATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_INVOCATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface PlanAssuranceInput {
  subjectDigest: string;
  status: 'fulfilled' | 'consumed' | 'pending';
  obligationType?: 'plan' | 'architecture';
  obligationId?: string;
  invocationId?: string;
  findingsHash?: string;
  iteration?: number;
  createdAt?: string;
}

/** Minimal single-obligation assurance for plan-certificate binding tests. */
function planAssurance(input: PlanAssuranceInput): ReviewAssuranceState {
  const createdAt = input.createdAt ?? '2026-01-01T00:00:00.000Z';
  const obligationId = input.obligationId ?? PLAN_OBLIGATION_ID;
  const findingsHash = input.findingsHash ?? 'a'.repeat(64);
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
    obligations: [
      {
        obligationId,
        obligationType: input.obligationType ?? 'plan',
        iteration: input.iteration ?? 0,
        planVersion: 1,
        criteriaVersion: 'criteria-v1',
        mandateDigest: 'm'.repeat(64),
        createdAt,
        pluginHandshakeAt: null,
        status: input.status,
        invocationId: input.invocationId === undefined ? PLAN_INVOCATION_ID : input.invocationId,
        blockedCode: null,
        fulfilledAt: createdAt,
        consumedAt: input.status === 'consumed' ? createdAt : null,
        subjectDigest: input.subjectDigest,
        reviewMaterial: {
          content: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          materialDigest: 'material-digest-of-plan-review',
          subjectDigest: input.subjectDigest,
        },
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'adr',
            digest: input.subjectDigest,
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
          },
        },
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        maxReviewerOutputRepairAttempts: 0,
      },
    ],
    invocations: [
      {
        invocationId: input.invocationId === undefined ? PLAN_INVOCATION_ID : input.invocationId,
        obligationId,
        obligationType: input.obligationType ?? 'plan',
        parentSessionId: 'parent-session-1',
        childSessionId: 'child-session-1',
        agentType: 'flowguard-reviewer',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: 'prompt-hash',
        mandateDigest: 'm'.repeat(64),
        criteriaVersion: 'criteria-v1',
        findingsHash,
        invokedAt: createdAt,
        fulfilledAt: createdAt,
        consumedByObligationId: input.status === 'consumed' ? obligationId : null,
        reviewOutputMode: 'structured_output',
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high',
      },
    ],
    attempts: [],
  };
}

function identityWithoutAssurance(): typeof reviewerIdentity {
  const identity = { ...reviewerIdentity };
  Reflect.deleteProperty(identity, 'actorAssurance');
  return identity;
}

const initiatorIdentity = {
  actorId: 'initiator-1',
  actorEmail: 'init@example.com',
  actorDisplayName: 'Initiator',
  actorSource: 'claim' as const,
  actorAssurance: 'claim_validated' as const,
};

const reviewerIdentity = {
  actorId: 'reviewer-1',
  actorEmail: 'review@example.com',
  actorDisplayName: 'Reviewer',
  actorSource: 'claim' as const,
  actorAssurance: 'claim_validated' as const,
};

/** Minimal converged self-review for tests requiring a completed review loop. */
const CONVERGED_SELF_REVIEW = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'review-digest',
  revisionDelta: 'none' as const,
  verdict: 'accept' as const,
  decidedAt: FIXED_TIME,
};

const PLAN_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000003',
  statement: 'The login flow rejects invalid credentials.',
  critical: true,
  authoritySectionId: 'authentication',
  expectedCheckId: 'test',
};

const ARCHITECTURE_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000004',
  statement: 'The selected architecture keeps service data durable.',
  critical: true,
  authoritySectionId: 'decision',
  requiredReviewEvidence: ['architecture-review'],
};

describe('review-decision rail', () => {
  it('creates an immutable certificate for the approved plan claims', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        claimDeclarations: { flow: 'plan', claims: [PLAN_CLAIM] },
      },
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'approved', decidedBy: 'reviewer-1' },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.plan?.approvalCertificate).toMatchObject({
        flow: 'plan',
        authorityDigest: PLAN_RECORD.current.digest,
        claimDeclarationsDigest: baseCtx.digest(
          '{"claims":[{"authoritySectionId":"authentication","claimId":"00000000-0000-4000-8000-000000000003","critical":true,"expectedCheckId":"test","statement":"The login flow rejects invalid credentials."}],"flow":"plan"}',
        ),
        decisionAttestationDigest: baseCtx.digest(
          '{"decidedAt":"2026-01-01T00:00:00.000Z","decidedBy":"reviewer-1","rationale":"approved","verdict":"approve"}',
        ),
        approvedAt: FIXED_TIME,
        approvedBy: 'reviewer-1',
        planVersion: expect.any(Number),
        planRecordDigest: expect.any(String),
        certificateId: expect.any(String),
      });
      expect(result.state.plan?.history).toEqual(PLAN_RECORD.history);
    }
  });

  it('creates an immutable certificate for approved architecture claims', () => {
    const architecture = {
      ...ARCHITECTURE_DECISION,
      reviewCompletion: 'reviewer_accepted' as const,
      claimDeclarations: { flow: 'architecture' as const, claims: [ARCHITECTURE_CLAIM] },
    };
    const result = executeReviewDecision(
      makeState('ARCH_REVIEW', {
        architecture,
        reviewAssurance: architectureAssurance({
          subjectDigest: architecture.digest,
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
      }),
      { verdict: 'approve', rationale: 'approved', decidedBy: 'reviewer-1' },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture?.approvalCertificate).toEqual({
        flow: 'architecture',
        authorityDigest: architecture.digest,
        claimDeclarationsDigest: baseCtx.digest(
          '{"claims":[{"authoritySectionId":"decision","claimId":"00000000-0000-4000-8000-000000000004","critical":true,"requiredReviewEvidence":["architecture-review"],"statement":"The selected architecture keeps service data durable."}],"flow":"architecture"}',
        ),
        decisionAttestationDigest: baseCtx.digest(
          '{"decidedAt":"2026-01-01T00:00:00.000Z","decidedBy":"reviewer-1","rationale":"approved","verdict":"approve"}',
        ),
        approvedAt: FIXED_TIME,
        approvedBy: 'reviewer-1',
        certificateId: expect.any(String),
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: ARCH_OBLIGATION_ID,
          reviewEvidenceDigest: 'f'.repeat(64),
          reviewedSubjectDigest: architecture.digest,
        },
      });
    }
  });

  it('reject at ARCH_REVIEW clears architecture and selfReview', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'accept',
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'reject',
        rationale: 'start over',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture).toBeNull();
      expect(result.state.selfReview).toBeNull();
    }
  });

  it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      implReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: IMPL_EVIDENCE.digest,
        revisionDelta: 'none',
        verdict: 'accept',
        executedAt: FIXED_TIME,
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'changes_requested',
        rationale: 'rework implementation',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.implementation).toBeNull();
      expect(result.state.implReview).toBeNull();
      expect(result.state.reviewDecision).toBeNull();
    }
  });

  it('approve at ARCH_REVIEW marks architecture as accepted', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
      reviewAssurance: architectureAssurance({
        subjectDigest: ARCHITECTURE_DECISION.digest,
        status: 'consumed',
      }),
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'accept',
      },
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'accepted',
        decidedBy: 'reviewer-1',
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture?.status).toBe('accepted');
    }
  });

  it('regulated approve requires structured identities', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: undefined,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
      },
      {
        ...baseCtx,
        policy: { ...TEAM_POLICY, allowSelfApproval: false },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toBe('');
    }
  });

  it('regulated approve blocks unknown reviewer actor source', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorSource: 'unknown',
        },
      },
      {
        ...baseCtx,
        policy: { ...TEAM_POLICY, allowSelfApproval: false },
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toBe('');
    }
  });

  it('requireVerifiedActorsForApproval blocks best_effort reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorAssurance: 'best_effort',
        },
      },
      {
        ...baseCtx,
        policy: withPolicy({ requireVerifiedActorsForApproval: true }),
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toBeDefined();
    }
  });

  it('minimum idp_verified blocks claim_validated reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: {
          ...reviewerIdentity,
          actorAssurance: 'claim_validated',
        },
      },
      {
        ...baseCtx,
        policy: withPolicy({ minimumActorAssuranceForApproval: 'idp_verified' }),
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toBeDefined();
    }
  });

  // ─── MUTATION KILL: blocked detail interpolation ───────────
  it('COMMAND_NOT_ALLOWED reason includes command and phase', () => {
    const state = makeState('TICKET');
    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'ok', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/review-decision');
      expect(result.reason).toContain('TICKET');
    }
  });

  it('REGULATED_ACTOR_UNKNOWN reason includes role for initiator', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: { ...initiatorIdentity, actorSource: 'unknown' as const },
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: reviewerIdentity,
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toContain('initiator');
    }
  });

  it('REGULATED_ACTOR_UNKNOWN reason includes role for reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorSource: 'unknown' as const },
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
      expect(result.reason).toContain('reviewer');
    }
  });

  it('FOUR_EYES_ACTOR_MATCH reason includes initiator ID', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'initiator-1',
        decisionIdentity: { ...reviewerIdentity, actorId: 'initiator-1' },
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
      expect(result.reason).toContain('initiator-1');
    }
  });

  it('regulated approve blocks uncomparable reviewer identity with DECISION_IDENTITY_REQUIRED', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorId: '   ' },
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    }
  });

  it('regulated approve blocks uncomparable initiator identity with DECISION_IDENTITY_REQUIRED', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: { ...initiatorIdentity, actorId: '   ' },
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: reviewerIdentity,
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    }
  });

  it('regulated approve blocks NFC/NFD equivalent actor IDs with FOUR_EYES_ACTOR_MATCH', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: { ...initiatorIdentity, actorId: 'café' },
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'cafe\u0301',
        decisionIdentity: { ...reviewerIdentity, actorId: 'cafe\u0301' },
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    }
  });

  it('regulated approve allows valid comparable different identities', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: reviewerIdentity,
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('ok');
  });

  it('ACTOR_ASSURANCE_INSUFFICIENT reason includes minimum and current levels', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
      },
      { ...baseCtx, policy: withPolicy({ requireVerifiedActorsForApproval: true }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toContain('claim_validated');
      expect(result.reason).toContain('best_effort');
    }
  });

  it('ACTOR_ASSURANCE_INSUFFICIENT via minimumActorAssurance includes levels', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
      },
      { ...baseCtx, policy: withPolicy({ minimumActorAssuranceForApproval: 'idp_verified' }) },
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      expect(result.reason).toContain('idp_verified');
      expect(result.reason).toContain('best_effort');
    }
  });

  it('changes_requested at ARCH_REVIEW clears selfReview (not architecture)', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: ARCHITECTURE_DECISION,
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'accept',
      },
    });
    const result = executeReviewDecision(
      state,
      { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.selfReview).toBeNull();
    }
  });

  it('changes_requested at EVIDENCE_REVIEW clears reducedCeremony alongside impl', () => {
    const reducedCeremonyDecision = {
      profile: 'reduced' as const,
      reason: 'Trivial config change',
      claimedTaskClass: 'TRIVIAL' as const,
      computedMinimumTaskClass: 'TRIVIAL' as const,
      touchedSurfaces: ['config/app.json'],
      decidedAt: FIXED_TIME,
    };
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
      implReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: IMPL_EVIDENCE.digest,
        revisionDelta: 'none',
        verdict: 'accept',
        executedAt: FIXED_TIME,
      },
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'changes_requested', rationale: 'rework implementation', decidedBy: 'reviewer-1' },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.implementation).toBeNull();
      expect(result.state.implReview).toBeNull();
      expect(result.state.reducedCeremony).toBeNull();
      expect(result.state.reviewDecision).toBeNull();
    }
  });

  it('approve does NOT clear reducedCeremony', () => {
    const reducedCeremonyDecision = {
      profile: 'reduced' as const,
      reason: 'Trivial fix',
      claimedTaskClass: 'TRIVIAL' as const,
      computedMinimumTaskClass: 'TRIVIAL' as const,
      touchedSurfaces: ['src/index.ts'],
      decidedAt: FIXED_TIME,
    };
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
      implReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: IMPL_EVIDENCE.digest,
        revisionDelta: 'none',
        verdict: 'accept',
        executedAt: FIXED_TIME,
      },
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'looks good', decidedBy: 'reviewer-1' },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.reducedCeremony).not.toBeNull();
      expect(result.state.reducedCeremony?.profile).toBe('reduced');
    }
  });

  it('reject clears reducedCeremony alongside all downstream', () => {
    const reducedCeremonyDecision = {
      profile: 'reduced' as const,
      reason: 'Trivial fix',
      claimedTaskClass: 'TRIVIAL' as const,
      computedMinimumTaskClass: 'TRIVIAL' as const,
      touchedSurfaces: ['src/index.ts'],
      decidedAt: FIXED_TIME,
    };
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
      plan: PLAN_RECORD,
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'reject', rationale: 'start over', decidedBy: 'reviewer-1' },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.reducedCeremony).toBeNull();
      expect(result.state.implementation).toBeNull();
      expect(result.state.reviewDecision).toBeNull();
    }
  });

  it('INVALID_VERDICT includes the invalid verdict string', () => {
    const state = makeState('PLAN_REVIEW');
    const result = executeReviewDecision(
      state,
      { verdict: 'maybe' as never, rationale: 'idk', decidedBy: 'r1' },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('INVALID_VERDICT');
      expect(result.reason).toContain('maybe');
    }
  });

  // ─── MUTATION KILL round 2 ───────────────────────────────────
  it('idp_verified passes requireVerifiedActorsForApproval (assurance threshold)', () => {
    // Kill: actorAssurance !== 'idp_verified' → true (blocks idp_verified)
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decidedBy: 'reviewer-1',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
      },
      { ...baseCtx, policy: withPolicy({ requireVerifiedActorsForApproval: true }) },
    );
    // idp_verified meets the threshold — should NOT be blocked
    expect(result.kind).toBe('ok');
  });

  // ─── MUTATION KILL ────────────────────────────────────────────────────

  describe('MUTATION_KILL', () => {
    it('approve at ARCH_REVIEW sets architecture.status to "accepted"', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.status).toBe('accepted');
      }
    });

    it('blocks approval at ARCH_REVIEW without completed architecture review evidence', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: null,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
      });
    });

    it('blocks approval at ARCH_REVIEW while review completion is pending', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
      });
      expect(state.architecture?.status).toBe('proposed');
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it.each(['reviewer_accepted', 'review_exhausted'] as const)(
      'allows approval with %s architecture review completion and binds the exact evidence',
      (reviewCompletion) => {
        const state = makeState('ARCH_REVIEW', {
          architecture: { ...ARCHITECTURE_DECISION, reviewCompletion },
          // Deliberately SAME digest as the current ADR for both paths: the
          // exhausted case must still yield review_exhausted_override — the
          // binding kind comes from the gate path, never from digest equality.
          reviewAssurance: architectureAssurance({
            subjectDigest: ARCHITECTURE_DECISION.digest,
            status: 'consumed',
          }),
          selfReview: CONVERGED_SELF_REVIEW,
        });
        const result = executeReviewDecision(
          state,
          { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
          baseCtx,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.state.phase).toBe('ARCH_COMPLETE');
          expect(result.state.architecture?.status).toBe('accepted');
          expect(result.state.architecture?.approvalCertificate?.reviewBinding).toEqual(
            reviewCompletion === 'reviewer_accepted'
              ? {
                  kind: 'current_review',
                  reviewObligationId: ARCH_OBLIGATION_ID,
                  reviewEvidenceDigest: 'f'.repeat(64),
                  reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
                }
              : {
                  kind: 'review_exhausted_override',
                  lastReviewObligationId: ARCH_OBLIGATION_ID,
                  lastReviewEvidenceDigest: 'f'.repeat(64),
                  reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
                  approvedSubjectDigest: ARCHITECTURE_DECISION.digest,
                },
          );
        }
      },
    );

    it('resolves evidence when the obligation invocationId is unset (direct host-task shape)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          obligationInvocationId: false,
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.approvalCertificate?.reviewBinding).toEqual({
          kind: 'current_review',
          reviewObligationId: ARCH_OBLIGATION_ID,
          reviewEvidenceDigest: 'f'.repeat(64),
          reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
        });
      }
    });

    it('blocks approval at ARCH_REVIEW without bindable architecture review evidence', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
      });
      expect(state.architecture?.approvalCertificate).toBeUndefined();
    });

    it('blocks reviewer_accepted approval when evidence reviewed a different digest (no cross-digest fallback)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: 'digest-of-prior-adr-revision',
          status: 'consumed',
          capturedVerdict: 'accept',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'LGTM', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
      });
    });

    it('review_exhausted_override records the digest difference explicitly', () => {
      const revisedDigest = 'digest-of-revised-adr';
      const state = makeState('ARCH_REVIEW', {
        architecture: {
          ...ARCHITECTURE_DECISION,
          digest: revisedDigest,
          reviewCompletion: 'review_exhausted',
        },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
          capturedVerdict: 'changes_requested',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'override', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.approvalCertificate?.reviewBinding).toEqual({
          kind: 'review_exhausted_override',
          lastReviewObligationId: ARCH_OBLIGATION_ID,
          lastReviewEvidenceDigest: 'f'.repeat(64),
          reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
          approvedSubjectDigest: revisedDigest,
        });
      }
    });

    it('relabeling the reviewBinding kind changes the certificate identity', () => {
      const accepted = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const exhausted = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        reviewAssurance: architectureAssurance({
          subjectDigest: ARCHITECTURE_DECISION.digest,
          status: 'consumed',
        }),
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const ctx = { ...baseCtx, digest: hashText };
      const acceptedResult = executeReviewDecision(
        accepted,
        { verdict: 'approve', rationale: 'approved', decidedBy: 'reviewer-1' },
        ctx,
      );
      const exhaustedResult = executeReviewDecision(
        exhausted,
        { verdict: 'approve', rationale: 'approved', decidedBy: 'reviewer-1' },
        ctx,
      );
      expect(acceptedResult.kind).toBe('ok');
      expect(exhaustedResult.kind).toBe('ok');
      if (acceptedResult.kind === 'ok' && exhaustedResult.kind === 'ok') {
        const acceptedId = acceptedResult.state.architecture?.approvalCertificate?.certificateId;
        const exhaustedId = exhaustedResult.state.architecture?.approvalCertificate?.certificateId;
        expect(acceptedId).toBeDefined();
        expect(exhaustedId).toBeDefined();
        expect(acceptedId).not.toBe(exhaustedId);
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview', () => {
      const approvedArchitecture = {
        ...ARCHITECTURE_DECISION,
        approvalCertificate: {
          flow: 'architecture' as const,
          authorityDigest: ARCHITECTURE_DECISION.digest,
          claimDeclarationsDigest: 'claims-digest',
          decisionAttestationDigest: 'decision-digest',
          approvedAt: FIXED_TIME,
          approvedBy: 'reviewer',
          certificateId: '00000000-0000-4000-8000-000000000001',
          reviewBinding: {
            kind: 'current_review' as const,
            reviewObligationId: '00000000-0000-4000-8000-000000000002',
            reviewEvidenceDigest: 'review-evidence-digest',
            reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
          },
        },
      };
      const state = makeState('ARCH_REVIEW', {
        architecture: approvedArchitecture,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'Needs work', decidedBy: 'reviewer' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        // architecture should still be present
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.architecture?.approvalCertificate).toBeUndefined();
        expect(result.state.architecture?.reviewCompletion).toBe('pending');
      }
    });

    it('changes_requested does NOT trigger four-eyes check (verdict gate)', () => {
      // Use regulated policy with allowSelfApproval=false
      // changes_requested by same person as initiator should NOT be blocked
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        initiatedBy: 'same-person',
        initiatedByIdentity: { ...initiatorIdentity, actorId: 'same-person' },
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'changes_requested',
          rationale: 'Needs changes',
          decidedBy: 'same-person',
          decisionIdentity: { ...reviewerIdentity, actorId: 'same-person' },
        },
        { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
      );
      // Should NOT be blocked (four-eyes only applies to approve)
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=claim_validated blocks best_effort actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'claim_validated',
            // NOT using legacy requireVerifiedActorsForApproval
          }),
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      }
    });

    it('P34: minimumActorAssuranceForApproval=idp_verified blocks claim_validated actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'idp_verified',
          }),
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      }
    });

    it('P34: minimumActorAssuranceForApproval=claim_validated allows claim_validated actor (>= threshold)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'claim_validated' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'claim_validated',
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval=idp_verified allows idp_verified actor', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            minimumActorAssuranceForApproval: 'idp_verified',
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('P34: minimumActorAssuranceForApproval absent → no assurance check (else-if gate)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        plan: PLAN_RECORD,
        initiatedBy: 'initiator',
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: { ...reviewerIdentity, actorAssurance: 'best_effort' as const },
        },
        {
          ...baseCtx,
          policy: withPolicy({
            // Neither requireVerifiedActorsForApproval nor minimumActorAssuranceForApproval set
          }),
        },
      );
      expect(result.kind).toBe('ok');
    });

    it('approve at PLAN_REVIEW does NOT modify architecture (phase guard)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // architecture should remain null — not set to {status:'accepted'}
        expect(result.state.architecture).toBeNull();
      }
    });

    // ── Kill mutants in applyStateClearingPattern ────────────────────

    it('changes_requested at PLAN_REVIEW clears selfReview (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
      }
    });

    it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview (survivor kill)', () => {
      const state = makeState('EVIDENCE_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: IMPL_EVIDENCE.digest,
          currDigest: IMPL_EVIDENCE.digest,
          revisionDelta: 'none',
          verdict: 'accept',
          executedAt: FIXED_TIME,
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.implementation).toBeNull();
        expect(result.state.implReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
      }
    });

    it('changes_requested at ARCH_REVIEW clears selfReview (survivor kill)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'changes_requested', rationale: 'rework', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview).toBeNull();
        expect(result.state.architecture?.reviewCompletion).toBe('pending');
      }
    });

    it('reject at PLAN_REVIEW clears all downstream evidence (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: { text: 't', digest: 'd', source: 'user', createdAt: FIXED_TIME },
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).toBeNull();
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
      }
    });

    it('reject at ARCH_REVIEW clears architecture and selfReview (survivor kill)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'reject', rationale: 'rejected', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it('actorAssurance fallback to best_effort when undefined (survivor kill)', () => {
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: identityWithoutAssurance(),
        },
        {
          ...baseCtx,
          policy: withPolicy({ requireVerifiedActorsForApproval: true }),
        },
      );
      // Should still work since undefined falls back to 'best_effort' which fails requirement
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
        // Pin the explicit string fallback so a literal mutation cannot survive:
        // the rendered message must contain "best_effort" as the current assurance.
        expect(result.reason).toContain('best_effort');
        expect(result.reason).toContain('claim_validated');
      }
    });

    it('actorAssurance fallback to best_effort under explicit minimumAssurance (P34 path)', () => {
      // Triggers the second fallback site at line 221.
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
          decisionIdentity: identityWithoutAssurance(),
        },
        {
          ...baseCtx,
          policy: withPolicy({ minimumActorAssuranceForApproval: 'claim_validated' }),
        },
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
        expect(result.reason).toContain('best_effort');
        expect(result.reason).toContain('claim_validated');
      }
    });

    it('approve at non-ARCH_REVIEW phase does NOT mutate architecture status', () => {
      // Kills L122 mutant `if (true && state.architecture)`:
      // approve at PLAN_REVIEW with architecture present must leave it untouched.
      const state = makeState('PLAN_REVIEW', {
        initiatedByIdentity: initiatorIdentity,
        architecture: ARCHITECTURE_DECISION,
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        {
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer-1',
        },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // Architecture must be preserved as-is, NOT promoted to 'accepted'
        // (which would happen only at ARCH_REVIEW).
        expect(result.state.architecture).toBe(state.architecture);
        expect(result.state.architecture?.status).toBe(ARCHITECTURE_DECISION.status);
      }
    });

    it('binds the plan certificate to the exact-subject plan obligation evidence', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'fulfilled',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewObligationId).toBe(PLAN_OBLIGATION_ID);
        expect(result.state.plan?.approvalCertificate?.reviewEvidenceDigest).toBe('a'.repeat(64));
      }
    });

    it('prefers the exact-subject plan obligation over a newer wrong-subject obligation', () => {
      const newerWrong = planAssurance({
        subjectDigest: 'wrong-subject-digest',
        status: 'consumed',
        iteration: 1,
        createdAt: '2026-01-02T00:00:00.000Z',
        obligationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        invocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeff',
        findingsHash: 'b'.repeat(64),
      });
      const olderMatch = planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        iteration: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        findingsHash: 'c'.repeat(64),
      });
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: {
          ...newerWrong,
          obligations: [...newerWrong.obligations, ...olderMatch.obligations],
          invocations: [...newerWrong.invocations, ...olderMatch.invocations],
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewObligationId).toBe(PLAN_OBLIGATION_ID);
        expect(result.state.plan?.approvalCertificate?.reviewEvidenceDigest).toBe('c'.repeat(64));
      }
    });

    it('excludes non-plan obligations from the plan certificate binding', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'consumed',
          obligationType: 'architecture',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewObligationId).toBeNull();
      }
    });

    it('excludes pending obligations from the plan certificate binding', () => {
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: planAssurance({
          subjectDigest: PLAN_RECORD.current.digest,
          status: 'pending',
        }),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewObligationId).toBeNull();
      }
    });

    it('drops the evidence digest when the linked plan invocation is absent', () => {
      const unrelated = planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'fulfilled',
        obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        findingsHash: 'd'.repeat(64),
      });
      const state = makeState('PLAN_REVIEW', {
        plan: PLAN_RECORD,
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: {
          ...unrelated,
          obligations: [
            ...unrelated.obligations,
            {
              ...unrelated.obligations[0]!,
              obligationId: PLAN_OBLIGATION_ID,
              invocationId: 'missing-invocation-id',
            },
          ],
          invocations: [
            {
              ...unrelated.invocations[0]!,
              obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            },
          ],
        },
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.approvalCertificate?.reviewObligationId).toBe(PLAN_OBLIGATION_ID);
        expect(result.state.plan?.approvalCertificate?.reviewEvidenceDigest).toBeNull();
      }
    });
  });
});
