/**
 * @module integration/finish-card.test
 * @description Tests for the read-only Finish Card projection (#520).
 *
 * Contract under test:
 *   /finish is a thin, read-only presentation wrapper. buildFinishCard MUST
 *   compose the existing authorities (buildReadinessProjection,
 *   buildEvidenceDetailProjection, resolveNextAction) and add only the single
 *   presentation classifier deriveFinishOverallStatus. It performs NO
 *   independent evidence/gate evaluation, never mutates state, and never
 *   renders an exit option as forbidden.
 *
 * Test strategy:
 * - MATRIX: READY / READY_WITH_WARNINGS / CHANGES_REQUIRED / NOT_VERIFIED / BLOCKED with explicit
 *   precedence (BLOCKED wins over NOT_VERIFIED).
 * - COMPOSITION: card fields equal the underlying projection outputs verbatim.
 * - READ-ONLY: state is not mutated by building the card.
 * - TERMINAL: card is produced in COMPLETE / ARCH_COMPLETE / REVIEW_COMPLETE.
 * - GUARANTEES / EXIT: guarantees are constant; abandon is never forbidden.
 */

import { describe, it, expect } from 'vitest';
import type { SessionState } from '../state/schema.js';
import type { ReviewReport } from '../state/evidence.js';
import {
  buildFinishCard,
  deriveFinishOverallStatus,
  buildReadinessProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
} from './status.js';
import { getPolicyPreset } from '../config/policy.js';
import { resolveNextAction } from '../machine/next-action.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import { makeProgressedState } from '../fixtures.js';

const policy = getPolicyPreset('solo');
const blockedPolicy = getPolicyPreset('team');

function makeReviewReport(overallStatus: ReviewReport['overallStatus']): ReviewReport {
  return {
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'REVIEW_COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    findings: [],
    overallStatus,
    completeness: evaluateCompleteness(makeProgressedState('REVIEW_COMPLETE')),
  };
}

/** COMPLETE terminal state with a legacy selfReview snapshot (produces 1 warning). */
function makeWarningState(): SessionState {
  const base = makeProgressedState('COMPLETE');
  const snap = base.policySnapshot;
  return {
    ...base,
    policySnapshot: {
      ...snap,
      selfReview: {
        ...(snap.selfReview ?? {}),
        subagentEnabled: false,
        fallbackToSelf: true,
        strictEnforcement: false,
      },
    },
  } as SessionState;
}

/** COMPLETE terminal state with a required slot (plan) removed → not blocked, evidence incomplete. */
function makeUnverifiedState(): SessionState {
  return { ...makeProgressedState('COMPLETE'), plan: null };
}

/** Waiting phase with missing evidence → blocked AND evidence incomplete. */
function makeBlockedIncompleteState(): SessionState {
  // PLAN_REVIEW under team/regulated policy blocks (waiting on human decision).
  // But the progressed fixture has complete ticket+plan+self-review evidence.
  // Strip the plan to make evidence incomplete while staying at the gate.
  const state = makeProgressedState('PLAN_REVIEW');
  return { ...state, plan: null };
}

// ─── MATRIX: overall status ─────────────────────────────────────────────────

describe('deriveFinishOverallStatus — overall status matrix', () => {
  it('READY when not blocked, required evidence complete, no warnings', () => {
    const state = makeProgressedState('COMPLETE');
    const card = buildFinishCard(state, policy);
    expect(card.readiness.blocked).toBe(false);
    expect(card.warnings).toHaveLength(0);
    expect(card.overallStatus).toBe('READY');
  });

  it('READY_WITH_WARNINGS when not blocked, evidence complete, warnings present', () => {
    const state = makeWarningState();
    const card = buildFinishCard(state, policy);
    expect(card.readiness.blocked).toBe(false);
    expect(card.warnings.length).toBeGreaterThan(0);
    expect(card.overallStatus).toBe('READY_WITH_WARNINGS');
  });

  it('NOT_VERIFIED when not blocked but a required slot is missing or failed', () => {
    const state = makeUnverifiedState();
    const card = buildFinishCard(state, policy);
    expect(card.readiness.blocked).toBe(false);
    const requiredUnverified = card.evidence.slots.filter(
      (s) => s.required && (s.status === 'missing' || s.status === 'failed'),
    );
    expect(requiredUnverified.length).toBeGreaterThan(0);
    expect(card.overallStatus).toBe('NOT_VERIFIED');
  });

  it('BLOCKED wins over NOT_VERIFIED when blocked AND evidence incomplete', () => {
    const state = makeBlockedIncompleteState();
    const readiness = buildReadinessProjection(state, blockedPolicy);
    const evidence = buildEvidenceDetailProjection(state);
    // Precondition: this fixture is both blocked and has missing required evidence.
    expect(readiness.blocked).toBe(true);
    expect(
      evidence.slots.some((s) => s.required && (s.status === 'missing' || s.status === 'failed')),
    ).toBe(true);
    expect(buildFinishCard(state, blockedPolicy).overallStatus).toBe('BLOCKED');
  });

  it('exposes canonical blocker detail (blocked=true) when BLOCKED', () => {
    const state = makeBlockedIncompleteState();
    const card = buildFinishCard(state, blockedPolicy);
    expect(card.overallStatus).toBe('BLOCKED');
    expect(card.blocker.blocked).toBe(true);
    // Missing required evidence is surfaced in the canonical blocker projection,
    // not reconstructed by the card.
    expect(card.blocker.missingEvidence.length).toBeGreaterThan(0);
  });

  it('never reports READY prematurely in an early phase', () => {
    const card = buildFinishCard(makeProgressedState('TICKET'), policy);
    expect(card.overallStatus).not.toBe('READY');
  });

  it('does not invent a stale evidence status (not_yet_required never NOT_VERIFIED)', () => {
    // deriveFinishOverallStatus must only react to missing/failed required slots.
    const readiness = { blocked: false, warnings: [] } as unknown as ReturnType<
      typeof buildReadinessProjection
    >;
    const evidence = {
      slots: [{ required: false, status: 'not_yet_required' }],
    } as unknown as ReturnType<typeof buildEvidenceDetailProjection>;
    expect(deriveFinishOverallStatus(readiness, evidence)).toBe('READY');
  });

  it('CHANGES_REQUIRED when a completed standalone review reports issues', () => {
    const state = makeProgressedState('REVIEW_COMPLETE');
    const card = buildFinishCard(state, policy, makeReviewReport('issues'));
    expect(card.overallStatus).toBe('CHANGES_REQUIRED');
    expect(card.actionGuidance.find((guidance) => guidance.action === 'create PR')?.status).toBe(
      'not_recommended',
    );
  });
});

// ─── COMPOSITION: card mirrors underlying projections ───────────────────────

describe('buildFinishCard — composition-only (no independent evaluation)', () => {
  const state = makeProgressedState('COMPLETE');

  it('readiness equals buildReadinessProjection verbatim', () => {
    expect(buildFinishCard(state, policy).readiness).toEqual(
      buildReadinessProjection(state, policy),
    );
  });

  it('evidence equals buildEvidenceDetailProjection verbatim', () => {
    expect(buildFinishCard(state, policy).evidence).toEqual(buildEvidenceDetailProjection(state));
  });

  it('blocker equals buildBlockedProjection verbatim', () => {
    expect(buildFinishCard(state, policy).blocker).toEqual(buildBlockedProjection(state, policy));
  });

  it('nextAction.primaryCommand equals resolveNextAction commands[0] ?? null', () => {
    const next = resolveNextAction(state.phase, state);
    expect(buildFinishCard(state, policy).nextAction.primaryCommand).toBe(next.commands[0] ?? null);
  });

  it('warnings equal the readiness projection warnings', () => {
    const card = buildFinishCard(state, policy);
    expect(card.warnings).toEqual(buildReadinessProjection(state, policy).warnings);
  });
});

// ─── READ-ONLY: no mutation ─────────────────────────────────────────────────

describe('buildFinishCard — read-only', () => {
  it('does not mutate the input state', () => {
    const state = makeProgressedState('COMPLETE');
    const before = structuredClone(state);
    buildFinishCard(state, policy);
    expect(state).toEqual(before);
  });
});

// ─── TERMINAL phases ────────────────────────────────────────────────────────

describe('buildFinishCard — terminal phases', () => {
  for (const phase of ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'] as const) {
    it(`produces a Finish Card in ${phase}`, () => {
      const card = buildFinishCard(makeProgressedState(phase), policy);
      expect(card.phase).toBe(phase);
      expect([
        'READY',
        'READY_WITH_WARNINGS',
        'CHANGES_REQUIRED',
        'BLOCKED',
        'NOT_VERIFIED',
      ]).toContain(card.overallStatus);
    });
  }
});

// ─── GUARANTEES + exit options ──────────────────────────────────────────────

describe('buildFinishCard — guarantees and non-normative action framing', () => {
  const card = buildFinishCard(makeProgressedState('COMPLETE'), policy);

  it('exposes constant read-only / non-approval guarantees', () => {
    expect(card.guarantees).toEqual({
      readOnly: true,
      approves: false,
      consumesObligations: false,
      triggersExport: false,
    });
  });

  it('renders abandon as an exit option, never as a forbidden action', () => {
    expect(card.exitOptions).toContain('abandon');
    expect(card.actionGuidance.map((g) => g.action)).not.toContain('abandon');
  });

  it('action guidance uses only presentation labels', () => {
    for (const guidance of card.actionGuidance) {
      expect(['recommended', 'not_recommended', 'not_verified']).toContain(guidance.status);
      expect(guidance.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not recommend proceeding when NOT_VERIFIED', () => {
    const unverified = buildFinishCard(makeUnverifiedState(), policy);
    const proceed = unverified.actionGuidance.filter(
      (g) => g.action === 'create PR' || g.action === 'export evidence',
    );
    expect(proceed.length).toBeGreaterThan(0);
    for (const g of proceed) {
      expect(g.status).toBe('not_verified');
    }
  });

  it('does not recommend proceeding when BLOCKED', () => {
    const blocked = buildFinishCard(makeBlockedIncompleteState(), blockedPolicy);
    const proceed = blocked.actionGuidance.filter(
      (g) => g.action === 'create PR' || g.action === 'export evidence',
    );
    for (const g of proceed) {
      expect(g.status).toBe('not_recommended');
    }
  });
});
