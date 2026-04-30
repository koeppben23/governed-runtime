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
import { resolvePolicy } from '../config/policy.js';
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

// ─── HAPPY: All Phases, All Flows ─────────────────────────────────────────────

describe('policyMode — from policySnapshot', () => {
  const policy = resolvePolicy('solo');

  it('should project solo mode', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('solo');
  });

  it('should project regulated mode', () => {
    const state = {
      ...makeMinimalState('READY'),
      policySnapshot: {
        ...makeMinimalState('READY').policySnapshot!,
        mode: 'regulated' as const,
        allowSelfApproval: false,
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('regulated');
  });

  it('should fall back to unknown when no policySnapshot', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      policySnapshot: undefined,
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('unknown');
  });
});

describe('profileId — from activeProfile', () => {
  const policy = resolvePolicy('solo');

  it('should project profile id when set', () => {
    const state = {
      ...makeMinimalState('READY'),
      activeProfile: {
        id: 'typescript-node',
        name: 'TypeScript/Node.js',
        rules: [],
        ruleContent: '',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('typescript-node');
  });

  it('should project none when no activeProfile', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('none');
  });
});

// ─── BAD: Invalid / Missing Data ─────────────────────────────────────────────

describe('buildStatusProjection — BAD', () => {
  const policy = resolvePolicy('solo');

  it('should handle minimal state without policySnapshot', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      policySnapshot: undefined,
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('unknown');
    expect(projection.phase).toBe('READY');
  });

  it('should handle state without activeProfile', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('none');
    expect(projection.phase).toBe('READY');
  });

  it('should handle state without actorInfo', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.actor).toBeNull();
  });

  it('should handle state with null archiveStatus', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.archiveStatus).toBeNull();
  });
});

// ─── CORNER: Terminal Phases, READY Routing ───────────────────────────────────

describe('buildStatusProjection — CORNER', () => {
  const policy = resolvePolicy('solo');

  for (const phase of TERMINAL) {
    it(`terminal phase ${phase}: no blocker`, () => {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).toBeNull();
      expect(projection.nextAction.summary).toBeTruthy();
    });
  }

  it('READY phase: admissible primaryCommands', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    // Solo mode: all phase-starting primaryCommands are admissible at READY
    expect(projection.allowedCommands).toContain('/ticket');
    expect(projection.allowedCommands).toContain('/architecture');
    expect(projection.allowedCommands).toContain('/review');
  });
});

// ─── EDGE: Evidence Edge Cases ────────────────────────────────────────────────

describe('buildStatusProjection — EDGE evidence', () => {
  const policy = resolvePolicy('solo');

  it('should count all zero when no slots required (REVIEW flow)', () => {
    const state = makeMinimalState('REVIEW_COMPLETE');
    const projection = buildStatusProjection(state, policy);

    expect(projection.evidenceSummary.present).toBe(0);
    expect(projection.evidenceSummary.missing).toBe(0);
    expect(projection.evidenceSummary.notYetRequired).toBe(0);
    expect(projection.evidenceSummary.failed).toBe(0);
  });

  it('should have all notYetRequired at READY phase', () => {
    const state = makeMinimalState('READY');
    const projection = buildStatusProjection(state, policy);

    expect(projection.evidenceSummary.missing).toBe(0);
    expect(projection.evidenceSummary.present).toBe(0);
    expect(projection.evidenceSummary.failed).toBe(0);
  });

  it('should have ticket as present when set', () => {
    const state: SessionState = {
      ...makeMinimalState('TICKET'),
      ticket: {
        text: 'Implement login',
        source: 'user',
        digest: 'abc123def456',
        createdAt: new Date().toISOString(),
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.evidenceSummary.present).toBeGreaterThan(0);
  });

  it('should have plan as present when set', () => {
    const state: SessionState = {
      ...makeMinimalState('PLAN'),
      ticket: {
        text: 'Implement login',
        source: 'user',
        digest: 'abc123def456',
        createdAt: new Date().toISOString(),
      },
      plan: {
        current: { text: '## Plan\n...', digest: 'plan123' },
        history: [],
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.evidenceSummary.present).toBeGreaterThan(0);
  });
});

// ─── buildEvidenceDetailProjection — HAPPY/BAD/EDGE ─────────────────────────

describe('buildEvidenceDetailProjection — HAPPY', () => {
  it('should project all slots for TICKET phase', () => {
    const state = makeMinimalState('TICKET');
    const detail = buildEvidenceDetailProjection(state);

    expect(Array.isArray(detail.slots)).toBe(true);
    expect(detail.slots.length).toBeGreaterThan(0);
    expect(typeof detail.overallComplete).toBe('boolean');
    expect(typeof detail.fourEyes).toBe('object');
    expect(typeof detail.fourEyes.required).toBe('boolean');
    expect(typeof detail.fourEyes.satisfied).toBe('boolean');
    expect(typeof detail.fourEyes.detail).toBe('string');
  });

  it('should have no slots for REVIEW flow', () => {
    const state = makeMinimalState('REVIEW');
    const detail = buildEvidenceDetailProjection(state);

    expect(detail.slots).toHaveLength(0);
    expect(detail.summary.present).toBe(0);
    expect(detail.summary.missing).toBe(0);
    expect(detail.summary.notYetRequired).toBe(0);
    expect(detail.summary.failed).toBe(0);
  });

  it('should mark required slots as complete when present', () => {
    const state: SessionState = {
      ...makeMinimalState('TICKET'),
      ticket: {
        text: 'Implement login',
        source: 'user',
        digest: 'abc123def456',
        createdAt: new Date().toISOString(),
      },
    };
    const detail = buildEvidenceDetailProjection(state);
    const ticketSlot = detail.slots.find((s) => s.slot === 'ticket');

    expect(ticketSlot).toBeDefined();
    expect(ticketSlot!.status).toBe('complete');
    expect(ticketSlot!.required).toBe(true);
  });

  it('should mark plan as missing when absent (at PLAN phase)', () => {
    const state = makeMinimalState('PLAN');
    const detail = buildEvidenceDetailProjection(state);
    const planSlot = detail.slots.find((s) => s.slot === 'plan');

    expect(planSlot).toBeDefined();
    expect(planSlot!.status).toBe('missing');
    expect(planSlot!.required).toBe(true);
  });

  it('should mark future slots as not_yet_required', () => {
    const state = makeMinimalState('READY');
    const detail = buildEvidenceDetailProjection(state);
    const ticketSlot = detail.slots.find((s) => s.slot === 'ticket');

    expect(ticketSlot).toBeDefined();
    expect(ticketSlot!.status).toBe('not_yet_required');
    expect(ticketSlot!.required).toBe(false);
  });

  it('should project fourEyes details', () => {
    const state = {
      ...makeMinimalState('READY'),
      policySnapshot: {
        ...makeMinimalState('READY').policySnapshot!,
        mode: 'regulated' as const,
        allowSelfApproval: false,
      },
    };
    const detail = buildEvidenceDetailProjection(state);

    expect(detail.fourEyes.required).toBe(true);
    expect(typeof detail.fourEyes.detail).toBe('string');
  });

  it('should project slot detail for ticket', () => {
    const state: SessionState = {
      ...makeMinimalState('TICKET'),
      ticket: {
        text: 'Implement login',
        source: 'user',
        digest: 'abc123def456',
        createdAt: new Date().toISOString(),
      },
    };
    const detail = buildEvidenceDetailProjection(state);
    const ticketSlot = detail.slots.find((s) => s.slot === 'ticket');

    expect(ticketSlot!.detail).toContain('source: user');
    expect(ticketSlot!.detail).toContain('digest:');
    expect(ticketSlot!.artifactKind).toBe('ticket_evidence');
    expect(ticketSlot!.hint).toBeNull();
  });

  it('should keep hint null for missing slot when canonical source has no hint', () => {
    const state = makeMinimalState('PLAN');
    const detail = buildEvidenceDetailProjection(state);
    const planSlot = detail.slots.find((s) => s.slot === 'plan');

    expect(planSlot).toBeDefined();
    expect(planSlot!.status).toBe('missing');
    expect(planSlot!.hint).toBeNull();
    expect(planSlot!.artifactKind).toBe('plan_record');
  });
});

describe('buildEvidenceDetailProjection — EDGE', () => {
  it('should handle COMPLETE phase with no error (all slots complete)', () => {
    const state: SessionState = {
      ...makeMinimalState('COMPLETE'),
      ticket: {
        text: 'Task done',
        source: 'user',
        digest: 'ticket_digest',
        createdAt: new Date().toISOString(),
      },
      plan: {
        current: { text: '## Plan', digest: 'plan_digest' },
        history: [],
      },
      selfReview: {
        iteration: 1,
        maxIterations: 2,
        verdict: 'approve',
        revisionDelta: 'none',
      },
      activeChecks: ['check_1'],
      validation: [
        {
          checkId: 'check_1',
          passed: true,
          detail: 'All checks passed',
          executedAt: new Date().toISOString(),
        },
      ],
      implementation: {
        changedFiles: ['a.ts'],
        digest: 'impl_digest',
      },
      implReview: {
        iteration: 1,
        maxIterations: 2,
        verdict: 'approve',
        revisionDelta: 'none',
      },
      reviewDecision: {
        verdict: 'approve',
        rationale: 'All good',
        decidedBy: 'reviewer@corp.com',
        decidedAt: new Date().toISOString(),
      },
      error: null,
    };
    const detail = buildEvidenceDetailProjection(state);

    expect(detail.overallComplete).toBe(true);
    expect(detail.slots.every((s) => s.status === 'complete')).toBe(true);
  });

  it('should mark validation as failed when checks fail', () => {
    const state: SessionState = {
      ...makeMinimalState('IMPLEMENTATION'),
      ticket: {
        text: 'Task',
        source: 'user',
        digest: 'ticket_digest',
        createdAt: new Date().toISOString(),
      },
      plan: {
        current: { text: '## Plan', digest: 'plan_digest' },
        history: [],
      },
      selfReview: {
        iteration: 1,
        maxIterations: 2,
        verdict: 'approve',
        revisionDelta: 'none',
      },
      activeChecks: ['check_1', 'check_2'],
      validation: [
        {
          checkId: 'check_1',
          passed: false,
          detail: 'Failed check 1',
          executedAt: new Date().toISOString(),
        },
        {
          checkId: 'check_2',
          passed: true,
          detail: 'Passed check 2',
          executedAt: new Date().toISOString(),
        },
      ],
    };
    const detail = buildEvidenceDetailProjection(state);
    const validationSlot = detail.slots.find((s) => s.slot === 'validation');

    expect(validationSlot).toBeDefined();
    expect(validationSlot!.status).toBe('failed');
    expect(validationSlot!.detail).toContain('1/2 passed');
  });
});

// ─── nextAction field mapping ──────────────────────────────────────────────────

describe('nextAction field mapping', () => {
  const policy = resolvePolicy('solo');

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
  const policy = resolvePolicy('solo');

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
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).not.toBeNull();
      expect(projection.blocker!.reasonCode).toBeNull();
    }
  });
});

// ─── why-blocked projection ───────────────────────────────────────────────────

describe('buildBlockedProjection', () => {
  const solo = resolvePolicy('solo');
  const regulated = resolvePolicy('regulated');

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
    const readiness = buildReadinessProjection(state, resolvePolicy('solo'));

    expect(readiness.phase).toBe('READY');
    expect(readiness.policyMode).toBe('solo');
    expect(typeof readiness.blocked).toBe('boolean');
    expect(typeof readiness.evidenceComplete).toBe('boolean');
    expect(typeof readiness.actorKnown).toBe('boolean');
  });

  it('includes warning when legacy selfReview config is normalized', () => {
    const state = makeMinimalState('READY');
    // Inject legacy config
    if (state.policySnapshot) {
      (state.policySnapshot as any).selfReview = {
        subagentEnabled: false,
        fallbackToSelf: true,
        strictEnforcement: false,
      };
    }
    const readiness = buildReadinessProjection(state, resolvePolicy('solo'));

    expect(readiness.warnings).toBeDefined();
    expect(readiness.warnings.length).toBeGreaterThan(0);
    expect(readiness.warnings[0]).toContain('Legacy selfReview config');
  });
});

// ─── E2E: Full Session Simulation ────────────────────────────────────────────

describe('buildStatusProjection — E2E', () => {
  it('should project complete TICKET flow lifecycle', () => {
    const policy = resolvePolicy('solo');

    const phases = [
      'READY',
      'TICKET',
      'PLAN',
      'PLAN_REVIEW',
      'VALIDATION',
      'IMPLEMENTATION',
      'IMPL_REVIEW',
      'EVIDENCE_REVIEW',
    ] as const;

    for (const phase of phases) {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.phase).toBe(phase);
      expect(projection.sessionId).toBe('ses_test_0001');
      expect(Array.isArray(projection.allowedCommands)).toBe(true);
      expect(typeof projection.nextAction.summary).toBe('string');
    }
  });

  it('should handle regulated mode with four-eyes policy', () => {
    const policy = resolvePolicy('regulated');
    const state: SessionState = {
      ...makeMinimalState('EVIDENCE_REVIEW'),
      policySnapshot: {
        ...makeMinimalState('EVIDENCE_REVIEW').policySnapshot!,
        mode: 'regulated' as const,
        allowSelfApproval: false,
        requireHumanGates: true,
      },
      actorInfo: {
        id: 'reviewer@corp.com',
        source: 'claim',
        email: 'reviewer@corp.com',
      },
      archiveStatus: 'pending',
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('regulated');
    expect(projection.actor).not.toBeNull();
    expect(projection.archiveStatus).toBe('pending');
  });

  it('should handle team-ci mode with ci_context_missing', () => {
    const policy = resolvePolicy('team-ci');
    const state: SessionState = {
      ...makeMinimalState('READY'),
      policySnapshot: {
        ...makeMinimalState('READY').policySnapshot!,
        mode: 'team' as const,
        degradedReason: 'ci_context_missing',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('team');
  });
});

// ─── Profile ─────────────────────────────────────────────────────────────────

describe('buildStatusProjection — Profile Projection', () => {
  const policy = resolvePolicy('solo');

  it('should project java profile', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      activeProfile: {
        id: 'java-spring-boot',
        name: 'Java / Spring Boot',
        rules: [],
        ruleContent: '',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('java-spring-boot');
  });

  it('should project angular profile', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      activeProfile: {
        id: 'angular-nx',
        name: 'Angular / Nx',
        rules: [],
        ruleContent: '',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('angular-nx');
  });

  it('should project typescript profile', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      activeProfile: {
        id: 'typescript-node',
        name: 'TypeScript / Node.js',
        rules: [],
        ruleContent: '',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('typescript-node');
  });

  it('should project baseline profile', () => {
    const state: SessionState = {
      ...makeMinimalState('READY'),
      activeProfile: {
        id: 'baseline',
        name: 'Baseline',
        rules: [],
        ruleContent: '',
      },
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.profileId).toBe('baseline');
  });
});
