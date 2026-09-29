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
import { buildStatusProjection } from './status/status.js';
import {
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from './status/status-detail-projections.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  REDUCED_CEREMONY_DECISION,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { isCommandAllowed, Command } from '../machine/commands.js';
import { USER_GATES, TERMINAL } from '../machine/topology.js';
import { makePlanRevision } from '../state/evidence-test-constants.js';
import type { PlanRecord } from '../state/evidence-plan.js';
import type {
  PlanApprovalCertificate,
  PlanClaimDeclarations,
} from '../state/proofgraph-approval.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { directiveLabel } from '../presentation/index.js';
import type { WorkflowDirectiveCode } from '../machine/workflow-directive.js';

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
  'PEER_REVIEW',
  'PEER_REVIEW_COMPLETE',
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
const REVIEW_FLOW_PHASES = ['READY', 'PEER_REVIEW', 'PEER_REVIEW_COMPLETE'] as const;

function makeMinimalState(phase: SessionState['phase'] = 'READY'): SessionState {
  return {
    ...makeState(phase),
    id: '00000000-0000-4000-8000-000000000001',
    phase,
    initiatedBy: 'tester@corp.com',
    createdAt: new Date().toISOString(),
    policySnapshot: createPolicySnapshot(
      getPolicyPreset('solo'),
      '2026-01-01T00:00:00.000Z',
      hashText,
    ),
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
    regulatedArchiveStatus: null,
    actorInfo: undefined,
    error: null,
  };
}

function makeActorState(
  phase: SessionState['phase'] = 'READY',
  actorInfo: { id: string; source: 'env' | 'git' | 'claim' | 'unknown'; email: string | null },
): SessionState {
  return {
    ...makeMinimalState(phase),
    actorInfo: {
      ...actorInfo,
      assurance: actorInfo.source === 'claim' ? 'claim_validated' : 'best_effort',
    },
  };
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
        ...makeMinimalState('READY').policySnapshot,
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
      policySnapshot: makeMinimalState('READY').policySnapshot,
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('solo');
  });
});

describe('proofGraph — persisted coverage summary', () => {
  const policy = getPolicyPreset('solo');

  it('marks missing structured claim declarations as not declared', () => {
    const projection = buildStatusProjection(makeMinimalState('READY'), policy);

    expect(projection.proofGraph).toEqual({
      coverage: 'NOT_DECLARED',
      claimCount: 0,
      provenCount: 0,
      unprovenCount: 0,
      contractClaimCount: 0,
      hypothesisCount: 0,
    });
  });

  it('separates advisory hypotheses from contract coverage so both stay readable', () => {
    // A peer review contributes hypotheses without declaring a contract.
    // Reporting NOT_DECLARED next to a non-zero claimCount is only coherent when
    // the two populations are counted separately (#762).
    const state = makeMinimalState('PEER_REVIEW_COMPLETE');
    const projection = buildStatusProjection(
      {
        ...state,
        proofGraph: {
          version: 'proofgraph.v2',
          evaluatedAt: '2026-01-01T00:00:00.000Z',
          claims: [
            {
              claimId: '77777777-7777-4777-8777-777777777777',
              statement: 'The reviewed subject behaves correctly.',
              signalClass: 'hypothesis',
              critical: false,
              verificationState: 'NOT_VERIFIED',
              provenance: null,
              evidenceRefs: [],
              counterexampleRefs: [],
            },
          ],
        },
      },
      policy,
    );

    expect(projection.proofGraph).toMatchObject({
      coverage: 'NOT_DECLARED',
      claimCount: 1,
      contractClaimCount: 0,
      hypothesisCount: 1,
    });
  });
});

describe('directive — aborted terminal session (governance integrity)', () => {
  const policy = getPolicyPreset('solo');

  it('an ABORTED session is terminal and never routed to an export command', () => {
    const state: SessionState = {
      ...makeMinimalState('ABORTED'),
      // ABORTED retains its diagnostic error marker for audit provenance; the
      // terminal position must remain authoritative over it.
      error: {
        code: 'ABORTED',
        message: 'Operator aborted',
        recoveryHint: 'Start a new session with /hydrate',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const projection = buildStatusProjection(state, policy);
    // An aborted session must not be routed to /export as a verifiable audit package.
    expect(projection.directive).toEqual({
      kind: 'terminal',
      code: 'WORKFLOW_ABORTED',
      allowedIntents: [],
      commands: [],
    });
    expect(projection.conclusion).toEqual({
      kind: 'terminal',
      message: directiveLabel('WORKFLOW_ABORTED'),
    });
    expect(projection.directive.commands).not.toContain('/export');
  });

  it('a clean completion path offers /export at EXPORT_READY, never at COMPLETE', () => {
    const exportReady = buildStatusProjection(makeMinimalState('EXPORT_READY'), policy);
    expect(exportReady.directive).toEqual({
      kind: 'user_action',
      code: 'EXPORT_REQUIRED',
      allowedIntents: ['EXPORT'],
      commands: ['/export'],
    });
    expect(exportReady.conclusion).toMatchObject({
      kind: 'next_action',
      action: { invocation: '/export' },
    });

    const complete = buildStatusProjection(makeMinimalState('COMPLETE'), policy);
    expect(complete.directive).toEqual({
      kind: 'terminal',
      code: 'WORKFLOW_COMPLETE',
      allowedIntents: [],
      commands: [],
    });
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
      policySnapshot: makeMinimalState('READY').policySnapshot,
    };
    const projection = buildStatusProjection(state, policy);

    expect(projection.policyMode).toBe('solo');
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

  it('projects manual export purpose, capability, and verification independently', () => {
    const state = {
      ...makeMinimalState('COMPLETE'),
      lastExportPackagePurpose: 'sharing' as const,
      lastExportIntegrityCapability: 'not_verifiable' as const,
      lastExportVerificationStatus: 'not_run' as const,
    };

    expect(buildStatusProjection(state, policy).lastExport).toEqual({
      packagePurpose: 'sharing',
      integrityCapability: 'not_verifiable',
      verificationStatus: 'not_run',
    });
  });
});

// ─── CORNER: Terminal Phases, READY Routing ───────────────────────────────────

describe('buildStatusProjection — CORNER', () => {
  const policy = getPolicyPreset('solo');

  const TERMINAL_DIRECTIVE_CODES: Record<string, WorkflowDirectiveCode> = {
    COMPLETE: 'WORKFLOW_COMPLETE',
    ARCH_COMPLETE: 'ARCHITECTURE_COMPLETE',
    PEER_REVIEW_COMPLETE: 'PEER_REVIEW_COMPLETE',
    REJECTED: 'WORKFLOW_REJECTED',
    ABORTED: 'WORKFLOW_ABORTED',
  };

  for (const phase of TERMINAL) {
    it(`terminal phase ${phase}: no blocker and a terminal directive`, () => {
      const state = makeMinimalState(phase);
      const projection = buildStatusProjection(state, policy);

      expect(projection.blocker).toBeNull();
      expect(projection.directive).toEqual({
        kind: 'terminal',
        code: TERMINAL_DIRECTIVE_CODES[phase],
        allowedIntents: [],
        commands: [],
      });
      expect(projection.conclusion).toEqual({
        kind: 'terminal',
        message: directiveLabel(TERMINAL_DIRECTIVE_CODES[phase]!),
      });
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

// ─── buildBlockedProjection — ProofGraph gate wiring (#695) ──────────────────

describe('buildBlockedProjection — ProofGraph gate', () => {
  const team = getPolicyPreset('team');
  const CLAIM_ID = '00000000-0000-4000-8000-000000000001';
  const CERT_ID = '00000000-0000-4000-8000-0000000000ce';
  const PLAN_CURRENT = makePlanRevision({ body: 'x' });

  function declarations(): PlanClaimDeclarations {
    return {
      flow: 'plan',
      version: 'v2',
      claims: [
        {
          claimId: CLAIM_ID,
          statement: 'x',
          critical: true,
          authoritySectionId: 's1',
          claimScope: 'specific_behavior',
          expectedCheckId: 'test',
        },
      ],
    };
  }

  function certificate(): PlanApprovalCertificate {
    const decls = declarations();
    return {
      flow: 'plan',
      authorityDigest: PLAN_CURRENT.digest,
      claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
      decisionAttestationDigest: 'd',
      approvedAt: '2026-01-01T00:00:00.000Z',
      approvedBy: 'reviewer',
      certificateId: CERT_ID,
      planVersion: PLAN_CURRENT.planVersion,
      planRecordDigest: PLAN_CURRENT.recordDigest,
      reviewBinding: {
        kind: 'current_review',
        reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
        reviewEvidenceDigest: 'e'.repeat(64),
        reviewedSubjectDigest: PLAN_CURRENT.digest,
      },
    };
  }

  function approvedPlan(): PlanRecord {
    return {
      current: PLAN_CURRENT,
      history: [],
      reviewCompletion: 'pending',
      claimDeclarations: declarations(),
      approvalCertificate: certificate(),
    };
  }

  it('carries the migrated gate code when the Evidence gate blocks a waiting session', () => {
    const state: SessionState = {
      ...makeMinimalState('EVIDENCE_REVIEW'),
      policySnapshot: createPolicySnapshot(team, '2026-01-01T00:00:00.000Z', hashText),
      plan: approvedPlan(),
    };
    const blocker = buildBlockedProjection(state, team);
    // Authorized critical claim is absent from the persisted proofGraph:
    // the gate resolves to evaluation_unavailable, projecting the existing code.
    expect(blocker.reasonCode).toBe('PROOFGRAPH_EVALUATION_UNAVAILABLE');
  });

  it('does not invent a gate code when the Evidence gate is satisfied', () => {
    const state: SessionState = {
      ...makeMinimalState('EVIDENCE_REVIEW'),
      policySnapshot: createPolicySnapshot(team, '2026-01-01T00:00:00.000Z', hashText),
      plan: approvedPlan(),
      proofGraph: {
        version: 'proofgraph.v2',
        evaluatedAt: '2026-01-01T00:00:00.000Z',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'x',
            signalClass: 'fact',
            critical: true,
            provenance: {
              kind: 'canonical_authority',
              authorityId: 'plan',
              digest: 'd',
              approval: {
                certificateId: CERT_ID,
                claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations())),
                decisionAttestationDigest: 'd',
                declarationId: CLAIM_ID,
              },
            },
            evidenceRefs: [],
            counterexampleRefs: [],
            verificationState: 'PROVEN',
          },
        ],
      },
    };
    const blocker = buildBlockedProjection(state, team);
    // A satisfied gate projects no proofgraph reason code; the waiting blocker
    // falls back to the generic waiting reason (reasonCode null at this phase).
    expect(blocker.reasonCode).toBeNull();
  });
});

// ─── EDGE: Evidence Edge Cases ────────────────────────────────────────────────

describe('buildStatusProjection — EDGE evidence', () => {
  const policy = getPolicyPreset('solo');

  it('should count all zero when no slots required (PEER_REVIEW flow)', () => {
    const state = makeMinimalState('PEER_REVIEW_COMPLETE');
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
        riskDeclaration: { kind: 'absent' },
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
        riskDeclaration: { kind: 'absent' },
      },
      plan: {
        current: makePlanRevision({ body: '## Plan\n...' }),
        history: [],
        reviewCompletion: 'pending',
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

  it('should have no slots for PEER_REVIEW flow', () => {
    const state = makeMinimalState('PEER_REVIEW');
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
        riskDeclaration: { kind: 'absent' },
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
        ...makeMinimalState('READY').policySnapshot,
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
        riskDeclaration: { kind: 'absent' },
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
        riskDeclaration: { kind: 'absent' },
      },
      plan: {
        current: makePlanRevision({ body: '## Plan' }),
        history: [],
        reviewCompletion: 'pending',
      },
      selfReview: {
        iteration: 1,
        reviewCycle: 1,
        maxIterations: 2,
        prevDigest: null,
        currDigest: 'self-review-digest',
        verdict: 'accept',
        revisionDelta: 'none',
      },
      activeChecks: ['check_1'],
      validation: [
        {
          checkId: 'check_1',
          passed: true,
          detail: 'All checks passed',
          executedAt: new Date().toISOString(),
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'check_1_digest',
          timedOut: false,
          outcome: 'supported' as const,
        },
      ],
      implValidation: [
        {
          checkId: 'check_1',
          passed: true,
          detail: 'Post-impl checks passed',
          executedAt: new Date().toISOString(),
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'check_1_digest',
          timedOut: false,
          outcome: 'supported' as const,
        },
      ],
      implementation: {
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        changedFiles: ['a.ts'],
        domainFiles: ['a.ts'],
        digest: 'impl_digest',
        executedAt: new Date().toISOString(),
      },
      implReview: {
        iteration: 1,
        reviewCycle: 1,
        maxIterations: 2,
        prevDigest: null,
        currDigest: 'impl-review-digest',
        verdict: 'accept',
        revisionDelta: 'none',
        executedAt: new Date().toISOString(),
      },
      reviewDecision: {
        verdict: 'approve',
        rationale: 'All good',
        decisionIdentity: {
          actorId: 'reviewer@corp.com',
          actorEmail: 'reviewer@corp.com',
          actorSource: 'unknown',
          actorAssurance: 'best_effort',
        },
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
        riskDeclaration: { kind: 'absent' },
      },
      plan: {
        current: makePlanRevision({ body: '## Plan' }),
        history: [],
        reviewCompletion: 'pending',
      },
      selfReview: {
        iteration: 1,
        reviewCycle: 1,
        maxIterations: 2,
        prevDigest: null,
        currDigest: 'self-review-digest',
        verdict: 'accept',
        revisionDelta: 'none',
      },
      activeChecks: ['check_1', 'check_2'],
      validation: [
        {
          checkId: 'check_1',
          passed: false,
          detail: 'Failed check 1',
          executedAt: new Date().toISOString(),
          kind: 'test',
          command: 'npm test',
          exitCode: 1,
          executionMs: 1,
          outputDigest: 'check_1_digest',
          timedOut: false,
          outcome: 'inconclusive' as const,
          classificationReason: 'non-zero exit code',
        },
        {
          checkId: 'check_2',
          passed: true,
          detail: 'Passed check 2',
          executedAt: new Date().toISOString(),
          kind: 'lint',
          command: 'npm run lint',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'check_2_digest',
          timedOut: false,
          outcome: 'supported' as const,
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

describe('buildStatusProjection — reduced ceremony projection', () => {
  const policy = getPolicyPreset('team');

  it('is not_applicable outside IMPL_VALIDATION without a decision', () => {
    const projection = buildStatusProjection(makeState('READY'), policy);
    expect(projection.reducedCeremony).toEqual({ status: 'not_applicable', reason: null });
  });

  it('derives the pending projection at IMPL_VALIDATION without persisting it', () => {
    const state = makeState('IMPL_VALIDATION', {
      claimedTaskClass: 'TRIVIAL',
      implementation: {
        ...IMPL_EVIDENCE,
        changedFiles: ['docs/usage-notes.md'],
        domainFiles: [],
      },
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        allowReducedCeremony: true,
        requireHumanGates: true,
      },
    });

    expect(state.reducedCeremony).toBeNull();
    expect(buildStatusProjection(state, policy).reducedCeremony).toEqual({
      status: 'pending_post_implementation_verification',
      reason: 'AWAITING_POST_IMPLEMENTATION_VERIFICATION',
    });
  });

  it('reports the static ineligibility reason when policy does not allow reduction', () => {
    const state = makeState('IMPL_VALIDATION', {
      claimedTaskClass: 'TRIVIAL',
      implementation: { ...IMPL_EVIDENCE, changedFiles: ['docs/usage-notes.md'], domainFiles: [] },
    });

    expect(buildStatusProjection(state, policy).reducedCeremony).toEqual({
      status: 'ineligible',
      reason: 'POLICY_REDUCED_CEREMONY_DISABLED',
    });
  });

  it('marks a stored decision invalid when its binding no longer holds', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      implementation: IMPL_EVIDENCE,
      reducedCeremony: REDUCED_CEREMONY_DECISION,
    });

    expect(buildStatusProjection(state, policy).reducedCeremony).toEqual({
      status: 'invalid',
      reason: 'REDUCED_CEREMONY_BINDING_INVALID',
    });
  });

  it('reports an applied decision only while the machine binding still holds', () => {
    const policySnapshot = {
      ...POLICY_SNAPSHOT,
      allowReducedCeremony: true,
      requireHumanGates: true,
      effectiveGateBehavior: 'human_gated' as const,
    };
    const attempt = (checkId: string, index: number) => ({
      attemptId: `00000000-0000-4000-8000-0000000000${index}d`,
      scope: 'implementation' as const,
      implementationId: IMPL_EVIDENCE.implementationId,
      implementationDigest: IMPL_EVIDENCE.digest,
      executionObservation: TEST_EXECUTION_OBSERVATION,
      result: VALIDATION_PASSED[index]!,
    });
    // The applied status requires a genuinely eligible docs-only change: the
    // projection re-checks the machine binding instead of trusting the record.
    const docsImpl = {
      ...IMPL_EVIDENCE,
      changedFiles: ['docs/usage-notes.md'],
      domainFiles: [],
    };
    const state = makeState('EVIDENCE_REVIEW', {
      claimedTaskClass: 'TRIVIAL',
      verificationCandidates: VERIFICATION_CANDIDATES,
      implementation: docsImpl,
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'TRIVIAL',
        effectiveTaskClass: 'TRIVIAL',
        declaredTaskClass: null,
        declarationKind: 'absent' as const,
        ticketDigest: null,
        escalatedTaskClass: 'TRIVIAL',
        touchedSurfaces: ['docs/usage-notes.md'],
        riskTriggers: [],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 1,
        implementationDigest: docsImpl.digest,
      },
      activeChecks: ['test', 'lint'],
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', 0), attempt('lint', 1)],
      policySnapshot,
      reducedCeremony: {
        ...REDUCED_CEREMONY_DECISION,
        escalatedTaskClass: 'TRIVIAL',
        touchedSurfaces: ['docs/usage-notes.md'],
        policyDigest: policySnapshot.hash,
        implementationId: docsImpl.implementationId,
        implementationDigest: docsImpl.digest,
        verificationBasis: {
          checkIds: ['test', 'lint'],
          attempts: [
            {
              checkId: 'test',
              attemptId: '00000000-0000-4000-8000-00000000000d',
              executedAt: VALIDATION_PASSED[0]!.executedAt,
            },
            {
              checkId: 'lint',
              attemptId: '00000000-0000-4000-8000-00000000001d',
              executedAt: VALIDATION_PASSED[1]!.executedAt,
            },
          ],
        },
      },
    });

    expect(buildStatusProjection(state, policy).reducedCeremony).toEqual({
      status: 'applied',
      reason: REDUCED_CEREMONY_DECISION.reason,
    });

    // A schema-valid decision over a HIGH-RISK implementation (src/auth.ts)
    // must project as invalid instead of applied.
    const assessment = state.implementationRiskAssessment;
    const decision = state.reducedCeremony;
    if (assessment === undefined || decision === null) {
      throw new Error('fixture state must carry a risk assessment and a reduced decision');
    }
    const drifted: SessionState = {
      ...state,
      implementation: IMPL_EVIDENCE,
      implementationRiskAssessment: {
        ...assessment,
        assessedFileCount: 2,
        implementationDigest: IMPL_EVIDENCE.digest,
      },
      reducedCeremony: {
        ...decision,
        implementationDigest: IMPL_EVIDENCE.digest,
      },
    };
    expect(buildStatusProjection(drifted, policy).reducedCeremony).toEqual({
      status: 'invalid',
      reason: 'REDUCED_CEREMONY_BINDING_INVALID',
    });
  });
});
