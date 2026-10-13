/**
 * @module audit/iso27001/selectors.test
 * @description Positive and fail-closed resolution tests for every selector.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { CURRENT_IMPL_RISK_ASSESSMENT, IMPL_EVIDENCE } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import {
  makeAssertionExtraction,
  makeBoundImplFindings,
  makeDecisionTrail,
  makeImplementationAttempt,
  makeIsoState,
  makeSelectorContext,
  makeVerifiedSnapshot,
  TEST_ATTEMPT_ID,
  withPlanCertificate,
} from './iso27001-test-helpers.js';
import { resolveSelector } from './selector-resolve.js';
import type { EvidenceSelector, SelectorContext } from './selectors.js';

const CLAIM_ID = '00000000-0000-4000-8000-000000000767';

function contextFor(
  state: SessionState,
  events: Parameters<typeof makeVerifiedSnapshot>[1] = [],
  liveBinding?: Parameters<typeof makeSelectorContext>[1],
): SelectorContext {
  const snapshot = makeVerifiedSnapshot(state, events);
  return makeSelectorContext(snapshot, liveBinding);
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return makeIsoState({
    validationAttempts: [makeImplementationAttempt({})],
    ...overrides,
  });
}

function resolve(selector: EvidenceSelector, state: SessionState, context?: SelectorContext) {
  return resolveSelector(selector, context ?? contextFor(state));
}

describe('audit/iso27001/selectors', () => {
  describe('HAPPY — declared minimum evidence resolves to linked, verified references', () => {
    it('plan.approved verifies the current certificate binding', () => {
      const state = baseState();
      const result = resolve({ kind: 'plan.approved' }, state);
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.planDigest).toBe(state.plan?.current.digest);
      expect(result.evidence[0]?.member).toBe('state/session-state.json');
    });

    it('plan.approver_identity verifies an explicit decision at the required assurance', () => {
      const state = baseState();
      const result = resolve(
        { kind: 'plan.approver_identity', minActorAssurance: 'best_effort' },
        state,
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.actorIdDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.evidence[0]?.actorAssurance).not.toBeNull();
    });

    it('implementation.revision verifies the review-bound implementation digest', () => {
      const state = baseState();
      const result = resolve({ kind: 'implementation.revision' }, state);
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.implementationDigest).toBe(IMPL_EVIDENCE.digest);
    });

    it('review.implementation_verdict verifies digest-bound accepted findings', () => {
      const bound = makeBoundImplFindings(IMPL_EVIDENCE.digest);
      const state = baseState({
        implReviewFindings: [bound.findings],
        reviewAssurance: bound.assurance,
      });
      const result = resolve(
        { kind: 'review.implementation_verdict', acceptedVerdicts: ['accept'] },
        state,
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
    });

    it('validation.assertion_passed verifies the asserted attempt-bound assertion', () => {
      const extraction = makeAssertionExtraction({
        attemptId: TEST_ATTEMPT_ID,
        localId: 'auth.spec.ts::rejects-invalid-token',
        status: 'passed',
      });
      const state = baseState({
        validationAttempts: [makeImplementationAttempt({ checkId: 'test', extraction })],
      });
      const result = resolve(
        {
          kind: 'validation.assertion_passed',
          checkId: 'test',
          assertion: { providerId: 'vitest', localId: 'auth.spec.ts::rejects-invalid-token' },
        },
        state,
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.attemptId).toBe(TEST_ATTEMPT_ID);
    });

    it('review.human_approval_decision verifies exactly-one matching decision receipt', () => {
      const state = baseState();
      const events = makeDecisionTrail({
        flowguardSessionId: state.flowguardSessionId,
        gatePhase: 'EVIDENCE_REVIEW',
        verdict: 'approve',
      });
      const result = resolve(
        {
          kind: 'review.human_approval_decision',
          gatePhase: 'EVIDENCE_REVIEW',
          acceptedVerdicts: ['approve', 'approve_with_governance_override'],
          minActorAssurance: 'best_effort',
        },
        state,
        contextFor(state, events),
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.decisionId).toBe('decision-1');
    });

    it('risk.triggers_covered verifies a certificate-authorized critical claim', () => {
      const declared = baseState({
        plan: {
          ...baseState().plan!,
          claimDeclarations: {
            flow: 'plan',
            version: 'v2',
            claims: [
              {
                claimId: CLAIM_ID,
                statement: 'Audit authority is preserved by the change',
                critical: true,
                authoritySectionId: 'security',
                claimScope: 'specific_behavior',
                expectedCheckId: 'test',
                coversRiskTriggers: ['audit_authority'],
              },
            ],
          },
        },
        implementationRiskAssessment: {
          ...CURRENT_IMPL_RISK_ASSESSMENT,
          riskTriggers: ['audit_authority'],
        },
      });
      const state = withPlanCertificate(declared);
      const result = resolve(
        { kind: 'risk.triggers_covered', triggers: ['audit_authority'] },
        state,
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
    });

    it('policy.snapshot verifies the frozen policy digest', () => {
      const state = baseState();
      const result = resolve({ kind: 'policy.snapshot' }, state);
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.policyHash).toBe(state.policySnapshot.hash);
    });

    it('audit.chain_anchor verifies a chain matching the manifest anchor', () => {
      const state = baseState();
      const events = makeDecisionTrail({
        flowguardSessionId: state.flowguardSessionId,
        gatePhase: 'EVIDENCE_REVIEW',
        verdict: 'approve',
      });
      const result = resolve({ kind: 'audit.chain_anchor' }, state, contextFor(state, events));
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
    });

    it('export.completion verifies the live binding and is marked as live evidence', () => {
      const state = baseState();
      const result = resolve({ kind: 'export.completion' }, state, contextFor(state));
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence.map((ref) => ref.source)).toEqual(['live_state', 'live_audit']);
    });
  });

  describe('BAD — absent, skipped, failed, stale or unbound evidence never verifies', () => {
    it('plan.approved reports a missing certificate and a non-current certificate distinctly', () => {
      const state = baseState();
      const withoutCertificate = makeIsoState({
        plan: { ...state.plan!, approvalCertificate: undefined },
      });
      expect(resolve({ kind: 'plan.approved' }, withoutCertificate).findings[0]?.code).toBe(
        'APPROVAL_CERTIFICATE_MISSING',
      );

      const stalePlan = {
        ...state.plan!,
        current: { ...state.plan!.current, digest: 'other-plan-digest' },
      };
      const stale = makeIsoState({ plan: stalePlan });
      expect(resolve({ kind: 'plan.approved' }, stale).findings[0]?.code).toBe(
        'APPROVAL_CERTIFICATE_NOT_CURRENT',
      );
    });

    it('plan.approver_identity fails closed on policy_auto, unknown actors and low assurance', () => {
      const autoState = makeIsoState({
        policySnapshot: {
          ...makeIsoState().policySnapshot,
          requireHumanGates: false,
          effectiveGateBehavior: 'auto_approve',
        },
      });
      const policyAuto = withPlanCertificate(autoState, { kind: 'policy_auto' });
      expect(
        resolve({ kind: 'plan.approver_identity', minActorAssurance: 'best_effort' }, policyAuto)
          .findings[0]?.code,
      ).toBe('APPROVER_IDENTITY_POLICY_AUTO');

      const state = baseState();
      const unknownActor = withPlanCertificate(state, {
        decision: {
          ...state.reviewDecision!,
          decisionIdentity: { ...state.reviewDecision!.decisionIdentity, actorSource: 'unknown' },
        },
      });
      expect(
        resolve({ kind: 'plan.approver_identity', minActorAssurance: 'best_effort' }, unknownActor)
          .findings[0]?.code,
      ).toBe('APPROVER_IDENTITY_UNRESOLVED');

      expect(
        resolve({ kind: 'plan.approver_identity', minActorAssurance: 'idp_verified' }, state)
          .findings[0]?.code,
      ).toBe('APPROVER_ASSURANCE_BELOW_MINIMUM');
    });

    it('validation.check_supported distinguishes missing, failed and technical blocks', () => {
      const state = baseState();
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'lint' }, state).findings[0]?.code,
      ).toBe('CHECK_ATTEMPT_MISSING');

      const failed = baseState({
        validationAttempts: [makeImplementationAttempt({ passed: false, outcome: 'inconclusive' })],
      });
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'test' }, failed).findings[0]?.code,
      ).toBe('CHECK_FAILED');

      const blocked = baseState({
        validationAttempts: [
          makeImplementationAttempt({ passed: false, outcome: 'blocked', timedOut: true }),
        ],
      });
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'test' }, blocked).findings[0]?.code,
      ).toBe('CHECK_TECHNICAL_BLOCK');

      const inconclusive = baseState({
        validationAttempts: [makeImplementationAttempt({ passed: true, outcome: 'inconclusive' })],
      });
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'test' }, inconclusive).findings[0]
          ?.code,
      ).toBe('CHECK_FAILED');

      const stale = baseState({
        validationAttempts: [
          makeImplementationAttempt({ implementationDigest: 'other-implementation-digest' }),
        ],
      });
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'test' }, stale).findings[0]?.code,
      ).toBe('CHECK_ATTEMPT_MISSING');
    });

    it('a later failed attempt shadows an earlier supported attempt (fail-closed latest)', () => {
      const state = baseState({
        validationAttempts: [
          makeImplementationAttempt({ attemptId: '00000000-0000-4000-8000-000000000101' }),
          makeImplementationAttempt({
            attemptId: '00000000-0000-4000-8000-000000000102',
            passed: false,
            outcome: 'inconclusive',
          }),
        ],
      });
      expect(
        resolve({ kind: 'validation.check_supported', checkId: 'test' }, state).findings[0]?.code,
      ).toBe('CHECK_FAILED');
    });

    it('validation.assertion_passed rejects skipped, failed, unreported and unbound assertions', () => {
      const assertion = { providerId: 'vitest', localId: 'auth.spec.ts::x' };
      const withStatus = (status: 'passed' | 'failed' | 'errored' | 'skipped') =>
        baseState({
          validationAttempts: [
            makeImplementationAttempt({
              extraction: makeAssertionExtraction({
                attemptId: TEST_ATTEMPT_ID,
                localId: assertion.localId,
                status,
              }),
            }),
          ],
        });

      expect(
        resolve(
          { kind: 'validation.assertion_passed', checkId: 'test', assertion },
          withStatus('skipped'),
        ).findings[0]?.code,
      ).toBe('ASSERTION_SKIPPED');
      expect(
        resolve(
          { kind: 'validation.assertion_passed', checkId: 'test', assertion },
          withStatus('failed'),
        ).findings[0]?.code,
      ).toBe('ASSERTION_FAILED');

      const otherAssertion = baseState({
        validationAttempts: [
          makeImplementationAttempt({
            extraction: makeAssertionExtraction({
              attemptId: TEST_ATTEMPT_ID,
              localId: 'other.spec.ts::y',
              status: 'passed',
            }),
          }),
        ],
      });
      expect(
        resolve({ kind: 'validation.assertion_passed', checkId: 'test', assertion }, otherAssertion)
          .findings[0]?.code,
      ).toBe('ASSERTION_NOT_REPORTED');

      const withoutExtraction = baseState({
        validationAttempts: [makeImplementationAttempt({})],
      });
      expect(
        resolve(
          { kind: 'validation.assertion_passed', checkId: 'test', assertion },
          withoutExtraction,
        ).findings[0]?.code,
      ).toBe('ASSERTION_EXTRACTION_NOT_CONFIGURED');

      const mismatchedAttempt = baseState({
        validationAttempts: [
          makeImplementationAttempt({
            extraction: {
              ...makeAssertionExtraction({
                attemptId: TEST_ATTEMPT_ID,
                localId: assertion.localId,
                status: 'passed',
              }),
              attemptId: '00000000-0000-4000-8000-000000000103',
            },
          }),
        ],
      });
      expect(
        resolve(
          { kind: 'validation.assertion_passed', checkId: 'test', assertion },
          mismatchedAttempt,
        ).findings[0]?.code,
      ).toBe('ASSERTION_ATTEMPT_MISMATCH');
    });

    it('review.implementation_verdict requires digest-bound accepted findings', () => {
      const selector: EvidenceSelector = {
        kind: 'review.implementation_verdict',
        acceptedVerdicts: ['accept'],
      };
      const noFindings = baseState();
      expect(resolve(selector, noFindings).status).toBe('EVIDENCE_PRESENT_UNVERIFIED');
      expect(resolve(selector, noFindings).findings[0]?.code).toBe(
        'IMPLEMENTATION_REVIEW_FINDINGS_MISSING',
      );

      const unbound = makeBoundImplFindings(IMPL_EVIDENCE.digest);
      const unboundState = baseState({
        implReviewFindings: [unbound.findings],
        reviewAssurance: { ...unbound.assurance, attempts: [] },
      });
      expect(resolve(selector, unboundState).findings[0]?.code).toBe(
        'IMPLEMENTATION_REVIEW_BINDING_UNVERIFIED',
      );

      const stale = baseState({
        implReview: { ...makeIsoState().implReview!, currDigest: 'other-digest' },
      });
      expect(resolve(selector, stale).findings[0]?.code).toBe('IMPLEMENTATION_REVISION_STALE');

      const waived = baseState({
        implReview: null,
        reducedCeremony: makeIsoState().reducedCeremony ?? {
          profile: 'reduced',
          reason: 'fixture',
          effectiveTaskClass: 'TRIVIAL',
          computedMinimumTaskClass: 'TRIVIAL',
          declaredTaskClass: null,
          declarationKind: 'absent',
          ticketDigest: null,
          touchedSurfaces: [],
          implementationId: IMPL_EVIDENCE.implementationId,
          implementationDigest: IMPL_EVIDENCE.digest,
          policyDigest: 'a'.repeat(64),
          verificationBasis: { checkIds: [], attempts: [] },
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(resolve(selector, waived).findings[0]?.code).toBe(
        'IMPLEMENTATION_REVIEW_WAIVED_BY_POLICY',
      );
    });

    it('review.human_approval_decision fails closed without/with ambiguous receipts', () => {
      const state = baseState();
      const selector: EvidenceSelector = {
        kind: 'review.human_approval_decision',
        gatePhase: 'EVIDENCE_REVIEW',
        acceptedVerdicts: ['approve'],
        minActorAssurance: 'best_effort',
      };
      expect(resolve(selector, state, contextFor(state, [])).findings[0]?.code).toBe(
        'DECISION_RECEIPT_MISSING',
      );

      const duplicate = [
        ...makeDecisionTrail({
          flowguardSessionId: state.flowguardSessionId,
          gatePhase: 'EVIDENCE_REVIEW',
          verdict: 'approve',
        }),
        ...makeDecisionTrail({
          flowguardSessionId: state.flowguardSessionId,
          gatePhase: 'EVIDENCE_REVIEW',
          verdict: 'approve',
          decisionId: 'decision-2',
        }),
      ];
      expect(resolve(selector, state, contextFor(state, duplicate)).findings[0]?.code).toBe(
        'DECISION_RECEIPT_AMBIGUOUS',
      );

      const wrongActor = makeDecisionTrail({
        flowguardSessionId: state.flowguardSessionId,
        gatePhase: 'EVIDENCE_REVIEW',
        verdict: 'approve',
        actorId: 'someone-else',
      });
      expect(resolve(selector, state, contextFor(state, wrongActor)).findings[0]?.code).toBe(
        'DECISION_RECEIPT_MISSING',
      );

      const belowAssurance = resolve(
        { ...selector, minActorAssurance: 'idp_verified' },
        state,
        contextFor(
          state,
          makeDecisionTrail({
            flowguardSessionId: state.flowguardSessionId,
            gatePhase: 'EVIDENCE_REVIEW',
            verdict: 'approve',
          }),
        ),
      );
      expect(belowAssurance.findings[0]?.code).toBe('APPROVAL_ASSURANCE_BELOW_MINIMUM');
    });

    it('risk.triggers_covered reports uncovered triggers and unbound assessments', () => {
      const declared = baseState({
        plan: {
          ...baseState().plan!,
          approvalCertificate: undefined,
          claimDeclarations: {
            flow: 'plan',
            version: 'v2',
            claims: [
              {
                claimId: CLAIM_ID,
                statement: 'Policy authority is preserved by the change',
                critical: true,
                authoritySectionId: 'security',
                claimScope: 'specific_behavior',
                expectedCheckId: 'test',
                coversRiskTriggers: ['policy_authority'],
              },
            ],
          },
        },
        implementationRiskAssessment: {
          ...CURRENT_IMPL_RISK_ASSESSMENT,
          riskTriggers: ['audit_authority'],
        },
      });
      const certificateMissing = resolve(
        { kind: 'risk.triggers_covered', triggers: ['audit_authority'] },
        declared,
      );
      expect(certificateMissing.status).toBe('NOT_VERIFIED');
      expect(certificateMissing.findings[0]?.code).toBe('APPROVAL_CERTIFICATE_MISSING');

      const covered = resolve(
        { kind: 'risk.triggers_covered', triggers: ['audit_authority'] },
        withPlanCertificate(declared),
      );
      expect(covered.status).toBe('EVIDENCE_MISSING');
      expect(covered.findings[0]?.code).toBe('RISK_TRIGGER_UNCOVERED');

      const unbound = baseState({
        implementationRiskAssessment: {
          ...CURRENT_IMPL_RISK_ASSESSMENT,
          implementationDigest: 'other-digest',
        },
      });
      expect(
        resolve({ kind: 'risk.triggers_covered', triggers: ['audit_authority'] }, unbound)
          .findings[0]?.code,
      ).toBe('RISK_ASSESSMENT_NOT_BOUND');
    });

    it('policy.snapshot rejects an unexpected policy mode', () => {
      const state = baseState();
      const result = resolve({ kind: 'policy.snapshot', expectedMode: 'regulated' }, state);
      expect(result.status).toBe('EVIDENCE_MISSING');
      expect(result.findings[0]?.code).toBe('POLICY_MODE_MISMATCH');
    });

    it('audit.chain_anchor rejects an anchor that does not match the manifest', () => {
      const state = baseState();
      const snapshot = makeVerifiedSnapshot(state, []);
      const tampered = { ...snapshot, auditEventCount: snapshot.auditEventCount + 1 };
      const context = makeSelectorContext(tampered);
      expect(resolveSelector({ kind: 'audit.chain_anchor' }, context).status).toBe('NOT_VERIFIED');
    });

    it('export.completion fails closed on unavailable, missing or mismatched live bindings', () => {
      const state = baseState();
      const unavailable = resolve(
        { kind: 'export.completion' },
        state,
        contextFor(state, [], {
          stateAvailable: false,
          exportCompletionPackageDigest: null,
          exportMaterializedEvent: false,
        }),
      );
      expect(unavailable.findings[0]?.code).toBe('LIVE_STATE_UNAVAILABLE');

      const missing = resolve(
        { kind: 'export.completion' },
        state,
        contextFor(state, [], {
          stateAvailable: true,
          exportCompletionPackageDigest: null,
          exportMaterializedEvent: true,
        }),
      );
      expect(missing.findings[0]?.code).toBe('EXPORT_COMPLETION_EVIDENCE_MISSING');

      const mismatch = resolve(
        { kind: 'export.completion' },
        state,
        contextFor(state, [], {
          stateAvailable: true,
          exportCompletionPackageDigest: 'b'.repeat(64),
          exportMaterializedEvent: true,
        }),
      );
      expect(mismatch.findings[0]?.code).toBe('EXPORT_PACKAGE_DIGEST_MISMATCH');
    });
  });

  describe('CORNER — diff member and implementation binding edge cases', () => {
    it('implementation.revision requires the declared diff member in the manifest', () => {
      const state = baseState({
        implementation: { ...IMPL_EVIDENCE, diffDigest: 'f'.repeat(64) },
        implReview: { ...makeIsoState().implReview!, currDigest: IMPL_EVIDENCE.digest },
      });
      const result = resolve({ kind: 'implementation.revision' }, state);
      expect(result.status).toBe('NOT_VERIFIED');
      expect(result.findings[0]?.code).toBe('IMPLEMENTATION_DIFF_MEMBER_MISSING');
    });

    it('implementation.revision binds the diff member when present', () => {
      const diffDigest = 'f'.repeat(64);
      const state = baseState({
        implementation: { ...IMPL_EVIDENCE, diffDigest },
        implReview: { ...makeIsoState().implReview!, currDigest: IMPL_EVIDENCE.digest },
      });
      const snapshot = makeVerifiedSnapshot(state, []);
      const withDiff = {
        ...snapshot,
        fileDigests: {
          ...snapshot.fileDigests,
          [`implementation/implementation-diff.${diffDigest}.patch`]: diffDigest,
        },
      };
      const result = resolveSelector(
        { kind: 'implementation.revision' },
        makeSelectorContext(withDiff),
      );
      expect(result.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(result.evidence[0]?.member).toContain('implementation-diff');
    });
  });

  describe('EDGE — verified aggregates stay bounded to their declared scope', () => {
    it('implementation.revision is NOT_VERIFIED without a review binding', () => {
      const state = baseState({ implReview: null, reducedCeremony: null });
      const result = resolve({ kind: 'implementation.revision' }, state);
      expect(result.status).toBe('NOT_VERIFIED');
      expect(result.findings[0]?.code).toBe('IMPLEMENTATION_REVIEW_ABSENT');
    });

    it('plan.approved is MISSING without a plan', () => {
      const state = baseState({ plan: null });
      expect(resolve({ kind: 'plan.approved' }, state).findings[0]?.code).toBe('PLAN_ABSENT');
    });

    it('a verified selector never receives live-binding evidence', () => {
      const state = baseState();
      const result = resolve({ kind: 'policy.snapshot' }, state, contextFor(state));
      expect(result.evidence.every((ref) => !ref.source.startsWith('live_'))).toBe(true);
      expect(result.evidence[0]?.exportedPackageSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('organization-namespaced controls do not affect Annex A rules', () => {
      const state = baseState();
      const result = resolve({ kind: 'implementation.revision' }, state);
      expect(result.evidence[0]?.flowguardSessionId).toBe(state.flowguardSessionId);
      expect(result.evidence[0]?.sessionId).toBe(state.binding.hostSessionId);
    });
  });
});
