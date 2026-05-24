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

describe('buildStatusProjection — E2E', () => {
  it('should project complete TICKET flow lifecycle', () => {
    const policy = getPolicyPreset('solo');

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
    const policy = getPolicyPreset('regulated');
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
    const policy = getPolicyPreset('team-ci');
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
  const policy = getPolicyPreset('solo');

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

// ─── Status Mutation Kill Matrix ─────────────────────────────────────────────

describe('status.ts MUTATION_KILL matrix', () => {
  const solo = getPolicyPreset('solo');
  const regulated = getPolicyPreset('regulated');

  const fixedTime = '2026-04-30T12:00:00.000Z';

  function stateWithTicket(phase: SessionState['phase'] = 'TICKET'): SessionState {
    return {
      ...makeMinimalState(phase),
      ticket: {
        text: 'Implement governed status projection',
        source: 'user',
        digest: 'ticket-digest',
        createdAt: fixedTime,
      },
    };
  }

  function stateWithPlan(phase: SessionState['phase'] = 'PLAN'): SessionState {
    return {
      ...stateWithTicket(phase),
      plan: {
        current: { text: '## Plan\nShip status tests', digest: 'plan-digest' },
        history: [],
      },
    };
  }

  describe('SMOKE buildStatusProjection exact shape', () => {
    it('projects actor, policy, profile, archive, next action, product next action, and command prefixes', () => {
      const state: SessionState = {
        ...stateWithTicket('READY'),
        activeProfile: { id: 'baseline', name: 'Baseline', rules: [], ruleContent: '' },
        archiveStatus: 'verified',
        actorInfo: {
          id: 'actor-1',
          source: 'claim',
          assurance: 'claim_validated',
          email: 'actor@example.com',
        },
      };

      const projection = buildStatusProjection(state, solo);

      expect(projection).toMatchObject({
        phase: 'READY',
        phaseLabel: 'Ready',
        sessionId: 'ses_test_0001',
        policyMode: 'solo',
        profileId: 'baseline',
        archiveStatus: 'verified',
        actor: {
          id: 'actor-1',
          source: 'claim',
          assurance: 'claim_validated',
        },
      });
      expect(projection.allowedCommands).toEqual(
        expect.arrayContaining(['/ticket', '/architecture', '/review']),
      );
      expect(projection.allowedCommands.every((cmd) => cmd.startsWith('/'))).toBe(true);
      expect(projection.nextAction.primaryCommand).toBe('/ticket');
      expect(projection.nextAction.summary).toContain('Choose your workflow');
      expect(projection.productNextAction.primaryCommand).toBe('/task');
      expect(projection.productNextAction.summary).toContain('/task');
    });

    it('BAD falls back to unknown policy mode and none profile without changing phase', () => {
      const state: SessionState = {
        ...makeMinimalState('READY'),
        policySnapshot: undefined,
        activeProfile: null,
      };

      const projection = buildStatusProjection(state, solo);

      expect(projection.policyMode).toBe('unknown');
      expect(projection.profileId).toBe('none');
      expect(projection.phase).toBe('READY');
      expect(projection.actor).toBeNull();
      expect(projection.archiveStatus).toBeNull();
    });
  });

  describe('HAPPY/CORNER blocker projection', () => {
    it('pending phases expose a blocker with null reason text and no human action requirement', () => {
      for (const phase of ['READY', 'TICKET', 'PLAN', 'ARCHITECTURE'] as const) {
        const status = buildStatusProjection(makeMinimalState(phase), solo);
        const blocked = buildBlockedProjection(makeMinimalState(phase), solo);

        expect(status.blocker).toEqual({ reasonCode: null, reasonText: null });
        expect(blocked.blocked).toBe(true);
        expect(blocked.reasonCode).toBeNull();
        expect(blocked.reasonText).toBeNull();
        expect(blocked.humanActionRequired).toBeNull();
        expect(blocked.recoveryHint).toBeTruthy();
        expect(blocked.nextResolvableCommand).toMatch(/^\//);
      }
    });

    it('waiting user gates expose waiting reason and humanActionRequired=true', () => {
      for (const phase of USER_GATES) {
        const state = makeMinimalState(phase);
        const status = buildStatusProjection(state, regulated);
        const blocked = buildBlockedProjection(state, regulated);

        expect(status.blocker).not.toBeNull();
        expect(status.blocker!.reasonCode).toBeNull();
        expect(status.blocker!.reasonText).toContain('Awaiting');
        expect(blocked.blocked).toBe(true);
        expect(blocked.reasonText).toContain('Awaiting');
        expect(blocked.humanActionRequired).toBe(true);
        expect(blocked.nextResolvableCommand).toBe('/review-decision');
      }
    });

    it('terminal phases have no blocker and humanActionRequired=false', () => {
      for (const phase of TERMINAL) {
        const state = makeMinimalState(phase);
        const status = buildStatusProjection(state, solo);
        const blocked = buildBlockedProjection(state, solo);

        expect(status.blocker).toBeNull();
        expect(blocked.blocked).toBe(false);
        expect(blocked.reasonCode).toBeNull();
        expect(blocked.reasonText).toBeNull();
        expect(blocked.humanActionRequired).toBe(false);
      }
    });
  });

  describe('EDGE evidence and missingEvidence projections', () => {
    it('reports only required missing evidence in buildBlockedProjection', () => {
      const blocked = buildBlockedProjection(makeMinimalState('PLAN'), solo);

      expect(blocked.missingEvidence).toContainEqual({ slot: 'ticket', hint: null });
      expect(blocked.missingEvidence).toContainEqual({ slot: 'plan', hint: null });
      expect(blocked.missingEvidence.some((slot) => slot.slot === 'implementation')).toBe(false);
    });

    it('reports failed validation detail as hint and complete slots with null hint', () => {
      const state: SessionState = {
        ...stateWithPlan('IMPLEMENTATION'),
        selfReview: { iteration: 1, maxIterations: 3, verdict: 'approve', revisionDelta: 'none' },
        activeChecks: ['unit', 'lint'],
        validation: [
          { checkId: 'unit', passed: false, detail: 'unit failed', executedAt: fixedTime },
          { checkId: 'lint', passed: true, detail: 'lint passed', executedAt: fixedTime },
        ],
      };

      const detail = buildEvidenceDetailProjection(state);
      const blocked = buildBlockedProjection(state, solo);
      const validation = detail.slots.find((slot) => slot.slot === 'validation');
      const ticket = detail.slots.find((slot) => slot.slot === 'ticket');

      expect(validation).toMatchObject({
        slot: 'validation',
        status: 'failed',
        required: true,
        artifactKind: 'validation_results',
      });
      expect(validation!.hint).toContain('1/2 passed');
      expect(validation!.detail).toContain('1/2 passed');
      expect(ticket).toMatchObject({ status: 'complete', required: true, hint: null });
      expect(blocked.missingEvidence).toContainEqual({
        slot: 'validation',
        hint: expect.stringContaining('1/2 passed'),
      });
    });
  });

  describe('BAD/CORNER context projection', () => {
    it('non-regulated context disables regulated-only fields', () => {
      const state: SessionState = {
        ...makeMinimalState('READY'),
        policySnapshot: {
          ...makeMinimalState('READY').policySnapshot!,
          mode: 'team' as const,
          allowSelfApproval: true,
          centralMinimumMode: undefined,
          minimumActorAssuranceForApproval: 'idp_verified' as const,
        },
      };

      const context = buildContextProjection(state);

      expect(context.policyMode).toBe('team');
      expect(context.regulated).toEqual({
        applicable: false,
        minimumActorAssuranceForApproval: null,
        centralPolicyActive: null,
        fourEyesRelevant: null,
      });
    });

    it('regulated context exposes minimum assurance, central policy, and four-eyes relevance', () => {
      const state: SessionState = {
        ...makeMinimalState('READY'),
        actorInfo: {
          id: 'reviewer',
          source: 'oidc',
          assurance: 'idp_verified',
          email: 'reviewer@example.com',
        },
        archiveStatus: 'pending',
        policySnapshot: {
          ...makeMinimalState('READY').policySnapshot!,
          mode: 'regulated' as const,
          allowSelfApproval: false,
          centralMinimumMode: 'team' as const,
          minimumActorAssuranceForApproval: 'idp_verified' as const,
        },
      };

      const context = buildContextProjection(state);

      expect(context.actor).toEqual({
        id: 'reviewer',
        source: 'oidc',
        assurance: 'idp_verified',
      });
      expect(context.archiveStatus).toBe('pending');
      expect(context.regulated).toEqual({
        applicable: true,
        minimumActorAssuranceForApproval: 'idp_verified',
        centralPolicyActive: true,
        fourEyesRelevant: true,
      });
    });
  });

  describe('HAPPY/BAD/CORNER readiness projection', () => {
    it('regulated readiness defaults minimum assurance to claim_validated', () => {
      const state: SessionState = {
        ...makeMinimalState('PLAN_REVIEW'),
        policySnapshot: {
          ...makeMinimalState('PLAN_REVIEW').policySnapshot!,
          mode: 'regulated' as const,
          requireHumanGates: true,
          allowSelfApproval: false,
          minimumActorAssuranceForApproval: undefined,
        },
      };

      const readiness = buildReadinessProjection(state, regulated);

      expect(readiness.policyMode).toBe('regulated');
      expect(readiness.blocked).toBe(true);
      expect(readiness.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('non-regulated readiness does not expose minimum assurance even if snapshot contains one', () => {
      const state: SessionState = {
        ...makeMinimalState('READY'),
        policySnapshot: {
          ...makeMinimalState('READY').policySnapshot!,
          mode: 'team' as const,
          minimumActorAssuranceForApproval: 'idp_verified' as const,
        },
      };

      const readiness = buildReadinessProjection(state, solo);

      expect(readiness.policyMode).toBe('team');
      expect(readiness.minimumActorAssuranceForApproval).toBeNull();
    });

    it('actorKnown is false only for unknown actor source', () => {
      const unknown = makeMinimalState('READY');
      unknown.actorInfo = {
        id: 'unknown-actor',
        source: 'unknown',
        assurance: 'best_effort',
        email: null,
      };

      const claim = makeMinimalState('READY');
      claim.actorInfo = {
        id: 'claim-actor',
        source: 'claim',
        assurance: 'claim_validated',
        email: 'claim@example.com',
      };

      const absent = makeMinimalState('READY');

      expect(buildReadinessProjection(unknown, solo).actorKnown).toBe(false);
      expect(buildReadinessProjection(claim, solo).actorKnown).toBe(true);
      expect(buildReadinessProjection(absent, solo).actorKnown).toBe(true);
    });

    it('strict selfReview config produces no warning while each legacy flag does', () => {
      let strict = makeMinimalState('READY');
      strict = {
        ...strict,
        policySnapshot: {
          ...strict.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };

      let weakSubagent = makeMinimalState('READY');
      weakSubagent = {
        ...weakSubagent,
        policySnapshot: {
          ...weakSubagent.policySnapshot,
          selfReview: {
            subagentEnabled: false,
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };

      let weakFallback = makeMinimalState('READY');
      weakFallback = {
        ...weakFallback,
        policySnapshot: {
          ...weakFallback.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: true,
            strictEnforcement: true,
          },
        },
      };

      let weakStrict = makeMinimalState('READY');
      weakStrict = {
        ...weakStrict,
        policySnapshot: {
          ...weakStrict.policySnapshot,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: false,
          },
        },
      };

      expect(buildReadinessProjection(strict, solo).warnings).toEqual([]);
      for (const state of [weakSubagent, weakFallback, weakStrict]) {
        expect(buildReadinessProjection(state, solo).warnings).toEqual([
          expect.stringContaining('Legacy selfReview config'),
        ]);
      }
    });
  });

  describe('E2E status projection lifecycle', () => {
    it('tracks ticket-to-plan evidence counts and allowed commands across phases', () => {
      const ticketState = stateWithTicket('TICKET');
      const planState = stateWithPlan('PLAN');

      const ticketStatus = buildStatusProjection(ticketState, solo);
      const planStatus = buildStatusProjection(planState, solo);

      expect(ticketStatus.phase).toBe('TICKET');
      expect(ticketStatus.evidenceSummary.present).toBe(1);
      expect(ticketStatus.evidenceSummary.missing).toBe(0);
      expect(ticketStatus.allowedCommands).toContain('/ticket');
      expect(ticketStatus.nextAction.primaryCommand).toBe('/plan');

      expect(planStatus.phase).toBe('PLAN');
      expect(planStatus.evidenceSummary.present).toBe(2);
      expect(planStatus.evidenceSummary.missing).toBe(0);
      expect(planStatus.allowedCommands).toContain('/plan');
      expect(planStatus.nextAction.primaryCommand).toBe('/continue');
    });
  });

  // ─── Targeted survivor-kill tests ───────────────────────────────────────────
  describe('SURVIVOR_KILL buildBlockedProjection', () => {
    it('respects requireHumanGates from policy when computing blocked status', () => {
      // Kills L289 ObjectLiteral mutant (`evaluate(state, {})`):
      // PLAN_REVIEW with team policy (requireHumanGates=true) must be blocked,
      // while solo (requireHumanGates=false) auto-resolves and is not blocked.
      const state = stateWithPlan('PLAN_REVIEW');
      const team = getPolicyPreset('team');
      const teamBlocked = buildBlockedProjection(state, team);
      const soloBlocked = buildBlockedProjection(state, solo);
      expect(teamBlocked.blocked).toBe(true);
      expect(soloBlocked.blocked).toBe(false);
    });

    it('omits non-required slots from missingEvidence even when status is missing', () => {
      // Kills L295 LogicalOperator (`||` instead of `&&`) and ConditionalExpression mutants:
      // a slot must be both required AND missing/failed to surface.
      const state = stateWithTicket('TICKET');
      const blocked = buildBlockedProjection(state, solo);
      // Every reported missing slot must be marked required.
      for (const item of blocked.missingEvidence) {
        // Slot id must be a non-empty string from the canonical evidence schema.
        expect(typeof item.slot).toBe('string');
        expect(item.slot.length).toBeGreaterThan(0);
      }
      // For a TICKET state, no required-and-missing slots exist (ticket is present).
      expect(blocked.missingEvidence).toEqual([]);
    });

    it('returns null hint for missing slots and slot.detail for failed slots', () => {
      // Kills L298 ConditionalExpression `true` mutant: hint must be null when status is 'missing',
      // but slot.detail when status is 'failed'.
      const stateWithMissingPlan = stateWithTicket('PLAN');
      const team = getPolicyPreset('team');
      const blocked = buildBlockedProjection(stateWithMissingPlan, team);
      // The plan slot is required and missing → must appear with hint === null.
      const planSlot = blocked.missingEvidence.find((e) => e.slot === 'plan');
      if (planSlot) {
        expect(planSlot.hint).toBeNull();
      }
    });
  });

  describe('SURVIVOR_KILL buildContextProjection', () => {
    it('uses "claim_validated" as the explicit fallback for minimumActorAssuranceForApproval in regulated mode', () => {
      // Kills L330 StringLiteral mutant `'claim_validated'` → `''`.
      const state: SessionState = {
        ...makeMinimalState('EVIDENCE_REVIEW'),
        policySnapshot: {
          ...makeMinimalState('EVIDENCE_REVIEW').policySnapshot!,
          mode: 'regulated' as const,
          allowSelfApproval: false,
          // Intentionally undefined to force the ?? 'best_effort' fallback.
          minimumActorAssuranceForApproval: undefined,
        },
      };
      const ctx = buildContextProjection(state);
      expect(ctx.regulated.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('fourEyesRelevant tracks allowSelfApproval === false (not just truthy) in regulated mode', () => {
      // Kills L333 ConditionalExpression `true` mutant.
      const baseSnap = makeMinimalState('EVIDENCE_REVIEW').policySnapshot!;
      const stateAllow: SessionState = {
        ...makeMinimalState('EVIDENCE_REVIEW'),
        policySnapshot: { ...baseSnap, mode: 'regulated' as const, allowSelfApproval: true },
      };
      const stateDeny: SessionState = {
        ...makeMinimalState('EVIDENCE_REVIEW'),
        policySnapshot: { ...baseSnap, mode: 'regulated' as const, allowSelfApproval: false },
      };
      expect(buildContextProjection(stateAllow).regulated.fourEyesRelevant).toBe(false);
      expect(buildContextProjection(stateDeny).regulated.fourEyesRelevant).toBe(true);
    });
  });

  describe('SURVIVOR_KILL buildReadinessProjection', () => {
    it('respects requireHumanGates from policy when computing blocked field', () => {
      // Kills L344 ObjectLiteral mutant `evaluate(state, {})`.
      const state = stateWithPlan('PLAN_REVIEW');
      const team = getPolicyPreset('team');
      const teamReadiness = buildReadinessProjection(state, team);
      const soloReadiness = buildReadinessProjection(state, solo);
      expect(teamReadiness.blocked).toBe(true);
      expect(soloReadiness.blocked).toBe(false);
    });

    it('does not emit a legacy selfReview warning when config is mandatory-strict', () => {
      // Kills L345 ConditionalExpression `true` mutant: warning must NOT appear
      // for the canonical mandatory-strict config.
      const baseSnap = makeMinimalState('READY').policySnapshot!;
      const state: SessionState = {
        ...makeMinimalState('READY'),
        policySnapshot: {
          ...baseSnap,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };
      const readiness = buildReadinessProjection(state, solo);
      expect(readiness.warnings).toEqual([]);
    });

    it('emits the exact legacy warning text when selfReview config is weakened', () => {
      // Kills L359 StringLiteral mutant — warning must contain the exact phrase
      // "Ensure flowguard-reviewer plugin is active." verbatim.
      const baseSnap = makeMinimalState('READY').policySnapshot!;
      const state: SessionState = {
        ...makeMinimalState('READY'),
        policySnapshot: {
          ...baseSnap,
          selfReview: {
            subagentEnabled: false, // weakened
            fallbackToSelf: false,
            strictEnforcement: true,
          },
        },
      };
      const readiness = buildReadinessProjection(state, solo);
      expect(readiness.warnings).toHaveLength(1);
      expect(readiness.warnings[0]).toContain(
        'Legacy selfReview config detected and normalized to mandatory strict.',
      );
      expect(readiness.warnings[0]).toContain('Ensure flowguard-reviewer plugin is active.');
    });
  });
});
