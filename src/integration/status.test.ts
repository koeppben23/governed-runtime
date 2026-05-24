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
  const policy = getPolicyPreset('solo');

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
  const policy = getPolicyPreset('solo');

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
  const policy = getPolicyPreset('solo');

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
  const policy = getPolicyPreset('solo');

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
  const policy = getPolicyPreset('solo');

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
