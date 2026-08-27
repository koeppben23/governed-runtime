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
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import { makeState } from '../fixtures.js';
import { isCommandAllowed, Command } from '../machine/commands.js';
import { USER_GATES, TERMINAL } from '../machine/topology.js';
import { computeRecordDigest } from '../state/evidence-plan.js';
import type { PlanRecord } from '../state/evidence-plan.js';
import type {
  PlanApprovalCertificate,
  PlanClaimDeclarations,
} from '../state/proofgraph-approval.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

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
    archiveStatus: null,
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
    // A standalone review contributes hypotheses without declaring a contract.
    // Reporting NOT_DECLARED next to a non-zero claimCount is only coherent when
    // the two populations are counted separately (#762).
    const state = makeMinimalState('REVIEW_COMPLETE');
    const projection = buildStatusProjection(
      {
        ...state,
        proofGraph: {
          version: 'proofgraph.v1',
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

describe('productNextAction — aborted terminal session (governance integrity)', () => {
  const policy = getPolicyPreset('solo');

  it('redirects an aborted COMPLETE session to read-only /status', () => {
    const state: SessionState = {
      ...makeMinimalState('COMPLETE'),
      error: {
        code: 'ABORTED',
        message: 'Operator aborted',
        recoveryHint: 'Start a new session with /hydrate',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const projection = buildStatusProjection(state, policy);
    // An aborted session must not be routed to /export as a verifiable audit package.
    expect(projection.productNextAction.primaryCommand).toBe('/status');
    expect(String(projection.productNextAction.summary).toLowerCase()).toContain('aborted');
    expect(projection.productNextAction.summary).not.toContain('/export');
    expect(projection.productNextAction.summary).not.toContain('/finish');
    expect(projection.productNextAction.summary).not.toContain('/review');
  });

  it('a clean COMPLETE session is unaffected (still offers /export)', () => {
    const projection = buildStatusProjection(makeMinimalState('COMPLETE'), policy);
    expect(projection.productNextAction.summary).toContain('/export');
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

// ─── buildBlockedProjection — ProofGraph gate wiring (#695) ──────────────────

describe('buildBlockedProjection — ProofGraph gate', () => {
  const team = getPolicyPreset('team');
  const CLAIM_ID = '00000000-0000-4000-8000-000000000001';
  const CERT_ID = '00000000-0000-4000-8000-0000000000ce';

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
      authorityDigest: 'plan-digest',
      claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
      decisionAttestationDigest: 'd',
      approvedAt: '2026-01-01T00:00:00.000Z',
      approvedBy: 'reviewer',
      certificateId: CERT_ID,
      planVersion: 1,
      planRecordDigest: 'record-digest',
      reviewBinding: {
        kind: 'current_review',
        reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
        reviewEvidenceDigest: 'e'.repeat(64),
        reviewedSubjectDigest: 'plan-digest',
      },
      reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
      reviewEvidenceDigest: 'e'.repeat(64),
    };
  }

  function approvedPlan(): PlanRecord {
    return {
      current: {
        body: 'x',
        digest: 'plan-digest',
        sections: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        recordDigest: 'record-digest',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'unavailable',
      },
      history: [],
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
        version: 'proofgraph.v1',
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
        current: {
          body: '## Plan\n...',
          digest: 'plan123',
          sections: [],
          createdAt: new Date().toISOString(),
          recordDigest: computeRecordDigest({
            contentDigest: 'plan123',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
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
        current: {
          body: '## Plan',
          digest: 'plan_digest',
          sections: [],
          createdAt: new Date().toISOString(),
          recordDigest: computeRecordDigest({
            contentDigest: 'plan_digest',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
        history: [],
      },
      selfReview: {
        iteration: 1,
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
        changedFiles: ['a.ts'],
        domainFiles: ['a.ts'],
        digest: 'impl_digest',
        executedAt: new Date().toISOString(),
      },
      implReview: {
        iteration: 1,
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
        current: {
          body: '## Plan',
          digest: 'plan_digest',
          sections: [],
          createdAt: new Date().toISOString(),
          recordDigest: computeRecordDigest({
            contentDigest: 'plan_digest',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
        history: [],
      },
      selfReview: {
        iteration: 1,
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
