import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import {
  makeState,
  ARCHITECTURE_DECISION,
  IMPL_EVIDENCE,
  PLAN_RECORD,
  FIXED_TIME,
  APPROVED_IMPL_REVIEW,
  REDUCED_CEREMONY_DECISION,
} from '../fixtures.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';
import { DecisionIdentity } from '../state/evidence-identity.js';
import {
  assuranceChain,
  ARCH_INVOCATION_ID,
  ARCH_OBLIGATION_ID,
} from './review-decision-test-helpers.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { emptyClaimDeclarations } from '../state/proofgraph-approval.js';

const baseCtx = {
  now: () => FIXED_TIME,
  digest: (text: string) => `sha256:${text.length}`,
  policy: TEAM_POLICY,
};

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
  claimDeclarationsDigest?: string;
  obligationInvocationId?: boolean;
}): ReviewAssuranceState {
  return assuranceChain([
    {
      obligationId: ARCH_OBLIGATION_ID,
      subjectDigest: input.subjectDigest,
      status: input.status,
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.findingsHash !== undefined ? { findingsHash: input.findingsHash } : {}),
      ...(input.capturedVerdict !== undefined ? { capturedVerdict: input.capturedVerdict } : {}),
      ...(input.claimDeclarationsDigest !== undefined
        ? { claimDeclarationsDigest: input.claimDeclarationsDigest }
        : {}),
      invocationId: input.obligationInvocationId === false ? null : ARCH_INVOCATION_ID,
      consumedByObligationId: input.status === 'consumed' ? ARCH_OBLIGATION_ID : null,
    },
  ]);
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
  capturedVerdict?: string;
  claimDeclarationsDigest?: string;
}

/** Minimal single-obligation assurance for plan-certificate binding tests. */
function planAssurance(input: PlanAssuranceInput): ReviewAssuranceState {
  const obligationId = input.obligationId ?? PLAN_OBLIGATION_ID;
  return assuranceChain([
    {
      obligationId,
      obligationType: input.obligationType ?? 'plan',
      subjectDigest: input.subjectDigest,
      status: input.status,
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      invocationId: input.invocationId ?? PLAN_INVOCATION_ID,
      findingsHash: input.findingsHash ?? 'a'.repeat(64),
      ...(input.capturedVerdict !== undefined ? { capturedVerdict: input.capturedVerdict } : {}),
      // Default: the empty declaration set (most plan-approval tests carry no claims).
      claimDeclarationsDigest:
        input.claimDeclarationsDigest ??
        hashText(canonicalJsonStringify(emptyClaimDeclarations('plan'))),
      consumedByObligationId: input.status === 'consumed' ? obligationId : null,
    },
  ]);
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
  reviewCycle: 1,
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
  claimScope: 'specific_behavior' as const,
  expectedCheckId: 'test',
};

const ARCHITECTURE_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000004',
  statement: 'The selected architecture keeps service data durable.',
  critical: true,
  authoritySectionId: 'decision',
  requiredReviewEvidence: ['architecture-review'],
};

function ticketFixture(text = 't', digest = 'd') {
  return {
    text,
    digest,
    source: 'user' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    riskDeclaration: { kind: 'absent' as const },
  };
}

describe('review-decision rail', () => {
  it('carries the exact decision evidence for a plan approval', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        reviewFindings: [],
        claimDeclarations: { flow: 'plan', version: 'v2', claims: [PLAN_CLAIM] },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
        claimDeclarationsDigest: hashText(
          canonicalJsonStringify({ flow: 'plan', version: 'v2', claims: [PLAN_CLAIM] }),
        ),
      }),
    });
    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'approved', decisionIdentity: reviewerIdentity },
      baseCtx,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.decisionEvidence).toEqual({
        verdict: 'approve',
        rationale: 'approved',
        decidedAt: FIXED_TIME,
        decisionIdentity: reviewerIdentity,
      });
    }
  });

  it('blocks plan approval on persisted rejected critical claims without re-formatting the diagnostic', () => {
    const rejectedClaimRef = '00000000-0000-4000-8000-000000000009';
    const rejectedReason =
      `Claim '${rejectedClaimRef}' was not admitted to the ProofGraph: counterexampleRequirement — ` +
      'a critical claim requires a counterexample requirement; without it the claim can never become PROVEN. ' +
      'Rejected critical claims block evidence approval until they are admitted or explicitly withdrawn in a new plan revision.';
    const rejectedRecovery = [
      'Correct the rejected declaration and resubmit the complete declaration set in a new plan revision',
      'If no ProofGraph authority is required, resubmit the plan revision with an explicit empty claims array (claims: []) to withdraw the rejected declarations',
    ];
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        reviewFindings: [],
        claimDeclarations: emptyClaimDeclarations('plan'),
        reviewCompletion: 'reviewer_accepted',
        claimSubmissionDiagnostics: {
          submittedClaimDeclarationsDigest: 'a'.repeat(64),
          acceptedClaimDeclarationsDigest: hashText(
            canonicalJsonStringify(emptyClaimDeclarations('plan')),
          ),
          rejectedClaims: [
            {
              claimRef: rejectedClaimRef,
              statement: 'the repository test suite passes',
              critical: true,
              disposition: 'rejected_blocking',
              code: 'PROOFGRAPH_CLAIM_NOT_DECLARED',
              reason: rejectedReason,
              recovery: rejectedRecovery,
            },
          ],
        },
      },
      reviewAssurance: planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
      }),
    });
    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'approved', decisionIdentity: reviewerIdentity },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('PROOFGRAPH_CLAIM_NOT_DECLARED');
      // The persisted canonical diagnostic is surfaced verbatim; a second
      // registry pass would nest "claim declaration — <reason>" inside itself.
      expect(result.reason).toBe(rejectedReason);
      // Historical recovery is preserved and supplemented with the current
      // catalog steps, so pre-fix sessions get the state-transition guidance.
      expect(result.recovery).toEqual(
        expect.arrayContaining([
          ...rejectedRecovery,
          expect.stringContaining('changes_requested'),
          expect.stringContaining('claims: []'),
        ]),
      );
    }
  });

  it('preserves the decision evidence when changes_requested clears the persisted decision', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        reviewFindings: [],
        claimDeclarations: emptyClaimDeclarations('plan'),
        reviewCompletion: 'reviewer_accepted',
      },
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'changes_requested', rationale: 'needs work', decisionIdentity: reviewerIdentity },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.reviewDecision).toBeNull();
      expect(result.decisionEvidence).toEqual({
        verdict: 'changes_requested',
        rationale: 'needs work',
        decidedAt: FIXED_TIME,
        decisionIdentity: reviewerIdentity,
      });
    }
  });

  it('creates an immutable certificate for the approved plan claims', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: PLAN_RECORD.current,
        history: PLAN_RECORD.history,
        reviewFindings: [],
        claimDeclarations: { flow: 'plan', version: 'v2', claims: [PLAN_CLAIM] },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
        claimDeclarationsDigest: hashText(
          canonicalJsonStringify({ flow: 'plan', version: 'v2', claims: [PLAN_CLAIM] }),
        ),
      }),
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'approved', decisionIdentity: reviewerIdentity },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.plan?.approvalCertificate).toMatchObject({
        flow: 'plan',
        authorityDigest: PLAN_RECORD.current.digest,
        claimDeclarationsDigest: hashText(
          '{"claims":[{"authoritySectionId":"authentication","claimId":"00000000-0000-4000-8000-000000000003","claimScope":"specific_behavior","critical":true,"expectedCheckId":"test","statement":"The login flow rejects invalid credentials."}],"flow":"plan","version":"v2"}',
        ),
        decisionAttestationDigest: baseCtx.digest(
          '{"decidedAt":"2026-01-01T00:00:00.000Z","decisionIdentity":{"actorAssurance":"claim_validated","actorDisplayName":"Reviewer","actorEmail":"review@example.com","actorId":"reviewer-1","actorSource":"claim"},"rationale":"approved","verdict":"approve"}',
        ),
        approvedAt: FIXED_TIME,
        approvedBy: 'reviewer-1',
        planVersion: expect.any(Number),
        planRecordDigest: expect.any(String),
        certificateId: expect.any(String),
      });
      expect(result.state.plan?.history).toEqual(PLAN_RECORD.history);
      // approve is preserve-only: the recorded decision and the counters survive.
      expect(result.state.reviewDecision?.verdict).toBe('approve');
      expect(result.state.reviewDecision?.decidedAt).toBe(FIXED_TIME);
      expect(result.state.reviewCycles).toEqual(state.reviewCycles);
    }
  });

  it('creates an immutable certificate for approved architecture claims', () => {
    const architecture = {
      ...ARCHITECTURE_DECISION,
      reviewCompletion: 'reviewer_accepted' as const,
      claimDeclarations: { flow: 'architecture' as const, claims: [ARCHITECTURE_CLAIM] },
    };
    const state = makeState('ARCH_REVIEW', {
      architecture,
      reviewAssurance: architectureAssurance({
        subjectDigest: architecture.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
      }),
    });
    const result = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'approved', decisionIdentity: reviewerIdentity },
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
          '{"decidedAt":"2026-01-01T00:00:00.000Z","decisionIdentity":{"actorAssurance":"claim_validated","actorDisplayName":"Reviewer","actorEmail":"review@example.com","actorId":"reviewer-1","actorSource":"claim"},"rationale":"approved","verdict":"approve"}',
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
      // approve is preserve-only: the recorded decision and the counters survive.
      expect(result.state.reviewDecision?.verdict).toBe('approve');
      expect(result.state.reviewDecision?.decidedAt).toBe(FIXED_TIME);
      expect(result.state.reviewCycles).toEqual(state.reviewCycles);
    }
  });

  it('reject at ARCH_REVIEW preserves reviewed evidence at the terminal position', () => {
    const state = makeState('ARCH_REVIEW', {
      architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
      selfReview: {
        iteration: 1,
        reviewCycle: 1,
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
        decisionIdentity: reviewerIdentity,
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.phase).toBe('REJECTED');
      expect(result.state.architecture).not.toBeNull();
      expect(result.state.selfReview).not.toBeNull();
      expect(result.state.reviewDecision?.verdict).toBe('reject');
    }
  });

  it('changes_requested at EVIDENCE_REVIEW clears implementation and implReview', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: ticketFixture('t', 'd'),
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      implementation: IMPL_EVIDENCE,
      implReview: {
        iteration: 1,
        reviewCycle: 1,
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
        decisionIdentity: reviewerIdentity,
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
        capturedVerdict: 'accept',
      }),
      selfReview: {
        iteration: 1,
        reviewCycle: 1,
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
        decisionIdentity: reviewerIdentity,
      },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.architecture?.status).toBe('accepted');
    }
  });

  it('regulated approve requires the structured initiator identity', () => {
    // A valid reviewer identity is always present on the input; the missing
    // initiator identity is the authority gap this boundary must reject.
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: undefined,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decisionIdentity: reviewerIdentity,
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

  it('minimum idp_verified blocks claim_validated reviewer', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
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
      { verdict: 'approve', rationale: 'ok', decisionIdentity: reviewerIdentity },
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
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      reviewAssurance: planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
      }),
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decisionIdentity: reviewerIdentity,
      },
      { ...baseCtx, policy: withPolicy({ allowSelfApproval: false }) },
    );
    expect(result.kind).toBe('ok');
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: ARCHITECTURE_DECISION.digest,
        revisionDelta: 'none',
        verdict: 'accept',
      },
    });
    const result = executeReviewDecision(
      state,
      { verdict: 'changes_requested', rationale: 'rework', decisionIdentity: reviewerIdentity },
      baseCtx,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.selfReview).toBeNull();
    }
  });

  it('changes_requested at EVIDENCE_REVIEW clears reducedCeremony alongside impl', () => {
    const reducedCeremonyDecision = REDUCED_CEREMONY_DECISION;
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: ticketFixture('t', 'd'),
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
      implReview: {
        iteration: 1,
        reviewCycle: 1,
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
        decisionIdentity: reviewerIdentity,
      },
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
    const reducedCeremonyDecision = REDUCED_CEREMONY_DECISION;
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: ticketFixture('t', 'd'),
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
      implReview: {
        iteration: 1,
        reviewCycle: 1,
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
      { verdict: 'approve', rationale: 'looks good', decisionIdentity: reviewerIdentity },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.reducedCeremony).not.toBeNull();
      expect(result.state.reducedCeremony?.profile).toBe('reduced');
    }
  });

  it('reject preserves reducedCeremony and implementation evidence at REJECTED', () => {
    const reducedCeremonyDecision = REDUCED_CEREMONY_DECISION;
    const state = makeState('EVIDENCE_REVIEW', {
      ticket: ticketFixture('t', 'd'),
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      implementation: IMPL_EVIDENCE,
      reducedCeremony: reducedCeremonyDecision,
    });

    const result = executeReviewDecision(
      state,
      { verdict: 'reject', rationale: 'start over', decisionIdentity: reviewerIdentity },
      baseCtx,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.phase).toBe('REJECTED');
      expect(result.state.reducedCeremony).toEqual(reducedCeremonyDecision);
      expect(result.state.implementation).toEqual(IMPL_EVIDENCE);
      expect(result.state.reviewDecision?.verdict).toBe('reject');
    }
  });

  it('INVALID_VERDICT includes the invalid verdict string', () => {
    const state = makeState('PLAN_REVIEW');
    const result = executeReviewDecision(
      state,
      { verdict: 'maybe' as never, rationale: 'idk', decisionIdentity: reviewerIdentity },
      baseCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('INVALID_VERDICT');
      expect(result.reason).toContain('maybe');
    }
  });

  // ─── MUTATION KILL round 2 ───────────────────────────────────
  it('idp_verified meets the assurance threshold', () => {
    const state = makeState('PLAN_REVIEW', {
      initiatedByIdentity: initiatorIdentity,
      plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      reviewAssurance: planAssurance({
        subjectDigest: PLAN_RECORD.current.digest,
        status: 'consumed',
        capturedVerdict: 'accept',
      }),
    });
    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'ok',
        decisionIdentity: { ...reviewerIdentity, actorAssurance: 'idp_verified' as const },
      },
      { ...baseCtx, policy: withPolicy({}) },
    );
    // idp_verified meets the threshold — should NOT be blocked
    expect(result.kind).toBe('ok');
  });

  // ─── MUTATION KILL ────────────────────────────────────────────────────
});
