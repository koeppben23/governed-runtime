import { describe, it, expect } from 'vitest';
import { resolveHostTaskFindings, resolveHostTaskEffectiveFindings } from './review-validation.js';
import {
  setAdapterLogger,
  resetAdapterLogger,
  type AdapterLogger,
} from '../../logging/adapter-logger.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/assurance.js';
import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence-review.js';

// ═════════════════════════════════════════════════════════════════════════════
// resolveHostTaskFindings — BUG-15 Stufe 2
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveHostTaskFindings', () => {
  const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
  const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
  const now = new Date().toISOString();

  const validRawFindings: Record<string, unknown> = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };
  const validRelation = {
    subjectAnchors: [
      {
        kind: 'repository_location',
        location: { path: 'src/foo.ts', revision: 'head', line: 10 },
      },
    ],
    evidenceLocations: [{ path: 'src/foo.ts', revision: 'head', line: 10 }],
  };
  const finding = (overrides: Record<string, unknown> = {}) => ({
    severity: 'minor',
    category: 'quality',
    message: 'stale comment',
    relation: validRelation,
    ...overrides,
  });

  function makeObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
    return {
      obligationId: OBLIGATION_ID,
      obligationType: 'plan' as const,
      subjectDigest: 'test-subject-digest',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      maxReviewerOutputRepairAttempts: 1,
      createdAt: now,
      pluginHandshakeAt: now,
      status: 'fulfilled' as const,
      invocationId: INVOCATION_ID,
      blockedCode: null,
      fulfilledAt: now,
      consumedAt: null,
      reviewSubjectScope: {
        kind: 'repository_change',
        paths: ['src/foo.ts'],
        revisions: ['base', 'head'],
      },
      ...overrides,
    };
  }

  function makeHostTaskInvocation(
    overrides: Partial<ReviewInvocationEvidence> = {},
  ): ReviewInvocationEvidence {
    return {
      invocationId: INVOCATION_ID,
      obligationId: OBLIGATION_ID,
      obligationType: 'plan' as const,
      parentSessionId: 'ses_parent',
      childSessionId: 'ses_child',
      agentType: 'flowguard-reviewer' as const,
      invocationMode: 'host_subagent_task' as const,
      hostVisible: true,
      promptHash: 'abc',
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      findingsHash: hashFindings(validRawFindings),
      invokedAt: now,
      fulfilledAt: now,
      consumedByObligationId: null,
      capturedVerdict: 'accept',
      capturedRawFindings: validRawFindings,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      attemptId: ATTEMPT_ID,
      ...overrides,
    };
  }

  // ── Happy Path ──────────────────────────────────────────────────────────

  it('HAPPY: resolves findings from host-task invocation with capturedRawFindings', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation()],
      invocations: [makeHostTaskInvocation()],
      attempts: [],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('accept');
    expect(result.findings.iteration).toBe(0);
    expect(result.findings.planVersion).toBe(1);
    expect(result.findings.reviewMode).toBe('subagent');
    expect(result.invocation.invocationId).toBe(INVOCATION_ID);
  });

  it('HAPPY: resolves changes_requested verdict from evidence', () => {
    const rawFindings = { ...validRawFindings, overallVerdict: 'changes_requested' };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'changes_requested',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('changes_requested');
  });

  it('HAPPY: resolves an implementation challenge bound to the active obligation and evidence', () => {
    const evidenceRefs = [
      { kind: 'implementation', implementationDigest: 'implementation-digest' },
      { kind: 'validation_attempt', attemptId: '33333333-3333-4333-8333-333333333333' },
    ];
    const rawFindings = {
      ...validRawFindings,
      challenges: [
        {
          challengeId: '44444444-4444-4444-8444-444444444444',
          obligationId: OBLIGATION_ID,
          scenario: 'Exercise the missing-resource update path.',
          claim: 'The implementation returns the documented missing-resource response.',
          locations: ['src/service.ts:10'],
          kind: 'implementation_challenge',
          evidenceRefs,
          outcome: 'pass',
        },
      ],
    };
    const obligation = makeObligation({
      obligationType: 'implement',
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge',
    });
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [obligation],
      invocations: [
        makeHostTaskInvocation({
          obligationType: 'implement',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };

    expect(resolveHostTaskFindings(assurance, obligation, undefined, evidenceRefs).kind).toBe(
      'resolved',
    );
  });

  // ── F12: verdict/blocking-issues coherence at the host-task boundary ────
  // Reproduces the demo defect: host-captured findings with overallVerdict
  // 'accept' AND a non-empty blockingIssues array. Verdict-only submission in
  // host-task mode never reaches the tool-layer coherence check, so the host-
  // task resolution boundary MUST fail closed here.

  it('BAD: returns incoherent when captured findings are accept + blocking issue (demo shape)', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [finding()],
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'accept',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.blockingIssueCount).toBe(1);
  });

  it('BAD: incoherent for accept + critical/major blocking issues', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [
        finding({ severity: 'critical', category: 'correctness', message: 'contract drift' }),
        finding({ severity: 'major', category: 'risk', message: 'silent data loss' }),
      ],
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'accept',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.blockingIssueCount).toBe(2);
  });

  it('HAPPY: changes_requested + blocking issues resolves normally (no coherence block)', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'changes_requested',
      blockingIssues: [finding({ severity: 'critical', category: 'correctness', message: 'bug' })],
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'changes_requested',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('resolved');
  });

  it('RECOVERY: resolves the later coherent capture after an incoherent capture', () => {
    const incoherentRawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [finding()],
    };
    const coherentRawFindings = {
      ...validRawFindings,
      overallVerdict: 'changes_requested',
      blockingIssues: [finding()],
    };
    const laterInvocationId = '33333333-3333-4333-8333-333333333333';
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: incoherentRawFindings,
          findingsHash: hashFindings(incoherentRawFindings),
        }),
        makeHostTaskInvocation({
          invocationId: laterInvocationId,
          childSessionId: 'ses_child_retry',
          capturedVerdict: 'changes_requested',
          capturedRawFindings: coherentRawFindings,
          findingsHash: hashFindings(coherentRawFindings),
        }),
      ],
    };

    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.invocationId).toBe(laterInvocationId);
    expect(result.findings.overallVerdict).toBe('changes_requested');
  });

  // ── Bad Path ────────────────────────────────────────────────────────────

  it('BAD: returns null when assurance is undefined', () => {
    expect(resolveHostTaskFindings(undefined, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns null when obligation is null', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation()],
      invocations: [makeHostTaskInvocation()],
      attempts: [],
    };
    expect(resolveHostTaskFindings(assurance, null).kind).toBe('not_found');
  });

  it('BAD: returns null when no invocation exists for obligation', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [], // no invocations
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns null when invocation has no capturedRawFindings', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: undefined,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns unparseable when capturedRawFindings fails Zod parse (missing required fields)', () => {
    const invalidRaw = { overallVerdict: 'accept' }; // missing required fields
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: invalidRaw,
        }),
      ],
    };
    // Evidence WAS captured (reviewer ran) but is corrupt — distinct from the
    // "no evidence at all" not_found case so the caller can emit a distinct block.
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('unparseable');
  });

  it('RECOVERY: resolves a later valid capture after an unparseable challenge capture', () => {
    const invalid = {
      ...validRawFindings,
      challenges: [
        {
          challengeId: '33333333-3333-4333-8333-333333333333',
          obligationId: OBLIGATION_ID,
          scenario: 'Challenge the ADR decision.',
          claim: 'The decision is supported.',
          locations: ['ADR: Decision'],
          kind: 'design_challenge',
          evidenceRefs: ['invalid-string-reference'],
          outcome: 'supported',
        },
      ],
    };
    const laterInvocationId = '44444444-4444-4444-8444-444444444444';
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: invalid,
          findingsHash: hashFindings(invalid),
        }),
        makeHostTaskInvocation({
          invocationId: laterInvocationId,
          childSessionId: 'ses_child_retry',
        }),
      ],
    };

    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.invocationId).toBe(laterInvocationId);
  });

  it('D (hardening): logs a distinct warn when captured findings are present but unparseable', () => {
    const warnCalls: Array<{ service: string; message: string; extra?: Record<string, unknown> }> =
      [];
    const spy: AdapterLogger = {
      info: () => {},
      warn: (service, message, extra) => warnCalls.push({ service, message, extra }),
      error: () => {},
    };
    setAdapterLogger(spy);
    try {
      const invalidRaw = { overallVerdict: 'accept' }; // present but malformed
      const assurance = {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        invocations: [makeHostTaskInvocation({ capturedRawFindings: invalidRaw })],
        attempts: [],
      };

      const result = resolveHostTaskFindings(assurance, makeObligation());

      // Fail-closed and DISTINCT (unparseable, not the generic not_found): the
      // garbled capture is now both observable in logs and signalled to the caller.
      expect(result.kind).toBe('unparseable');
      const unparseable = warnCalls.find((c) => /unparseable/i.test(c.message));
      expect(unparseable).toBeDefined();
      expect(unparseable?.extra).toMatchObject({ invocationId: INVOCATION_ID });
    } finally {
      resetAdapterLogger();
    }
  });

  it('D (hardening): does NOT warn unparseable when there is simply no evidence', () => {
    const warnCalls: string[] = [];
    const spy: AdapterLogger = {
      info: () => {},
      warn: (_service, message) => warnCalls.push(message),
      error: () => {},
    };
    setAdapterLogger(spy);
    try {
      const assurance = {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        invocations: [],
        attempts: [],
      };
      expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
      expect(warnCalls.find((m) => /unparseable/i.test(m))).toBeUndefined();
    } finally {
      resetAdapterLogger();
    }
  });

  it('BAD: rejects host-task findings when obligation is blocked', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [
        makeObligation({
          status: 'blocked',
          blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
        }),
      ],
      invocations: [makeHostTaskInvocation()],
      attempts: [],
    };
    const result = resolveHostTaskFindings(
      assurance,
      makeObligation({ status: 'blocked', blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED' }),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');
    expect(result.rejection.status).toBe('blocked');
    expect(result.rejection.path).toBe('host_task');
  });

  it('BAD: rejects host-task findings when obligation status is consumed', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation({ status: 'consumed' })],
      invocations: [makeHostTaskInvocation()],
      attempts: [],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation({ status: 'consumed' }));

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  it('BAD: rejects host-task findings when obligation has consumedAt', () => {
    const consumedAt = new Date(Date.now() + 1).toISOString();
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation({ consumedAt })],
      invocations: [makeHostTaskInvocation()],
      attempts: [],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation({ consumedAt }));

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  it('EDGE: skips already-consumed invocations', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          consumedByObligationId: '99999999-9999-4999-8999-999999999999',
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('invocation_consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  it('EDGE: skips SDK invocations (only host_subagent_task)', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          invocationMode: 'sdk_session_prompt',
          hostVisible: false,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: skips non-host-visible invocations', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          hostVisible: false,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: skips invocations with mismatched obligationId', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          obligationId: '33333333-3333-4333-8333-333333333333',
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: rejects the first matching consumed invocation when multiple exist', () => {
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          consumedByObligationId: '99999999-9999-4999-8999-999999999999', // consumed
        }),
        makeHostTaskInvocation({
          invocationId: '44444444-4444-4444-8444-444444444444',
          // unconsumed
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('invocation_consumed');
  });

  it('CORNER: extra unknown fields in capturedRawFindings are stripped by Zod parse', () => {
    const rawWithExtras = {
      ...validRawFindings,
      extraField: 'should-be-stripped',
      _internal: { foo: 'bar' },
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: rawWithExtras,
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('accept');
    // Extra fields are stripped by Zod
    expect((result.findings as Record<string, unknown>).extraField).toBeUndefined();
  });

  it('CORNER: findings with unable_to_review verdict still resolve (defense-in-depth at tool layer)', () => {
    const rawFindings = { ...validRawFindings, overallVerdict: 'unable_to_review' };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      attempts: [],
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: rawFindings,
          capturedVerdict: 'unable_to_review',
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    // resolveHostTaskFindings itself does NOT block unable_to_review —
    // that's the tool layer's defense-in-depth responsibility.
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('unable_to_review');
  });

  it('incoherent resolution carries the attemptId of the offending invocation', () => {
    // The incoherent result MUST carry the exact persisted attemptId so the
    // verdict path can reject the correct attempt by identity — not by
    // obligation+childSessionId lookup or array-position heuristics.
    const childId = 'ses_incoherent_child';
    const targetAttemptId = '55555555-5555-4555-8555-555555555555';
    const offensiveRawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [finding({ message: 'stale' })],
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          childSessionId: childId,
          capturedVerdict: 'accept',
          capturedRawFindings: offensiveRawFindings,
          findingsHash: hashFindings(offensiveRawFindings),
        }),
      ],
      attempts: [
        {
          attemptId: targetAttemptId,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          subjectDigest: 'test-subject-digest',
          childSessionId: childId,
          ordinal: 0,
          status: 'bound' as const,
          origin: { kind: 'initial' } as const,
          createdAt: now,
        },
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.attemptId).toBe(targetAttemptId);
  });

  it('incoherent result carries the attemptId of the challenge-consistency failure', () => {
    const childId = 'ses_challenge_incoherent_child';
    const targetAttemptId = '66666666-6666-4666-8666-666666666666';
    const challengeRawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      challenges: [
        {
          challengeId: '11111111-1111-4111-8111-111111111111',
          obligationId: '22222222-2222-4222-8222-222222222222',
          scenario: 'the system fails under load',
          claim: 'the system handles concurrent users',
          locations: ['src/service.ts'],
          kind: 'design_challenge',
          outcome: 'not_verified',
          evidenceRefs: [
            {
              kind: 'plan_adr_section',
              artifactKind: 'plan',
              artifactDigest: 'a'.repeat(64),
              sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
              excerptDigest: 'a'.repeat(64),
            },
          ],
        },
      ],
    };
    const assurance = {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [makeObligation({ requiredChallengeCount: 1 })],
      invocations: [
        makeHostTaskInvocation({
          childSessionId: childId,
          attemptId: targetAttemptId,
          capturedVerdict: 'accept',
          capturedRawFindings: challengeRawFindings,
          findingsHash: hashFindings(challengeRawFindings),
        }),
      ],
      attempts: [
        {
          attemptId: targetAttemptId,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          subjectDigest: 'test-subject-digest',
          childSessionId: childId,
          ordinal: 0,
          status: 'bound' as const,
          origin: { kind: 'initial' } as const,
          createdAt: now,
        },
      ],
    };
    const result = resolveHostTaskFindings(
      assurance,
      makeObligation({ requiredChallengeCount: 1 }),
    );
    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.attemptId).toBe(targetAttemptId);
    expect(result.code).toBe('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
  });

  it('returns the exact persisted attemptId from invocation (not derived)', () => {
    const specificAttemptId = '77777777-7777-4777-8777-777777777777';
    const invocation = makeHostTaskInvocation({
      attemptId: specificAttemptId,
      capturedRawFindings: {
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      },
      findingsHash: hashFindings({
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      }),
    });
    const result = resolveHostTaskFindings(
      {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        invocations: [invocation],
        attempts: [
          {
            attemptId: '88888888-8888-4888-8888-888888888888',
            obligationId: OBLIGATION_ID,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            childSessionId: 'ses_child',
            ordinal: 0,
            status: 'bound' as const,
            origin: { kind: 'initial' } as const,
            createdAt: now,
          },
          {
            attemptId: specificAttemptId,
            obligationId: OBLIGATION_ID,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            childSessionId: 'ses_child',
            ordinal: 1,
            status: 'bound' as const,
            origin: { kind: 'initial' } as const,
            createdAt: now,
          },
        ],
      },
      makeObligation(),
    );
    expect(result).toMatchObject({
      kind: 'incoherent',
      attemptId: specificAttemptId,
    });
  });

  it('does not derive attempt identity from childSessionId', () => {
    const correctAttemptId = '99999999-9999-4999-8999-999999999999';
    const sharedChildId = 'ses_shared';
    const invocation = makeHostTaskInvocation({
      attemptId: correctAttemptId,
      childSessionId: sharedChildId,
      capturedRawFindings: {
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      },
      findingsHash: hashFindings({
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      }),
    });
    const result = resolveHostTaskFindings(
      {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        invocations: [invocation],
        attempts: [
          {
            attemptId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            obligationId: OBLIGATION_ID,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            childSessionId: sharedChildId,
            ordinal: 0,
            status: 'bound' as const,
            origin: { kind: 'initial' } as const,
            createdAt: now,
          },
          {
            attemptId: correctAttemptId,
            obligationId: OBLIGATION_ID,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            childSessionId: 'ses_other',
            ordinal: 1,
            status: 'bound' as const,
            origin: { kind: 'initial' } as const,
            createdAt: now,
          },
        ],
      },
      makeObligation(),
    );
    expect(result).toMatchObject({
      kind: 'incoherent',
      attemptId: correctAttemptId,
    });
  });

  it('returns attempt_lineage_unavailable when invocation has no attemptId', () => {
    const invocation = makeHostTaskInvocation({
      attemptId: undefined,
      capturedRawFindings: {
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      },
      findingsHash: hashFindings({
        ...validRawFindings,
        overallVerdict: 'accept',
        blockingIssues: [finding({ message: 'stale' })],
      }),
    });
    const result = resolveHostTaskFindings(
      {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        invocations: [invocation],
        attempts: [],
      },
      makeObligation(),
    );
    expect(result).toMatchObject({
      kind: 'attempt_lineage_unavailable',
      invocationId: INVOCATION_ID,
    });
  });

  it('RECOVERY: resolves a later coherent capture after a legacy incoherent capture without attemptId', () => {
    const legacyIncoherent = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [
        finding({ severity: 'major', category: 'correctness', message: 'legacy contradiction' }),
      ],
    };

    const coherentRetry = {
      ...validRawFindings,
      overallVerdict: 'changes_requested',
      blockingIssues: [
        finding({ severity: 'major', category: 'correctness', message: 'valid retry finding' }),
      ],
    };

    const retryInvocationId = '77777777-7777-4777-8777-777777777777';
    const retryAttemptId = '88888888-8888-4888-8888-888888888888';

    const result = resolveHostTaskFindings(
      {
        assuranceSchemaVersion: 'review-assurance.v2' as const,
        obligations: [makeObligation()],
        attempts: [],
        invocations: [
          makeHostTaskInvocation({
            invocationId: '66666666-6666-4666-8666-666666666666',
            attemptId: undefined,
            capturedRawFindings: legacyIncoherent,
            findingsHash: hashFindings(legacyIncoherent),
          }),
          makeHostTaskInvocation({
            invocationId: retryInvocationId,
            attemptId: retryAttemptId,
            childSessionId: 'ses_retry',
            capturedVerdict: 'changes_requested',
            capturedRawFindings: coherentRetry,
            findingsHash: hashFindings(coherentRetry),
          }),
        ],
      },
      makeObligation(),
    );

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved retry');
    expect(result.invocationId).toBe(retryInvocationId);
    expect(result.invocation.attemptId).toBe(retryAttemptId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveHostTaskEffectiveFindings — directly-submitted challenge freshness (Gap 2)
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveHostTaskEffectiveFindings — directly-submitted challenge freshness', () => {
  const CHALLENGE_OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const IMPL_REF = { kind: 'implementation', implementationDigest: 'current-digest' };
  const FRESH_ATTEMPT_REF = {
    kind: 'validation_attempt',
    attemptId: '44444444-4444-4444-8444-444444444444',
  };

  function challengeObligation(): ReviewObligation {
    return {
      obligationId: CHALLENGE_OBLIGATION_ID,
      obligationType: 'implement' as const,
      subjectDigest: 'test-subject-digest',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      maxReviewerOutputRepairAttempts: 1,
      createdAt: new Date().toISOString(),
      pluginHandshakeAt: null,
      status: 'pending' as const,
      invocationId: null,
      blockedCode: null,
      fulfilledAt: null,
      consumedAt: null,
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge' as const,
      reviewSubjectScope: {
        kind: 'repository_change',
        paths: ['src/foo.ts'],
        revisions: ['base', 'head'],
      },
    };
  }

  function submittedFindings(evidenceRefs: readonly unknown[]): Record<string, unknown> {
    return {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_child' },
      reviewedAt: new Date().toISOString(),
      challenges: [
        {
          challengeId: '33333333-3333-4333-8333-333333333333',
          obligationId: CHALLENGE_OBLIGATION_ID,
          scenario: 'The change breaks the failing edge case.',
          claim: 'The new guard handles the null path.',
          locations: ['src/foo.ts:10'],
          kind: 'implementation_challenge',
          evidenceRefs,
          outcome: 'pass',
        },
      ],
    };
  }

  function makeCtx(evidenceRefs: readonly unknown[]) {
    // sdk_allowed => NOT host-task mode => directly-submitted branch (Gap 2 fix).
    return {
      pendingObligation: challengeObligation(),
      expected: { obligationType: 'implement' as const, iteration: 0, planVersion: 1 },
      policy: {
        reviewInvocationPolicy: 'sdk_allowed' as const,
        strictEnforcement: false,
        subagentEnabled: true,
        fallbackToSelf: false,
      },
      input: { reviewFindings: submittedFindings(evidenceRefs), verdict: 'accept' },
      state: {
        assurance: {
          assuranceSchemaVersion: 'review-assurance.v2' as const,
          obligations: [challengeObligation()],
          invocations: [],
          attempts: [],
        },
        sessionId: 'ses_parent',
        reviewHostPlatform: 'opencode' as const,
        unresolvedImplementationChallengeIds: [],
        allowedChallengeEvidenceRefs: [IMPL_REF, FRESH_ATTEMPT_REF],
      },
    };
  }

  it('accepts directly-submitted findings whose challenge cites a fresh, allowed attempt', () => {
    const result = resolveHostTaskEffectiveFindings(makeCtx([IMPL_REF, FRESH_ATTEMPT_REF]));
    expect(result.blocked).toBeUndefined();
    expect(result.effectiveFindings).toBeDefined();
  });

  it('blocks directly-submitted findings whose challenge cites a stale/foreign attempt', () => {
    // The exact Gap 2 leak: on the directly-submitted path the freshness set was
    // never passed, so a validation_attempt outside allowedChallengeEvidenceRefs
    // was silently accepted. It must now fail closed.
    const staleRef = {
      kind: 'validation_attempt',
      attemptId: '99999999-9999-4999-8999-999999999999',
    };
    const result = resolveHostTaskEffectiveFindings(makeCtx([IMPL_REF, staleRef]));
    expect(result.effectiveFindings).toBeUndefined();
    expect(result.blocked).toBeDefined();
    expect(String(result.blocked)).toContain('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
  });
});
