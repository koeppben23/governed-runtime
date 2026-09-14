/**
 * @module evidence-review-authority-coherence.test
 * @description Current-epoch authority boundary tests: obligation/authority
 *              coherence, strict persisted schemas, and fingerprint generation.
 */
import { describe, it, expect } from 'vitest';
import {
  ReviewObligation,
  ReviewAttempt,
  ReviewInvocationEvidence,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewInputFingerprintVersion,
} from './evidence-review.js';
import { FIXED_TIME, FIXED_UUID } from './evidence-test-constants.js';

describe('Obligation repository authority coherence (schema refinement)', () => {
  const LOCAL = { kind: 'local' as const, rootCommitDigest: 'a'.repeat(64) };
  const CANDIDATE_PAIR = {
    kind: 'candidate_pair' as const,
    base: { kind: 'commit' as const, repositoryIdentity: LOCAL, objectSha: 'b'.repeat(40) },
    head: { kind: 'commit' as const, repositoryIdentity: LOCAL, objectSha: 'a'.repeat(40) },
  };
  const CONTEXT_AUTHORITY = {
    kind: 'context' as const,
    context: {
      kind: 'commit' as const,
      repositoryIdentity: { host: 'github.com', owner: 'acme', name: 'repo' },
      objectSha: 'c'.repeat(40),
    },
  };

  function repositoryReviewObligation(overrides: Record<string, unknown> = {}) {
    return {
      obligationId: FIXED_UUID,
      obligationType: 'review' as const,
      iteration: 0,
      planVersion: 1,
      criteriaVersion: 'p40-v1',
      mandateDigest: 'sha256-mandate',
      createdAt: FIXED_TIME,
      pluginHandshakeAt: null,
      status: 'pending' as const,
      invocationId: null,
      blockedCode: null,
      fulfilledAt: null,
      consumedAt: null,
      reviewProfile: 'core' as const,
      profileSource: 'policy_default' as const,
      requiredChallengeCount: 0,
      requiredChallengeKind: 'content_challenge' as const,
      challengePolicyVersion: 'challenge-policy.v1' as const,
      subjectDigest: 'a'.repeat(64),
      reviewMaterial: {
        content: 'frozen review material',
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'a'.repeat(64),
      },
      reviewSubject: {
        kind: 'repository_change' as const,
        source: { kind: 'branch' as const, branch: 'feature/x' },
        baseRepository: LOCAL,
        headRepository: LOCAL,
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        changedPaths: ['src/a.ts'],
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'a'.repeat(64),
      },
      reviewSubjectScope: {
        kind: 'repository_change' as const,
        paths: ['src/a.ts'],
        revisions: ['base', 'head'] as const,
      },
      repositoryAuthority: CANDIDATE_PAIR,
      maxReviewerOutputRepairAttempts: 1,
      ...overrides,
    };
  }

  it('accepts a repository_change review whose authority exactly matches the subject', () => {
    expect(ReviewObligation.safeParse(repositoryReviewObligation()).success).toBe(true);
  });

  it('rejects an authority whose head SHA diverges from the frozen subject', () => {
    const obligation = repositoryReviewObligation({
      repositoryAuthority: {
        ...CANDIDATE_PAIR,
        head: { ...CANDIDATE_PAIR.head, objectSha: 'c'.repeat(40) },
      },
    });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('exactly match the frozen reviewSubject');
  });

  it('rejects a repository_change review without frozen authority', () => {
    const obligation = repositoryReviewObligation({ repositoryAuthority: undefined });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('require frozen repository authority');
  });

  it('rejects a context authority on a repository_change review', () => {
    const obligation = repositoryReviewObligation({
      repositoryAuthority: CONTEXT_AUTHORITY,
    });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('candidate-pair or fork-pair');
  });

  it('rejects repository authority on a content review', () => {
    const obligation = repositoryReviewObligation({
      reviewSubject: {
        kind: 'content' as const,
        source: { kind: 'inline' as const, mediaType: 'text' as const },
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'a'.repeat(64),
        lineCount: 1,
      },
      reviewSubjectScope: {
        kind: 'content' as const,
        subjectDigest: 'a'.repeat(64),
        lineCount: 1,
      },
    });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('must not carry repository authority');
  });

  it('rejects a context authority on an implement obligation', () => {
    const obligation = repositoryReviewObligation({
      obligationType: 'implement' as const,
      requiredChallengeKind: 'implementation_challenge' as const,
      reviewSubject: undefined,
      reviewSubjectScope: {
        kind: 'implementation' as const,
        implementationDigest: 'a'.repeat(64),
      },
      repositoryAuthority: CONTEXT_AUTHORITY,
    });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('candidate-pair repository authority');
  });

  it('rejects a candidate-pair authority on a plan obligation', () => {
    const obligation = repositoryReviewObligation({
      obligationType: 'plan' as const,
      requiredChallengeKind: 'design_challenge' as const,
      reviewSubject: undefined,
      reviewSubjectScope: {
        kind: 'artifact' as const,
        artifact: {
          kind: 'plan' as const,
          digest: 'a'.repeat(64),
          sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Approach' }]],
        },
      },
      repositoryEvidenceFreeze: { kind: 'available' as const },
    });
    const result = ReviewObligation.safeParse(obligation);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('context authority');
  });
});

describe('ReviewInputFingerprintVersion', () => {
  it('accepts the current v2 generation and rejects the removed v1', () => {
    expect(ReviewInputFingerprintVersion.safeParse('v2').success).toBe(true);
    expect(ReviewInputFingerprintVersion.safeParse('v1').success).toBe(false);
  });
});

describe('Current persisted authority schemas are strict', () => {
  const DECISION_IDENTITY = {
    actorId: 'reviewer-1',
    actorEmail: null,
    actorSource: 'env' as const,
    actorAssurance: 'best_effort' as const,
  };

  const VALID_DECISION = {
    verdict: 'approve' as const,
    rationale: 'LGTM',
    decidedAt: FIXED_TIME,
    decisionIdentity: DECISION_IDENTITY,
  };

  const VALID_INVOCATION = {
    invocationId: FIXED_UUID,
    obligationId: FIXED_UUID,
    obligationType: 'plan' as const,
    parentSessionId: 'ses_parent',
    childSessionId: 'ses_child',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'host_subagent_task' as const,
    hostVisible: true,
    source: 'host-orchestrated' as const,
    promptHash: 'sha256-prompt',
    mandateDigest: 'sha256-mandate',
    criteriaVersion: 'p40-v1',
    findingsHash: 'sha256-findings',
    invokedAt: FIXED_TIME,
    fulfilledAt: FIXED_TIME,
    consumedByObligationId: null,
    attemptId: '22222222-2222-4222-8222-222222222222',
    reviewOutputMode: 'structured_output' as const,
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high' as const,
  };

  const VALID_ATTEMPT = {
    attemptId: '22222222-2222-4222-8222-222222222222',
    obligationId: FIXED_UUID,
    obligationType: 'plan' as const,
    subjectDigest: 'a'.repeat(64),
    ordinal: 0,
    childSessionId: 'ses_child',
    status: 'bound' as const,
    origin: { kind: 'initial' as const },
    repositoryDiscovery: { kind: 'not_applicable' as const },
    observations: [],
    createdAt: FIXED_TIME,
    completedAt: FIXED_TIME,
  };

  const PLAN_OBLIGATION = {
    obligationId: FIXED_UUID,
    obligationType: 'plan' as const,
    iteration: 0,
    planVersion: 1,
    criteriaVersion: 'p40-v1',
    mandateDigest: 'sha256-mandate',
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'pending' as const,
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewProfile: 'core' as const,
    profileSource: 'policy_default' as const,
    requiredChallengeCount: 0,
    requiredChallengeKind: 'design_challenge' as const,
    challengePolicyVersion: 'challenge-policy.v1' as const,
    subjectDigest: 'a'.repeat(64),
    reviewMaterial: {
      content: 'frozen review material',
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'a'.repeat(64),
    },
    reviewSubjectScope: {
      kind: 'artifact' as const,
      artifact: {
        kind: 'plan' as const,
        digest: 'a'.repeat(64),
        sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Approach' }]],
      },
    },
    repositoryEvidenceFreeze: { kind: 'unavailable' as const, reason: 'repository_unavailable' },
    maxReviewerOutputRepairAttempts: 1,
  };

  function assuranceWithInvocation(invocation: Record<string, unknown>) {
    return ReviewAssuranceState.safeParse({
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [PLAN_OBLIGATION],
      invocations: [invocation],
      attempts: [VALID_ATTEMPT],
      dispatches: [],
    });
  }

  it('ReviewDecision rejects the legacy decidedBy mixed shape', () => {
    expect(ReviewDecision.safeParse(VALID_DECISION).success).toBe(true);
    expect(
      ReviewDecision.safeParse({ ...VALID_DECISION, decidedBy: 'legacy-reviewer' }).success,
    ).toBe(false);
  });

  it('ReviewInvocationEvidence is strict and rejects removed transport fields', () => {
    expect(ReviewInvocationEvidence.safeParse(VALID_INVOCATION).success).toBe(true);
    expect(
      ReviewInvocationEvidence.safeParse({
        ...VALID_INVOCATION,
        extractionMethod: 'direct_json',
      }).success,
    ).toBe(false);
    expect(
      ReviewInvocationEvidence.safeParse({
        ...VALID_INVOCATION,
        modelCapabilityError: 'no structured output',
      }).success,
    ).toBe(false);
  });

  it('ReviewAttempt requires observations and rejects unknown properties', () => {
    expect(ReviewAttempt.safeParse(VALID_ATTEMPT).success).toBe(true);
    const { observations: _observations, ...withoutObservations } = VALID_ATTEMPT;
    expect(ReviewAttempt.safeParse(withoutObservations).success).toBe(false);
    expect(ReviewAttempt.safeParse({ ...VALID_ATTEMPT, decidedBy: 'legacy' }).success).toBe(false);
  });

  it('ReviewAssuranceState rejects an orphan attempt', () => {
    const result = ReviewAssuranceState.safeParse({
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [],
      invocations: [],
      attempts: [VALID_ATTEMPT],
      dispatches: [],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('references unknown obligation');
  });

  it('ReviewAssuranceState rejects unknown and mismatched dispatch references', () => {
    const dispatch = {
      dispatchId: '33333333-3333-4333-8333-333333333333',
      attemptId: VALID_ATTEMPT.attemptId,
      obligationId: FIXED_UUID,
      hostCallId: 'call-1',
      canonicalPromptDigest: 'a'.repeat(64),
      dispatchAuthorizedAt: FIXED_TIME,
      dispatchStatus: 'authorized' as const,
    };
    const base = {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [PLAN_OBLIGATION],
      invocations: [],
      attempts: [VALID_ATTEMPT],
    };

    const unknownAttempt = ReviewAssuranceState.safeParse({
      ...base,
      dispatches: [{ ...dispatch, attemptId: '99999999-9999-4999-8999-999999999999' }],
    });
    expect(unknownAttempt.success).toBe(false);
    if (unknownAttempt.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(unknownAttempt.error.issues)).toContain('references unknown attempt');

    const mismatched = ReviewAssuranceState.safeParse({
      ...base,
      dispatches: [{ ...dispatch, obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
    });
    expect(mismatched.success).toBe(false);
    if (mismatched.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(mismatched.error.issues)).toContain(
      'obligation does not match its attempt',
    );

    const duplicate = ReviewAssuranceState.safeParse({
      ...base,
      dispatches: [dispatch, { ...dispatch, hostCallId: 'call-2' }],
    });
    expect(duplicate.success).toBe(false);
    if (duplicate.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(duplicate.error.issues)).toContain('duplicate dispatchId');
  });

  it('native_subagent_attested requires all host-capture corroboration fields', () => {
    const nativeInvocation = {
      ...VALID_INVOCATION,
      invocationMode: 'native_subagent_attested' as const,
      hostVisible: false,
      source: 'agent-submitted-attested' as const,
      reviewOutputMode: 'agent_submitted_structured' as const,
      structuredOutputUsed: false,
      reviewAssuranceLevel: 'structured_submitted' as const,
    };
    expect(
      assuranceWithInvocation({ ...nativeInvocation, hostCapturedAgentId: 'agent-1' }).success,
    ).toBe(false);
    expect(
      assuranceWithInvocation({
        ...nativeInvocation,
        hostCapturedAgentId: 'agent-1',
        hostCapturedAgentType: 'flowguard-reviewer',
        hostCaptureSource: 'post_tool_use_hook',
      }).success,
    ).toBe(true);
  });

  it('manual_attested rejects host-capture corroboration fields', () => {
    const manual = {
      ...VALID_INVOCATION,
      invocationMode: 'manual_attested' as const,
      hostVisible: false,
      source: 'agent-submitted-attested' as const,
      reviewOutputMode: 'agent_submitted_structured' as const,
      structuredOutputUsed: false,
      reviewAssuranceLevel: 'structured_submitted' as const,
    };
    const result = assuranceWithInvocation({
      ...manual,
      hostCapturedAgentId: 'agent-1',
      hostCapturedAgentType: 'flowguard-reviewer',
      hostCaptureSource: 'post_tool_use_hook',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('consistent invocation provenance');
  });

  it('rejects a host transport claiming agent-submitted source', () => {
    const result = assuranceWithInvocation({
      ...VALID_INVOCATION,
      source: 'agent-submitted-attested' as const,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('consistent invocation provenance');
  });
});

describe('Attempt lineage and dispatch lifecycle', () => {
  const DECISION_IDENTITY = {
    actorId: 'reviewer-1',
    actorEmail: null,
    actorSource: 'env' as const,
    actorAssurance: 'best_effort' as const,
  };
  void DECISION_IDENTITY;

  const PLAN_OBLIGATION = {
    obligationId: FIXED_UUID,
    obligationType: 'plan' as const,
    iteration: 0,
    planVersion: 1,
    criteriaVersion: 'p40-v1',
    mandateDigest: 'sha256-mandate',
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'pending' as const,
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewProfile: 'core' as const,
    profileSource: 'policy_default' as const,
    requiredChallengeCount: 0,
    requiredChallengeKind: 'design_challenge' as const,
    challengePolicyVersion: 'challenge-policy.v1' as const,
    subjectDigest: 'a'.repeat(64),
    reviewMaterial: {
      content: 'frozen review material',
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'a'.repeat(64),
    },
    reviewSubjectScope: {
      kind: 'artifact' as const,
      artifact: {
        kind: 'plan' as const,
        digest: 'a'.repeat(64),
        sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Approach' }]],
      },
    },
    repositoryEvidenceFreeze: { kind: 'unavailable' as const, reason: 'repository_unavailable' },
    maxReviewerOutputRepairAttempts: 3,
  };

  const REJECTED_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
  const REPAIR_ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
  const LATER = '2026-01-01T00:00:01.000Z';

  const REJECTED_ATTEMPT = {
    attemptId: REJECTED_ATTEMPT_ID,
    obligationId: FIXED_UUID,
    obligationType: 'plan' as const,
    subjectDigest: 'a'.repeat(64),
    ordinal: 0,
    childSessionId: 'ses_child',
    status: 'rejected' as const,
    origin: { kind: 'initial' as const },
    rejectionReason: 'schema_invalid' as const,
    repositoryDiscovery: { kind: 'not_applicable' as const },
    observations: [],
    createdAt: FIXED_TIME,
    completedAt: FIXED_TIME,
  };

  function repairAttempt(overrides: Record<string, unknown> = {}) {
    return {
      attemptId: REPAIR_ATTEMPT_ID,
      obligationId: FIXED_UUID,
      obligationType: 'plan' as const,
      subjectDigest: 'a'.repeat(64),
      ordinal: 1,
      status: 'created' as const,
      origin: {
        kind: 'output_repair' as const,
        predecessorAttemptId: REJECTED_ATTEMPT_ID,
        triggerReason: 'schema_invalid' as const,
      },
      repositoryDiscovery: { kind: 'not_applicable' as const },
      observations: [],
      createdAt: LATER,
      ...overrides,
    };
  }

  function parseLineage(attempts: readonly unknown[]) {
    return ReviewAssuranceState.safeParse({
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [PLAN_OBLIGATION],
      invocations: [],
      attempts,
      dispatches: [],
    });
  }

  it('HAPPY: coherent output_repair lineage parses', () => {
    expect(parseLineage([REJECTED_ATTEMPT, repairAttempt()]).success).toBe(true);
  });

  it('ReviewAttempt rejects the removed reviewMaterial copy', () => {
    const attempt = {
      ...REJECTED_ATTEMPT,
      reviewMaterial: {
        content: 'stale copy',
        materialDigest: 'b'.repeat(64),
        subjectDigest: 'a'.repeat(64),
      },
    };
    expect(ReviewAttempt.safeParse(attempt).success).toBe(false);
  });

  it('rejects an unknown predecessor', () => {
    const result = parseLineage([
      REJECTED_ATTEMPT,
      repairAttempt({
        origin: {
          kind: 'output_repair' as const,
          predecessorAttemptId: '99999999-9999-4999-8999-999999999999',
          triggerReason: 'schema_invalid' as const,
        },
      }),
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('references unknown predecessor');
  });

  it('rejects a predecessor bound to a different subject', () => {
    const foreignPredecessor = {
      ...REJECTED_ATTEMPT,
      subjectDigest: 'b'.repeat(64),
    };
    const result = parseLineage([foreignPredecessor, repairAttempt()]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('belongs to a different obligation');
  });

  it('rejects a predecessor that is not strictly earlier', () => {
    const result = parseLineage([
      { ...REJECTED_ATTEMPT, ordinal: 2 },
      repairAttempt({ ordinal: 1 }),
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('not an earlier attempt');
  });

  it('rejects a trigger reason that contradicts the predecessor state', () => {
    const result = parseLineage([
      { ...REJECTED_ATTEMPT, rejectionReason: 'consistency_invalid' as const },
      repairAttempt(),
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain(
      'trigger reason does not match its predecessor state',
    );
  });

  it('rejects duplicate attempt ordinals for one obligation', () => {
    const result = parseLineage([
      REJECTED_ATTEMPT,
      { ...REJECTED_ATTEMPT, attemptId: REPAIR_ATTEMPT_ID },
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('duplicate attempt ordinal');
  });

  function parseDispatches(dispatches: readonly unknown[]) {
    return ReviewAssuranceState.safeParse({
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [PLAN_OBLIGATION],
      invocations: [],
      attempts: [REJECTED_ATTEMPT, repairAttempt()],
      dispatches,
    });
  }

  function dispatch(overrides: Record<string, unknown> = {}) {
    return {
      dispatchId: '33333333-3333-4333-8333-333333333333',
      attemptId: REJECTED_ATTEMPT_ID,
      obligationId: FIXED_UUID,
      hostCallId: 'call-1',
      canonicalPromptDigest: 'a'.repeat(64),
      dispatchAuthorizedAt: FIXED_TIME,
      dispatchStatus: 'authorized' as const,
      ...overrides,
    };
  }

  it('HAPPY: one authorized dispatch per attempt parses', () => {
    expect(parseDispatches([dispatch()]).success).toBe(true);
  });

  it('rejects a duplicate hostCallId across dispatches', () => {
    const result = parseDispatches([
      dispatch(),
      dispatch({
        dispatchId: '55555555-5555-4555-8555-555555555555',
        attemptId: REPAIR_ATTEMPT_ID,
        hostCallId: 'call-1',
      }),
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('duplicate hostCallId');
  });

  it('rejects more than one active dispatch for the same attempt', () => {
    const result = parseDispatches([
      dispatch(),
      dispatch({
        dispatchId: '55555555-5555-4555-8555-555555555555',
        hostCallId: 'call-2',
      }),
    ]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('more than one active dispatch');
  });

  it('rejects an authorized dispatch carrying completedAt', () => {
    const result = parseDispatches([dispatch({ completedAt: FIXED_TIME })]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('authorized but carries completedAt');
  });

  it('rejects a completed dispatch without completedAt', () => {
    const result = parseDispatches([dispatch({ dispatchStatus: 'completed' as const })]);
    expect(result.success).toBe(false);
    if (result.success) throw new TypeError('expected schema rejection');
    expect(JSON.stringify(result.error.issues)).toContain('completed but is missing completedAt');
  });
});
