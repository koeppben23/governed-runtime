/**
 * @module integration/finish-card.test
 * @description Tests for the read-only Finish Card projection (#520).
 *
 * Contract under test:
 *   /finish is a thin, read-only presentation wrapper. buildFinishCard MUST
 *   compose the existing authorities (buildReadinessProjection,
 *   buildEvidenceDetailProjection, resolveWorkflowDirective,
 *   projectFinishReviewCaveats) and add only the single presentation classifier
 *   deriveFinishOverallStatus. It performs NO independent evidence/gate
 *   evaluation, never mutates state, and never renders an exit option as
 *   forbidden.
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
import type { ReviewReport, ReviewReportFinding } from '../state/evidence.js';
import {
  buildReadinessProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
} from './status.js';
import { buildFinishCard, deriveFinishOverallStatus } from './status-finish.js';
import { getPolicyPreset } from '../config/policy.js';
import { resolveWorkflowDirective } from '../machine/workflow-directive.js';
import { makeProgressedState } from '../fixtures.js';

const policy = getPolicyPreset('solo');
const blockedPolicy = getPolicyPreset('team');

/**
 * Lifecycle reports cannot carry material findings by schema — only
 * `content_review` reports can. The projection tests must use schema-valid
 * fixtures so they prove real persisted-report behavior.
 */
type LifecycleFinding = Exclude<ReviewReport['findings'][number], { source: 'material_finding' }>;

const PEER_REVIEW_COVERAGE = {
  targetResolved: false,
  targetFrozen: false,
  repositoryIdentityVerified: null,
  baseSha: null,
  headSha: null,
  changedPathCount: 0,
  objectivesCovered: 0,
  objectivesTotal: 0,
  reviewAssurance: null,
  missingVerification: [],
};

function makeReviewReport(
  overallStatus: ReviewReport['overallStatus'],
  findings: readonly LifecycleFinding[] = [],
): Extract<ReviewReport, { reviewKind: 'lifecycle_review' }> {
  return {
    reviewKind: 'lifecycle_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'PEER_REVIEW_COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    findings: [...findings],
    overallStatus,
    peerReviewCoverage: PEER_REVIEW_COVERAGE,
  };
}

/** Content reviews are the only report kind that can carry material findings. */
function makeContentReviewReport(
  findings: readonly ReviewReportFinding[],
): Extract<ReviewReport, { reviewKind: 'content_review' }> {
  return {
    reviewKind: 'content_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'PEER_REVIEW_COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'b'.repeat(64),
      lineCount: 1,
    },
    findings: [...findings],
    overallStatus: 'warnings',
    peerReviewCoverage: PEER_REVIEW_COVERAGE,
  };
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

  it('reports IN_PROGRESS for non-terminal phases with complete evidence', () => {
    // PLAN has ticket+plan complete; IMPLEMENTATION has ticket+plan+self-review+
    // decision+validation; both are non-terminal with complete required evidence.
    for (const phase of ['PLAN', 'IMPLEMENTATION'] as const) {
      const card = buildFinishCard(makeProgressedState(phase), policy);
      expect(card.overallStatus, `${phase} must not be READY`).not.toBe('READY');
      expect(card.overallStatus, `${phase} must be IN_PROGRESS`).toBe('IN_PROGRESS');
    }
  });

  it('reports READY at EXPORT_READY, never IN_PROGRESS', () => {
    // EXPORT_READY is the explicit completion gate: the canonical directive
    // requires `/export`. Reporting IN_PROGRESS (with "export is not
    // applicable") would contradict the directive.
    const state = makeProgressedState('EXPORT_READY');
    const card = buildFinishCard(state, policy);
    expect(card.phase).toBe('EXPORT_READY');
    expect(card.directive.code).toBe('EXPORT_REQUIRED');
    expect(card.directive.commands).toEqual(['/export']);
    expect(card.overallStatus).toBe('READY');
    // Directive-aware guidance: /export is the required completion commit, so
    // "create PR" must not be presented as an equal alternative.
    expect(
      card.actionGuidance.find((guidance) => guidance.action === 'export evidence'),
    ).toMatchObject({ status: 'recommended' });
    expect(
      card.actionGuidance.find((guidance) => guidance.action === 'export evidence')?.reason,
    ).toContain('/export');
    expect(card.actionGuidance.find((guidance) => guidance.action === 'create PR')).toMatchObject({
      status: 'not_recommended',
    });
    expect(card.actionGuidance.find((guidance) => guidance.action === 'keep branch')).toMatchObject(
      {
        status: 'not_recommended',
      },
    );
  });

  it('does not invent a stale evidence status (not_yet_required never NOT_VERIFIED)', () => {
    // deriveFinishOverallStatus must only react to missing/failed required slots.
    const readiness = {
      blocked: false,
      warnings: [],
      phase: 'COMPLETE',
    } as unknown as ReturnType<typeof buildReadinessProjection>;
    const evidence = {
      slots: [{ required: false, status: 'not_yet_required' }],
    } as unknown as ReturnType<typeof buildEvidenceDetailProjection>;
    expect(deriveFinishOverallStatus(readiness, evidence)).toBe('READY');
  });

  it('CHANGES_REQUIRED when a completed peer review reports issues', () => {
    const state = makeProgressedState('PEER_REVIEW_COMPLETE');
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

  it('directive equals resolveWorkflowDirective verbatim', () => {
    expect(buildFinishCard(state, policy).directive).toEqual(resolveWorkflowDirective(state));
    expect(buildFinishCard(state, policy).directive.commands[0] ?? null).toBe(
      resolveWorkflowDirective(state).commands[0] ?? null,
    );
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
  for (const phase of ['COMPLETE', 'ARCH_COMPLETE', 'PEER_REVIEW_COMPLETE'] as const) {
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

// ─── REVIEW CAVEATS: pure projection of persisted ReviewReport truth ────────

const MATERIAL_FINDING: ReviewReportFinding = {
  source: 'material_finding',
  reportSeverity: 'error',
  finding: {
    severity: 'major',
    category: 'correctness',
    message: 'Material issue must not appear at /finish',
    relation: {
      subjectAnchors: [
        {
          kind: 'repository_location',
          location: { path: 'src/foo.ts', revision: 'head', line: 1 },
        },
      ],
      evidenceLocations: [],
    },
  },
};

describe('buildFinishCard — review caveats', () => {
  it('projects only missing_verification and unknown from a lifecycle report', () => {
    const report = makeReviewReport('warnings', [
      {
        source: 'scope_creep',
        reportSeverity: 'warning',
        category: 'scope-creep',
        message: 'Scope grew',
      },
      {
        source: 'mechanical',
        reportSeverity: 'warning',
        category: 'correctness',
        message: 'Mechanical note',
      },
      {
        source: 'challenge',
        reportSeverity: 'warning',
        category: 'challenge',
        message: 'Challenge note',
      },
      {
        source: 'missing_verification',
        reportSeverity: 'warning',
        category: 'missing-verification',
        message: 'Could not verify the failure path',
      },
      {
        source: 'unknown',
        reportSeverity: 'info',
        category: 'unknown',
        message: 'Unknown dependency surface',
      },
    ]);

    const card = buildFinishCard(makeProgressedState('PEER_REVIEW_COMPLETE'), policy, report);
    expect(card.reviewCaveats).toEqual([
      { source: 'missing_verification', message: 'Could not verify the failure path' },
      { source: 'unknown', message: 'Unknown dependency surface' },
    ]);
  });

  it('excludes material findings from a content review report', () => {
    const report = makeContentReviewReport([
      MATERIAL_FINDING,
      {
        source: 'missing_verification',
        reportSeverity: 'warning',
        category: 'missing-verification',
        message: 'Could not verify the failure path',
      },
      {
        source: 'unknown',
        reportSeverity: 'info',
        category: 'unknown',
        message: 'Unknown dependency surface',
      },
    ]);

    const card = buildFinishCard(makeProgressedState('PEER_REVIEW_COMPLETE'), policy, report);
    expect(card.reviewCaveats).toEqual([
      { source: 'missing_verification', message: 'Could not verify the failure path' },
      { source: 'unknown', message: 'Unknown dependency surface' },
    ]);
    expect(card.reviewCaveats.some((c) => c.message === MATERIAL_FINDING.finding.message)).toBe(
      false,
    );
  });

  it('is empty without a report and for reports without caveat sources', () => {
    expect(buildFinishCard(makeProgressedState('COMPLETE'), policy).reviewCaveats).toEqual([]);
    expect(
      buildFinishCard(makeProgressedState('COMPLETE'), policy, makeReviewReport('warnings'))
        .reviewCaveats,
    ).toEqual([]);
    expect(
      buildFinishCard(
        makeProgressedState('COMPLETE'),
        policy,
        makeReviewReport('warnings', [
          {
            source: 'scope_creep',
            reportSeverity: 'warning',
            category: 'scope-creep',
            message: 'Scope grew',
          },
        ]),
      ).reviewCaveats,
    ).toEqual([]);
  });

  it('skips whitespace-only messages without transforming preserved text', () => {
    const report = makeReviewReport('warnings', [
      {
        source: 'missing_verification',
        reportSeverity: 'warning',
        category: 'missing-verification',
        message: '   ',
      },
      {
        source: 'unknown',
        reportSeverity: 'info',
        category: 'unknown',
        message: '  trailing space kept  ',
      },
    ]);

    const card = buildFinishCard(makeProgressedState('PEER_REVIEW_COMPLETE'), policy, report);
    expect(card.reviewCaveats).toEqual([{ source: 'unknown', message: '  trailing space kept  ' }]);
  });

  it('does not couple caveats to FinishOverallStatus semantics', () => {
    // A missing_verification caveat is a reviewer statement, not evidence
    // completeness: it must never derive NOT_VERIFIED on its own.
    const complete = buildFinishCard(
      makeProgressedState('COMPLETE'),
      policy,
      makeReviewReport('warnings', [
        {
          source: 'missing_verification',
          reportSeverity: 'warning',
          category: 'missing-verification',
          message: 'Could not verify the failure path',
        },
      ]),
    );
    expect(complete.overallStatus).toBe('READY');
    expect(complete.reviewCaveats).toHaveLength(1);

    // Issues stay CHANGES_REQUIRED; the caveat merely remains visible.
    const issues = buildFinishCard(
      makeProgressedState('PEER_REVIEW_COMPLETE'),
      policy,
      makeReviewReport('issues', [
        {
          source: 'unknown',
          reportSeverity: 'info',
          category: 'unknown',
          message: 'Unknown dependency surface',
        },
      ]),
    );
    expect(issues.overallStatus).toBe('CHANGES_REQUIRED');
    expect(issues.reviewCaveats).toEqual([
      { source: 'unknown', message: 'Unknown dependency surface' },
    ]);
  });
});
