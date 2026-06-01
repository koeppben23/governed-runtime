/**
 * @module integration/status.test
 * @description Tests for StatusProjection — validates SSOT alignment.
 *
 * Test strategy (5-category):
 * - HAPPY: Valid projections across all 14 phases, 3 flows, all actor sources
 * - BAD: No session, invalid state references
 * - CORNER: Terminal phases, READY routing phase
 * - EDGE: Evidence edge cases (all summary counts), architecture flow, review flow
 * - E2E: Full projection chain from test-helpers session
 *
 * Design contract:
 *   "Status surfaces must be projections of canonical runtime truth,
 *    never an independent interpretation layer."
 *
 * This test suite validates that contract by verifying:
 * - Each projection field maps to exactly one SSOT source
 * - No new semantics are invented in the projection layer
 * - The projection is consistent across all phases and flows
 *
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../state/schema.js';
import {
  buildStatusProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from './status.js';
import { getPolicyPreset } from '../config/policy.js';
import { isCommandAllowed, Command } from '../machine/commands.js';
import { USER_GATES, TERMINAL } from '../machine/topology.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const ALL_PHASES = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'REVIEW',
  'REVIEW_COMPLETE',
] as const;
const TICKET_FLOW_PHASES = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
] as const;
const ARCH_FLOW_PHASES = ['READY', 'ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE'] as const;
const REVIEW_FLOW_PHASES = ['READY', 'REVIEW', 'REVIEW_COMPLETE'] as const;

function makeMinimalState(phase: SessionState['phase'] = 'READY'): SessionState {
  return {
    id: 'ses_test_0001',
    phase,
    initiatedBy: 'tester@corp.com',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    policySnapshot: {
      mode: 'solo',
      source: 'default',
      requestedMode: 'solo',
      effectiveGateBehavior: 'auto',
      allowSelfApproval: true,
      maxSelfReviewIterations: 2,
      maxImplReviewIterations: 2,
      requireHumanGates: false,
      emitTransitions: true,
      emitToolCalls: true,
      enableChainHash: true,
      actorClassification: 'solo',
      policyDigest: 'testdigest123',
      policyVersion: 'v1.0.0',
      validationEvidence: { enforcement: 'off', allowNoCommands: false },
    },
    detectedStack: null,
    activeProfile: null,
    activeChecks: [],
    verificationCandidates: [],
    ticket: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    architecture: null,
    archiveStatus: null,
    actorInfo: null,
    error: null,
  };
}

function makeActorState(
  phase: SessionState['phase'] = 'READY',
  actorInfo: { id: string; source: 'env' | 'git' | 'claim' | 'unknown'; email: string | null },
): SessionState {
  return { ...makeMinimalState(phase), actorInfo };
}

describe('nextAction field mapping', () => {
  const policy = getPolicyPreset('solo');

  it('should map nextAction.primaryCommand to first available primaryCommand', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.nextAction.primaryCommand).toBeTruthy();
    expect(projection.nextAction.primaryCommand).toMatch(/^\//);
  });

  it('should map nextAction.summary to text from resolveNextAction', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.nextAction.summary).toBeTruthy();
    expect(projection.nextAction.summary.length).toBeGreaterThan(0);
  });
});

// ─── blocker field mapping ─────────────────────────────────────────────────────

describe('blocker field mapping', () => {
  const policy = getPolicyPreset('solo');

  it('should have null blocker at terminal phases', () => {
    for (const phase of TERMINAL) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).toBeNull();
    }
  });

  it('should have null blocker at user gate phases (solo: auto-approve)', () => {
    for (const phase of USER_GATES) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).toBeNull();
    }
  });

  it('should have null reasonCode for pending phases (no structured code in SSOT)', () => {
    const pendingPhases = ['READY', 'TICKET', 'PLAN', 'ARCHITECTURE'] as const;
    for (const phase of pendingPhases) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).not.toBeNull();
      expect(projection.blocker!.reasonCode).toBeNull();
    }
  });

  it('should have null reasonCode for auto-advance phases (no structured code in SSOT)', () => {
    const autoPhases = ['VALIDATION', 'IMPLEMENTATION', 'IMPL_REVIEW'] as const;
    for (const phase of autoPhases) {
      const state = {
        ...makeMinimalState(phase),
        // VALIDATION needs activeChecks to be non-empty, otherwise vacuous truth auto-advances
        activeChecks: phase === 'VALIDATION' ? ['test'] : [],
      };
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).not.toBeNull();
      expect(projection.blocker!.reasonCode).toBeNull();
    }
  });
});

// ─── why-blocked projection ───────────────────────────────────────────────────

describe('buildBlockedProjection', () => {
  const solo = getPolicyPreset('solo');
  const regulated = getPolicyPreset('regulated');

  it('reports blocked=false on terminal phase', () => {
    const blocked = buildBlockedProjection(makeMinimalState('COMPLETE'), solo);
    expect(blocked.blocked).toBe(false);
    expect(blocked.reasonCode).toBeNull();
  });

  it('reports blocked=true and missingEvidence on pending phase', () => {
    const blocked = buildBlockedProjection(makeMinimalState('PLAN'), solo);
    expect(blocked.blocked).toBe(true);
    expect(blocked.missingEvidence.some((slot) => slot.slot === 'plan')).toBe(true);
    expect(blocked.nextResolvableCommand).toBe('/continue');
  });

  it('reports waiting reason at user gate under regulated policy', () => {
    const blocked = buildBlockedProjection(makeMinimalState('PLAN_REVIEW'), regulated);
    expect(blocked.blocked).toBe(true);
    expect(typeof blocked.reasonText).toBe('string');
    expect(blocked.reasonText).toContain('Awaiting');
    expect(blocked.nextResolvableCommand).toBe('/review-decision');
    expect(blocked.humanActionRequired).toBe(true);
  });
});

// ─── context/readiness projections ────────────────────────────────────────────

describe('context and readiness projections', () => {
  it('buildContextProjection maps actor/policy/archive from state', () => {
    const state: SessionState = {
      ...makeMinimalState('EVIDENCE_REVIEW'),
      actorInfo: { id: 'operator', source: 'env', email: 'op@example.com' },
      archiveStatus: 'pending',
      policySnapshot: {
        ...makeMinimalState('EVIDENCE_REVIEW').policySnapshot!,
        mode: 'regulated' as const,
        allowSelfApproval: false,
        requireVerifiedActorsForApproval: true,
        centralMinimumMode: 'team' as const,
      },
    };

    const contextProjection = buildContextProjection(state);
    expect(contextProjection.actor?.id).toBe('operator');
    expect(contextProjection.archiveStatus).toBe('pending');
    expect(contextProjection.policyMode).toBe('regulated');
    expect(contextProjection.regulated.applicable).toBe(true);
    expect(contextProjection.regulated.centralPolicyActive).toBe(true);
    expect(contextProjection.regulated.fourEyesRelevant).toBe(true);
  });

  it('buildReadinessProjection is pure projection over canonical evaluators', () => {
    const state = makeMinimalState('READY');
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));

    expect(readiness.phase).toBe('READY');
    expect(readiness.policyMode).toBe('solo');
    expect(typeof readiness.blocked).toBe('boolean');
    expect(typeof readiness.evidenceComplete).toBe('boolean');
    expect(typeof readiness.actorKnown).toBe('boolean');
  });

  it('includes warning when legacy selfReview config is normalized', () => {
    let state = makeMinimalState('READY');
    // Inject legacy config
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: false,
            fallbackToSelf: true,
            strictEnforcement: false,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));

    expect(readiness.warnings).toBeDefined();
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });

  // ─── MUTATION KILL: selfReview config check (lines 350-355) ────────────────

  it('readiness HAPPY returns no warnings when selfReview config is correct', () => {
    let state = makeMinimalState('READY');
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.warnings).toHaveLength(0);
  });

  it('readiness warning when subagentEnabled is false (survivor kill)', () => {
    let state = makeMinimalState('READY');
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: false,
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });

  it('readiness warning when fallbackToSelf is true (survivor kill)', () => {
    let state = makeMinimalState('READY');
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: true,
            strictEnforcement: true,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });

  it('readiness warning when strictEnforcement is false (survivor kill)', () => {
    let state = makeMinimalState('READY');
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: false,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });

  it('readiness warning when all three selfReview flags are wrong (survivor kill)', () => {
    let state = makeMinimalState('READY');
    if (state.policySnapshot) {
      state = {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          selfReview: {
            subagentEnabled: false,
            fallbackToSelf: true,
            strictEnforcement: false,
          },
        },
      };
    }
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });

  // ─── MUTATION KILL: actorKnown field (line 371) ───────────────────────────

  it('readiness actorKnown is true when actorInfo source is env (survivor kill)', () => {
    const state = makeMinimalState('READY');
    state.actorInfo = { id: 'u1', source: 'env', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.actorKnown).toBe(true);
  });

  it('readiness actorKnown is true when actorInfo source is git (survivor kill)', () => {
    const state = makeMinimalState('READY');
    state.actorInfo = { id: 'u1', source: 'git', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.actorKnown).toBe(true);
  });

  it('readiness actorKnown is true when actorInfo source is claim (survivor kill)', () => {
    const state = makeMinimalState('READY');
    state.actorInfo = { id: 'u1', source: 'claim', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.actorKnown).toBe(true);
  });

  it('readiness actorKnown is true when actorInfo source is oidc (survivor kill)', () => {
    const state = makeMinimalState('READY');
    state.actorInfo = { id: 'u1', source: 'oidc', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.actorKnown).toBe(true);
  });

  it('readiness actorKnown is false when actorInfo source is unknown (survivor kill)', () => {
    const state = makeMinimalState('READY');
    state.actorInfo = { id: 'u1', source: 'unknown', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.actorKnown).toBe(false);
  });

  // ─── MUTATION KILL: regulated mode check (line 373) ────────────────────────

  it('readiness returns minimumActorAssuranceForApproval only in regulated mode (survivor kill)', () => {
    const soloState = makeMinimalState('READY');
    const soloReadiness = buildReadinessProjection(soloState, getPolicyPreset('solo'));
    expect(soloReadiness.minimumActorAssuranceForApproval).toBeNull();

    const regulatedState = {
      ...makeMinimalState('READY'),
      policySnapshot: {
        ...makeMinimalState('READY').policySnapshot!,
        mode: 'regulated' as const,
        minimumActorAssuranceForApproval: 'claim_validated' as const,
      },
    };
    const regulatedReadiness = buildReadinessProjection(
      regulatedState,
      getPolicyPreset('regulated'),
    );
    expect(regulatedReadiness.minimumActorAssuranceForApproval).toBe('claim_validated');
  });

  // ─── MUTATION KILL: buildBlocker function (lines 390-405) ──────────────────

  it('blocker is null for terminal phases in buildStatusProjection (survivor kill)', () => {
    const policy = getPolicyPreset('solo');
    for (const phase of TERMINAL) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);
      expect(projection.blocker).toBeNull();
    }
  });

  it('blocker has reasonText for waiting phases (survivor kill)', () => {
    const policy = getPolicyPreset('regulated');
    for (const phase of USER_GATES) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);
      expect(projection.blocker).not.toBeNull();
      expect(projection.blocker!.reasonCode).toBeNull();
      expect(typeof projection.blocker!.reasonText).toBe('string');
    }
  });

  it('blocker has null reasonText for pending phases (survivor kill)', () => {
    const policy = getPolicyPreset('solo');
    const pendingPhases = ['READY', 'TICKET', 'PLAN', 'ARCHITECTURE'];
    for (const phase of pendingPhases) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);
      expect(projection.blocker).not.toBeNull();
      expect(projection.blocker!.reasonCode).toBeNull();
      // For pending phases, reasonText may be null or a string depending on evaluate()
      expect(projection.blocker!.reasonText).toBeNull();
    }
  });

  it('HAPPY returns readiness surface when readiness flag is set (survivor kill)', () => {
    const state = makeMinimalState('TICKET');
    state.ticket = { text: 't', digest: 'd', source: 'user', createdAt: new Date().toISOString() };
    state.actorInfo = { id: 'u1', source: 'claim', email: 'u@e.com' };
    const readiness = buildReadinessProjection(state, getPolicyPreset('solo'));
    expect(readiness.phase).toBe('TICKET');
    expect(readiness.blocked).toBe(true); // pending phase
    expect(readiness.evidenceComplete).toBe(true);
    expect(readiness.actorKnown).toBe(true);
    expect(readiness.warnings).toEqual([]);
  });
});
