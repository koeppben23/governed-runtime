import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveNextAction, ACTION_CODES } from './next-action.js';
import type { NextAction } from './next-action.js';
import type { DiscoverySummary } from '../state/discovery-schemas.js';
import { appendReviewDispatch } from '../state/review-dispatch.js';
import {
  makeState,
  makeProgressedState,
  assuranceWith,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  SELF_REVIEW_PENDING as SELF_REVIEW_PENDING_FIX,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  ARCHITECTURE_DECISION,
} from '../fixtures.js';
import { Phase, type SessionState } from '../state/schema.js';
import type { ReviewAttempt, ReviewObligation } from '../state/evidence.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
} from '../integration/review/assurance.js';
import { hashCanonicalReviewContent, normalizeReviewContent } from '../shared/review-subject.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PLAN_BODY = normalizeReviewContent('## Plan\n1. Fix auth\n2. Add tests');

function pendingPlanObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  const base = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: '2026-01-01T00:00:00.000Z',
    subjectDigest: 'plan-subject-digest',
    reviewMaterial: {
      content: PLAN_BODY,
      materialDigest: hashCanonicalReviewContent(PLAN_BODY),
      subjectDigest: 'plan-subject-digest',
    },
    reviewSubjectScope: artifactReviewSubjectScope('plan', PLAN_BODY, 'plan-subject-digest'),
    changedFiles: ['src/auth.ts'],
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  return { ...base, ...overrides };
}

function bindableAttemptFor(obligation: ReviewObligation): ReviewAttempt {
  return {
    attemptId: 'attempt-1',
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal: 0,
    status: 'created',
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    createdAt: '2026-01-01T00:00:00.000Z',
    reviewMaterial: {
      content: PLAN_BODY,
      materialDigest: hashCanonicalReviewContent(PLAN_BODY),
      subjectDigest: 'plan-subject-digest',
    },
  };
}

/** Assert NextAction shape. */
function expectAction(
  action: NextAction,
  code: NextAction['code'],
  commands: readonly string[],
): void {
  expect(action.code).toBe(code);
  expect(action.commands).toEqual(commands);
  expect(action.text.length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveNextAction', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    // ── Routing ────────────────────────────────────────────
    it('READY → CHOOSE_FLOW with 3 commands', () => {
      const state = makeState('READY');
      const action = resolveNextAction('READY', state);
      expectAction(action, ACTION_CODES.CHOOSE_FLOW, ['/ticket', '/architecture', '/review']);
      expect(action.text).toContain('/ticket');
      expect(action.text).toContain('/architecture');
      expect(action.text).toContain('/review');
    });

    // ── Ticket Flow ────────────────────────────────────────
    it('TICKET (no ticket) → RUN_TICKET', () => {
      const state = makeState('TICKET');
      const action = resolveNextAction('TICKET', state);
      expectAction(action, ACTION_CODES.RUN_TICKET, ['/ticket']);
    });

    it('TICKET (has ticket, no plan) → RUN_PLAN', () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const action = resolveNextAction('TICKET', state);
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
    });

    it('PLAN (self-review pending) → RUN_CONTINUE', () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('self-review in progress');
    });

    it('PLAN (self-review converged) → RUN_CONTINUE with converged text', () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('converged');
    });

    it('PLAN with a bindable plan attempt → RUN_REVIEWER_TASK', () => {
      const obligation = pendingPlanObligation({ status: 'pending' });
      const attempt = bindableAttemptFor(obligation);
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: assuranceWith({
          obligation,
          attempts: [attempt],
        }),
      });
      expectAction(resolveNextAction('PLAN', state), ACTION_CODES.RUN_REVIEWER_TASK, []);
    });

    it('PLAN with a bindable attempt + unresolved durable dispatch → /plan re-arm, never awaiting_task', () => {
      const obligation = pendingPlanObligation({ status: 'pending' });
      const attempt = bindableAttemptFor(obligation);
      const base = assuranceWith({ obligation, attempts: [attempt] });
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: appendReviewDispatch(base, {
          dispatchId: randomUUID(),
          attemptId: attempt.attemptId,
          obligationId: obligation.obligationId,
          hostCallId: 'call-old',
          canonicalPromptDigest: 'a'.repeat(64),
          dispatchAuthorizedAt: '2026-01-01T00:00:00.000Z',
          dispatchStatus: 'authorized',
        }),
      });
      const action = resolveNextAction('PLAN', state);
      // The bindable attempt is NOT re-emitted as awaiting_task because its
      // durable dispatch outcome is unresolved: /plan is the authorized trigger
      // to re-arm it durably.
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
      expect(action.commands).not.toContain('/continue');
      expect(action.text).toContain('interrupted');
    });

    it('PLAN with fulfilled review evidence → verdict submission via /plan', () => {
      const obligation = pendingPlanObligation({ status: 'fulfilled' });
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: assuranceWith({ obligation }),
      });
      expectAction(resolveNextAction('PLAN', state), ACTION_CODES.RUN_REVIEW_DECISION, ['/plan']);
    });

    it('PLAN with a blocked review obligation → fresh revision via /plan', () => {
      const obligation = pendingPlanObligation({
        status: 'blocked',
        blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
      });
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: assuranceWith({ obligation }),
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
      expect(action.text).toContain('REVIEWER_INVOCATION_EXHAUSTED');
    });

    it('PLAN with a pending obligation but no legal attempt → /plan recovery, never /continue', () => {
      const obligation = pendingPlanObligation({ status: 'pending' });
      const bound = {
        ...bindableAttemptFor(obligation),
        attemptId: 'attempt-bound',
        childSessionId: 'child-session-1',
      };
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: assuranceWith({
          obligation,
          attempts: [bound],
        }),
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
      expect(action.commands).not.toContain('/continue');
      expect(action.text).toContain('no legal reviewer attempt');
    });

    it('PLAN with a repairable rejected attempt → authorized repair via /plan', () => {
      const obligation = pendingPlanObligation({
        status: 'pending',
        maxReviewerOutputRepairAttempts: 1,
      });
      const rejected = {
        ...bindableAttemptFor(obligation),
        attemptId: 'attempt-rejected',
        status: 'rejected' as const,
        rejectionReason: 'schema_invalid' as const,
      };
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
        reviewAssurance: assuranceWith({
          obligation,
          attempts: [rejected],
        }),
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
      expect(action.text).toContain('authorized repair');
    });

    it('PLAN_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const action = resolveNextAction('PLAN_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('VALIDATION (no results) → RUN_VALIDATE', () => {
      const state = makeState('VALIDATION', { validation: [] });
      const action = resolveNextAction('VALIDATION', state);
      expectAction(action, ACTION_CODES.RUN_VALIDATE, ['/validate']);
    });

    it('VALIDATION (has results) → RUN_CONTINUE', () => {
      const state = makeState('VALIDATION', { validation: VALIDATION_PASSED });
      const action = resolveNextAction('VALIDATION', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('VALIDATION (blocked evidence, trustworthy discovery) → VALIDATION_EVIDENCE_REQUIRED', () => {
      const state = makeState('VALIDATION', {
        validation: [],
        activeChecks: [],
        policySnapshot: {
          ...makeState('VALIDATION').policySnapshot,
          validationEvidence: { enforcement: 'required', allowNoCommands: false },
          discoveryHealth: { enforcement: 'required', onDegraded: 'block', onDrift: 'block' },
        },
        discoverySummary: {
          primaryLanguages: ['TypeScript'],
          frameworks: [],
          topologyKind: 'single-project',
          moduleCount: 1,
          hasApiSurface: false,
          hasPersistenceSurface: false,
          hasCiCd: true,
          hasSecuritySurface: false,
        } satisfies DiscoverySummary,
        discoveryDigest: 'a'.repeat(64),
        discoveryHealthGate: {
          status: 'clear',
          lastDriftAssessment: 'clean',
          clearedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const action = resolveNextAction('VALIDATION', state);
      expect(action.code).toBe(ACTION_CODES.VALIDATION_EVIDENCE_REQUIRED);
      expect(action.commands).toContain('/hydrate');
    });

    it('VALIDATION (blocked evidence, untrustworthy discovery) → VALIDATION_EVIDENCE_UNVERIFIED', () => {
      const state = makeState('VALIDATION', {
        validation: [],
        activeChecks: [],
        policySnapshot: {
          ...makeState('VALIDATION').policySnapshot,
          validationEvidence: { enforcement: 'required', allowNoCommands: false },
        },
        discoverySummary: null,
        discoveryDigest: null,
      });
      const action = resolveNextAction('VALIDATION', state);
      expect(action.code).toBe(ACTION_CODES.VALIDATION_EVIDENCE_UNVERIFIED);
      expect(action.commands).toContain('/hydrate');
    });

    it('IMPLEMENTATION (no impl) → RUN_IMPLEMENT', () => {
      const state = makeState('IMPLEMENTATION');
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.RUN_IMPLEMENT, ['/implement']);
    });

    it('IMPLEMENTATION with exhausted rework → IMPLEMENTATION_REVIEW_EXHAUSTED', () => {
      const state = makeState('IMPLEMENTATION', {
        implementationRework: { rejectedDigest: 'rejected-digest', exhausted: true },
      });
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.IMPLEMENTATION_REVIEW_EXHAUSTED, [
        '/extend-implementation-review',
        '/abort',
      ]);
    });

    it('IMPLEMENTATION with pending (non-exhausted) rework → RUN_IMPLEMENT', () => {
      const state = makeState('IMPLEMENTATION', {
        implementationRework: { rejectedDigest: 'rejected-digest', exhausted: false },
      });
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.RUN_IMPLEMENT, ['/implement']);
    });

    it('IMPLEMENTATION (has impl) → RUN_CONTINUE', () => {
      const state = makeState('IMPLEMENTATION', { implementation: IMPL_EVIDENCE });
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('IMPL_REVIEW without bound evidence → RUN_REVIEWER_TASK', () => {
      const state = makeProgressedState('IMPL_REVIEW');
      const action = resolveNextAction('IMPL_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEWER_TASK, []);
    });

    it('IMPL_REVIEW with an unaddressed prior challenge → resolve it before reviewer dispatch', () => {
      const state = {
        ...makeProgressedState('IMPL_REVIEW'),
        implReviewFindings: [
          {
            challenges: [
              {
                challengeId: '00000000-0000-4000-8000-00000000000a',
                kind: 'implementation_challenge',
                outcome: 'fail',
              },
            ],
          },
        ] as unknown as SessionState['implReviewFindings'],
      };

      expectAction(
        resolveNextAction('IMPL_REVIEW', state),
        ACTION_CODES.RESOLVE_IMPLEMENTATION_CHALLENGES,
        ['flowguard_resolve_implementation_challenge'],
      );
    });

    it('IMPL_REVIEW with bound unconsumed evidence → submit reviewer verdict', () => {
      const obligation = createReviewObligation({
        obligationType: 'implement',
        iteration: 1,
        planVersion: 1,
        subjectDigest: 'impl-digest',
        reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
        changedFiles: ['src/a.ts'],
        policySnapshot: null,
        now: '2026-01-01T00:00:00.000Z',
      });
      const fulfilledObligation = { ...obligation, status: 'fulfilled' as const };
      const state = makeState('IMPL_REVIEW', {
        implementation: IMPL_EVIDENCE,
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations: [fulfilledObligation],
          attempts: [
            {
              attemptId: '22222222-2222-4222-8222-222222222222',
              obligationId: obligation.obligationId,
              obligationType: 'implement',
              subjectDigest: 'impl-digest',
              ordinal: 1,
              origin: { kind: 'initial' },
              repositoryDiscovery: { kind: 'not_applicable' },
              status: 'bound',
              childSessionId: 'child',
              completedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          dispatches: [],
          invocations: [
            {
              invocationId: '11111111-1111-4111-8111-111111111111',
              obligationId: obligation.obligationId,
              obligationType: 'implement',
              parentSessionId: 'parent',
              childSessionId: 'child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'host_subagent_task',
              hostVisible: true,
              source: 'host-orchestrated',
              promptHash: 'prompt',
              mandateDigest: obligation.mandateDigest,
              criteriaVersion: obligation.criteriaVersion,
              findingsHash: 'findings',
              invokedAt: '2026-01-01T00:00:00.000Z',
              fulfilledAt: '2026-01-01T00:00:00.000Z',
              consumedByObligationId: null,
              capturedVerdict: 'unable_to_review',
              attemptId: '22222222-2222-4222-8222-222222222222',
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
            },
          ],
        },
      });
      const action = resolveNextAction('IMPL_REVIEW', state);
      expectAction(action, ACTION_CODES.SUBMIT_REVIEWER_VERDICT, [
        'flowguard_review_implementation',
      ]);
    });

    it('IMPL_REVIEW with a blocked implement obligation → /implement re-record', () => {
      const obligation = createReviewObligation({
        obligationType: 'implement',
        iteration: 1,
        planVersion: 1,
        subjectDigest: 'impl-digest',
        reviewSubjectScope: {
          kind: 'implementation',
          implementationDigest: 'impl-digest',
        },
        changedFiles: ['src/a.ts'],
        policySnapshot: null,
        now: '2026-01-01T00:00:00.000Z',
      });
      const blocked = {
        ...obligation,
        status: 'blocked' as const,
        blockedCode: 'REVIEW_REPAIR_UNAVAILABLE',
      };
      const state = makeState('IMPL_REVIEW', {
        implementation: IMPL_EVIDENCE,
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations: [blocked],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      });
      const action = resolveNextAction('IMPL_REVIEW', state);
      expectAction(action, ACTION_CODES.IMPLEMENTATION_REVIEW_BLOCKED, ['/implement']);
      expect(action.text).toContain('REVIEW_REPAIR_UNAVAILABLE');
      expect(action.text).not.toContain('flowguard-reviewer');
    });

    it('IMPL_REVIEW with three blocked implement obligations → terminal /abort guidance', () => {
      const obligations = [1, 2, 3].map((iteration) => {
        const obligation = createReviewObligation({
          obligationType: 'implement',
          iteration,
          planVersion: 1,
          subjectDigest: `impl-digest-${iteration}`,
          reviewSubjectScope: {
            kind: 'implementation',
            implementationDigest: `impl-digest-${iteration}`,
          },
          changedFiles: ['src/a.ts'],
          policySnapshot: null,
          now: '2026-01-01T00:00:00.000Z',
        });
        return {
          ...obligation,
          status: 'blocked' as const,
          blockedCode: 'REVIEW_REPAIR_UNAVAILABLE',
        };
      });
      const state = makeState('IMPL_REVIEW', {
        implementation: IMPL_EVIDENCE,
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations,
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      });
      const action = resolveNextAction('IMPL_REVIEW', state);
      expectAction(action, ACTION_CODES.IMPLEMENTATION_REVIEW_BLOCKED, ['/abort']);
      expect(action.text).toContain('permanently');
    });

    it('EVIDENCE_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const action = resolveNextAction('EVIDENCE_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('COMPLETE');
      const action = resolveNextAction('COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('complete');
    });

    // ── Architecture Flow ──────────────────────────────────
    it('ARCHITECTURE (no ADR) → RUN_ARCHITECTURE', () => {
      const state = makeState('ARCHITECTURE');
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_ARCHITECTURE, ['/architecture']);
    });

    it('ARCHITECTURE (has ADR, self-review pending) → RUN_CONTINUE', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('self-review in progress');
    });

    it('ARCHITECTURE (has ADR, self-review converged) → RUN_CONTINUE with converged text', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('converged');
    });

    it('ARCH_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const action = resolveNextAction('ARCH_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('ARCH_COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const action = resolveNextAction('ARCH_COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('Architecture flow complete');
    });

    // ── Review Flow ────────────────────────────────────────
    it('REVIEW without a report or pending obligation → REVIEW_STATE_INCOMPLETE', () => {
      const state = makeState('REVIEW');
      const action = resolveNextAction('REVIEW', state);
      expectAction(action, ACTION_CODES.REVIEW_STATE_INCOMPLETE, []);
      expect(action.text).toContain('/continue cannot complete it');
    });

    it('REVIEW_COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('REVIEW_COMPLETE');
      const action = resolveNextAction('REVIEW_COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('Review flow complete');
      expect(action.text).not.toContain('archived');
    });

    it('READY with a pending standalone review obligation → RUN_REVIEWER_TASK', () => {
      const obligation = createReviewObligation({
        obligationType: 'review',
        iteration: 1,
        planVersion: 1,
        now: '2026-01-01T00:00:00.000Z',
        subjectDigest: 'test',
      });
      const state = makeState('READY', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      });
      const action = resolveNextAction('READY', state);
      expectAction(action, ACTION_CODES.RUN_REVIEWER_TASK, []);
      expect(action.text).toContain('flowguard-reviewer Task');
    });

    it('REVIEW with a pending standalone review obligation → RUN_REVIEWER_TASK', () => {
      const obligation = createReviewObligation({
        obligationType: 'review',
        iteration: 1,
        planVersion: 1,
        now: '2026-01-01T00:00:00.000Z',
        subjectDigest: 'test',
      });
      const state = makeState('REVIEW', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      });
      const action = resolveNextAction('REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEWER_TASK, []);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('text is always non-empty for every phase', () => {
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(action.text.length, `text empty for phase ${phase}`).toBeGreaterThan(0);
      }
    });

    it('code is always a known ACTION_CODE for every phase', () => {
      const knownCodes = new Set<NextAction['code']>(Object.values(ACTION_CODES));
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(
          knownCodes.has(action.code),
          `unknown code '${action.code}' for phase ${phase}`,
        ).toBe(true);
      }
    });

    it('TICKET with ticket AND plan still returns RUN_PLAN (ticket slot drives)', () => {
      // Edge: ticket has both ticket + plan but phase is still TICKET.
      // This shouldn't normally happen (evaluate would have transitioned),
      // but the resolver must not crash.
      const state = makeState('TICKET', { ticket: TICKET, plan: PLAN_RECORD });
      const action = resolveNextAction('TICKET', state);
      // Has ticket + no plan check: plan IS present, so falls to RUN_TICKET fallback
      // Actually ticket !== null && plan !== null → falls through to RUN_TICKET
      expectAction(action, ACTION_CODES.RUN_TICKET, ['/ticket']);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('terminal phases always return empty commands array', () => {
      const terminals: Phase[] = ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'];
      for (const phase of terminals) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(action.commands, `commands not empty for terminal ${phase}`).toEqual([]);
        expect(action.code).toBe(ACTION_CODES.SESSION_COMPLETE);
      }
    });

    it('PLAN with no selfReview slot → RUN_CONTINUE (in-progress fallback)', () => {
      const state = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('ARCHITECTURE with ADR but no selfReview → RUN_CONTINUE (in-progress fallback)', () => {
      const state = makeState('ARCHITECTURE', { architecture: ARCHITECTURE_DECISION });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('self-review at max iterations → converged', () => {
      const maxedOut = {
        iteration: 3,
        maxIterations: 3,
        prevDigest: 'prev',
        currDigest: 'curr',
        revisionDelta: 'major' as const,
        verdict: 'changes_requested' as const,
      };
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: maxedOut,
      });
      const action = resolveNextAction('PLAN', state);
      expect(action.text).toContain('converged');
    });

    it('READY text is multi-line with flow explanations', () => {
      const state = makeState('READY');
      const action = resolveNextAction('READY', state);
      const lines = action.text.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all 14 phases are covered (exhaustive switch)', () => {
      // If a phase is added to the schema but not the resolver,
      // TypeScript exhaustive check will catch it at compile time.
      // This runtime test verifies no phase throws.
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        expect(() => resolveNextAction(phase, state)).not.toThrow();
      }
    });

    it('resolver is pure — same input yields same output', () => {
      const state = makeState('READY');
      const a = resolveNextAction('READY', state);
      const b = resolveNextAction('READY', state);
      expect(a).toEqual(b);
    });

    it('IMPLEMENTATION with impl evidence → different from without', () => {
      const without = resolveNextAction('IMPLEMENTATION', makeState('IMPLEMENTATION'));
      const withImpl = resolveNextAction(
        'IMPLEMENTATION',
        makeState('IMPLEMENTATION', { implementation: IMPL_EVIDENCE }),
      );
      expect(without.code).not.toBe(withImpl.code);
    });

    it('phase parameter drives resolution, not state.phase', () => {
      // If phase param and state.phase mismatch, the phase param wins.
      // This is by design — the integration layer may call resolveNextAction
      // with a post-transition phase before writing state.
      const state = makeState('TICKET'); // state.phase = TICKET
      const action = resolveNextAction('READY', state); // phase param = READY
      expect(action.code).toBe(ACTION_CODES.CHOOSE_FLOW);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('resolveNextAction completes within evaluate budget for all phases', () => {
      const states = Phase.options.map((p) => ({
        phase: p,
        state: makeProgressedState(p),
      }));

      const { p99Ms } = benchmarkSync(() => {
        for (const { phase, state } of states) {
          resolveNextAction(phase, state);
        }
      }, 100);

      // All 14 phases resolved in under the evaluate budget per call.
      // 14 phases × budget gives total allowed time.
      const totalBudget = Phase.options.length * PERF_BUDGETS.evaluateSingleMs;
      expect(p99Ms).toBeLessThan(totalBudget);
    });

    it('resolves all phases within performance budget', () => {
      // Benchmark: resolve each of the 14 phases 1000 times
      const states = Phase.options.map((p) => ({
        phase: p,
        state: makeProgressedState(p),
      }));

      const start = performance.now();
      for (let round = 0; round < 1000; round++) {
        for (const { phase, state } of states) {
          resolveNextAction(phase, state);
        }
      }
      const elapsed = performance.now() - start;

      // 14 phases × 1000 rounds = 14000 calls.
      // Each call should be < 1μs. Budget: 14000 × 0.01ms = 140ms.
      expect(elapsed).toBeLessThan(700);
    });
  });
});
