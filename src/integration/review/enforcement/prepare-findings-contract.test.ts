/**
 * @module integration/review/enforcement/prepare-findings-contract.test
 * @description Contract tests for the single raw→canonical reviewer-findings
 *              authority (prepare-findings.ts).
 *
 * The invariants pinned here close the two-stage boundary bug: raw reviewer
 * output (clientReference challenges) and the
 * canonical ReviewFindings DTO (host-minted challengeId, host provenance) were
 * previously validated by three separate raw parsers, so the transient
 * enforcement path reported phantom schema errors (challengeId) that the bind
 * gate never enforces. Every invariant below is a reviewer-actionable or
 * authority-boundary property that must hold for BOTH the bind path
 * (buildHostTaskEvidence) and the transient enforcement path (onTaskToolAfter /
 * isPendingCaptureUsable / enforceBeforeSubagentCall).
 *
 * @test-policy REGRESSION, EDGE, BAD — authority-boundary contract.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareReviewerFindingsForValidation,
  isPendingCaptureUsable,
} from './prepare-findings.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  matchPendingReview,
  enforceBeforeSubagentCall,
} from './enforcement.js';
import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './types.js';
import { buildHostTaskEvidence } from '../evidence-binding.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../assurance.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  pendingObligation,
  attemptFor,
  validPrompt,
} from '../../plugin-host-task-diagnostics-helpers.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';

const HOST_CONSTANTS = {
  mandateDigest: REVIEW_MANDATE_DIGEST,
  criteriaVersion: REVIEW_CRITERIA_VERSION,
};

const HOST_PROVENANCE = {
  childSessionId: CHILD_SESSION_ID,
  reviewedAt: NOW,
};

function contentChallenge(clientReference: string, digest = 'd'.repeat(64)) {
  return {
    clientReference,
    obligationId: OBLIGATION_ID,
    scenario: 'Falsification attempt scenario',
    claim: 'Claim under test',
    locations: ['src/a.ts'],
    kind: 'content_challenge',
    evidenceRefs: [{ kind: 'content', digest }],
    outcome: 'supported',
  };
}

/** Prompt-compliant reviewer input (clientReference, no host provenance). */
function baseRawFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    attestation: {
      toolObligationId: OBLIGATION_ID,
    },
    ...overrides,
  };
}

/** Signal WITHOUT host attestation but WITH an obligation identity. */
function signalWithoutAttestation(): string {
  return JSON.stringify({
    phase: 'PLAN',
    next: `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. iteration=0, planVersion=1.`,
    reviewAttemptId: `att-${OBLIGATION_ID}`,
    reviewObligationId: OBLIGATION_ID,
  });
}

/** Drive the real capture pipeline for a plan pending. */
function captureFor(
  state: ReturnType<typeof createSessionState>,
  rawFindings: Record<string, unknown>,
) {
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
    JSON.stringify(rawFindings),
    LATER,
    { metadata: { sessionId: CHILD_SESSION_ID } },
  );
}

/** Remove all host-owned fields for input/persisted semantic comparison. */
function stripHostOwned(input: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  delete clone.reviewedBy;
  delete clone.reviewedAt;
  delete clone.reviewerClaimedAt;
  delete clone.reviewerClaimedBy;
  if (clone.attestation && typeof clone.attestation === 'object') {
    const attestation = clone.attestation as Record<string, unknown>;
    delete attestation.mandateDigest;
    delete attestation.criteriaVersion;
    delete attestation.iteration;
    delete attestation.planVersion;
    delete attestation.reviewedBy;
  }
  if (Array.isArray(clone.challenges)) {
    for (const challenge of clone.challenges as Record<string, unknown>[]) {
      delete challenge.challengeId;
      delete challenge.obligationId;
    }
  }
  return clone;
}

describe('prepareReviewerFindingsForValidation — raw/canonical boundary', () => {
  it('invariant 1: prompt-conform challenge without challengeId prepares ok with host-minted identity', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('c1')] });
    const result = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError('expected ok');
    const challenges = result.findings.challenges as Record<string, unknown>[];
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(challenges[0]!.obligationId).toBe(OBLIGATION_ID);
    expect(challenges[0]!.clientReference).toBe('c1');
  });

  it('invariant 1b: content challenge input normalizes to canonical host-minted identity', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('content-1')] });
    const result = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError('expected ok');
    expect(result.findings.challenges).toMatchObject([
      { kind: 'content_challenge', obligationId: OBLIGATION_ID, clientReference: 'content-1' },
    ]);
    expect((result.findings.challenges as Array<Record<string, unknown>>)[0]!.challengeId).toMatch(
      /^[0-9a-f]{8}-/i,
    );
  });

  it('invariant 2: stray key inside RepositoryLocation is exactly one actionable schema error', () => {
    const raw = baseRawFindings({
      majorRisks: [
        {
          severity: 'minor',
          category: 'risk',
          message: 'stray-key fixture',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location',
                location: { path: 'src/a.ts', revision: 'head', line: 1, reviewedBy: 'stray' },
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    });
    const result = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new TypeError('expected rejection');
    expect(result.code).toBe('schema_invalid');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.startsWith('majorRisks.0.relation.subjectAnchors.0.location')).toBe(
      true,
    );
  });

  it('invariant 3a: enforcement repair errors are structurally the bind rejection errors', () => {
    const raw = baseRawFindings({
      majorRisks: [
        {
          severity: 'minor',
          category: 'risk',
          message: 'stray-key fixture',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location',
                location: { path: 'src/a.ts', revision: 'head', line: 1, reviewedBy: 'stray' },
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    });
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      NOW,
    );
    captureFor(state, raw);
    const pending = [...state.pendingReviews.values()][0]!;
    expect(pending.lastSchemaErrors).toHaveLength(1);

    const obligation = pendingObligation({
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
    });
    const bind = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: [attemptFor(obligation, CHILD_SESSION_ID)],
    });
    expect(bind.bindOutcome).toBe('schema_invalid');
    expect(bind.diagnostic?.schemaErrors).toEqual(pending.lastSchemaErrors);
  });

  it('invariant 3b: duplicate clientReference surfaces the bind message in the repair errors', () => {
    const raw = baseRawFindings({
      challenges: [contentChallenge('dup'), contentChallenge('dup', 'e'.repeat(64))],
    });
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      NOW,
    );
    captureFor(state, raw);
    const pending = [...state.pendingReviews.values()][0]!;
    expect(pending.lastSchemaErrors).toHaveLength(1);

    const obligation = pendingObligation({
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
    });
    const bind = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: [attemptFor(obligation, CHILD_SESSION_ID)],
    });
    expect(bind.bindOutcome).toBe('client_reference_invalid');
    // The repair line carries the path prefix; the bind surfaces the same
    // reviewer-actionable message content (single shared origin).
    expect(pending.lastSchemaErrors![0]!.startsWith('challenges.1.clientReference:')).toBe(true);
    expect(pending.lastSchemaErrors![0]).toContain(bind.diagnostic?.message ?? '');
  });

  it('invariant 4: a bindable prompt-conform capture is usable in the transient enforcement world', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('c1')] });
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      NOW,
    );
    captureFor(state, raw);
    const pending = [...state.pendingReviews.values()][0]!;
    expect(pending.lastSchemaErrors).toBeNull();
    expect(isPendingCaptureUsable(pending)).toBe(true);
    // A satisfied pending is excluded from matching (no phantom re-arm).
    expect(
      matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validPrompt(0, 1),
      }),
    ).toBeNull();
  });

  it('invariant 5: host-owned stamping never changes reviewer-owned semantics', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('c1')] });
    const result = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError('expected ok');
    expect(stripHostOwned(result.findings)).toEqual(stripHostOwned(raw));
  });

  it('invariant 6a: identical inputs produce identical results modulo host-minted identity', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('c1')] });
    const first = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    const second = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new TypeError('expected ok');
    // challengeId is freshly minted per preparation (host-owned identity);
    // everything else must be structurally identical.
    expect(stripHostOwned(second.findings)).toEqual(stripHostOwned(first.findings));
  });

  it('invariant 6b: unknown evidence refs are schema-valid but authorization-rejected at bind', () => {
    const raw = baseRawFindings({ challenges: [contentChallenge('c1', 'unknown-digest')] });
    const prepared = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(prepared.ok).toBe(true);

    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      NOW,
    );
    captureFor(state, raw);
    const pending = [...state.pendingReviews.values()][0]!;
    expect(isPendingCaptureUsable(pending)).toBe(true);

    const obligation = pendingObligation({
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
    });
    const bind = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: [attemptFor(obligation, CHILD_SESSION_ID)],
      allowedEvidenceRefs: [{ kind: 'content', digest: 'known-digest' }],
    });
    expect(bind.bindOutcome).toBe('challenge_evidence_unknown');
  });

  it('invariant 8: reviewer-owned input rejects host constants before host stamping', () => {
    const raw = baseRawFindings({
      attestation: {
        toolObligationId: OBLIGATION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: 'evil-version',
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
    const prepared = prepareReviewerFindingsForValidation({
      rawFindings: raw,
      obligationId: OBLIGATION_ID,
      hostConstants: HOST_CONSTANTS,
      hostProvenance: HOST_PROVENANCE,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new TypeError('expected rejection');
    expect(prepared.code).toBe('schema_invalid');
    expect(prepared.issues.some((issue) => issue.includes('mandateDigest'))).toBe(true);
  });

  it.each(['reviewedBy', 'reviewedAt'])(
    'rejects top-level host-owned %s before stamping',
    (key) => {
      const prepared = prepareReviewerFindingsForValidation({
        rawFindings: { ...baseRawFindings(), [key]: key === 'reviewedBy' ? {} : NOW },
        obligationId: OBLIGATION_ID,
        hostConstants: HOST_CONSTANTS,
        hostProvenance: HOST_PROVENANCE,
      });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) throw new TypeError('expected rejection');
      expect(prepared.issues.some((issue) => issue.includes(`"${key}"`))).toBe(true);
    },
  );
});

describe('structural host-context failure — fail closed at the signal transition', () => {
  it('invariant 7a: bindable obligation without host constants fails closed at pending creation', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      signalWithoutAttestation(),
      NOW,
    );
    const pending = [...state.pendingReviews.values()][0]!;
    // The marker is set at the signal→pending transition — BEFORE any reviewer
    // Task can run — and no raw-schema fallback exists.
    expect(pending.enforcementFailure).toBe('host_attestation_constants_missing');
    expect(pending.capturedFindings).toBeNull();
    expect(pending.lastSchemaErrors).toBeNull();
    expect(pending.repairPromptRequired).toBe(false);
    expect(pending.subagentCalled).toBe(false);
    expect(isPendingCaptureUsable(pending)).toBe(false);

    // A capture attempt never even matches the defective pending.
    captureFor(state, baseRawFindings());
    const after = [...state.pendingReviews.values()][0]!;
    expect(after.subagentCalled).toBe(false);
    expect(after.capturedFindings).toBeNull();
  });

  it('invariant 7b: structurally failed pendings are never re-matched (no re-arm, no retry)', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      signalWithoutAttestation(),
      NOW,
    );
    const before = [...state.pendingReviews.values()][0]!;
    expect(
      matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validPrompt(0, 1),
      }),
    ).toBeNull();
    const after = [...state.pendingReviews.values()][0]!;
    expect(after.retryCount).toBe(before.retryCount);
  });

  it('invariant 7c: the FIRST reviewer dispatch is blocked — zero reviewer execution', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      signalWithoutAttestation(),
      NOW,
    );
    // No reviewer Task ran; the gate must block on the very first dispatch.
    const result = enforceBeforeSubagentCall(state, {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: validPrompt(0, 1),
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new TypeError('expected block');
    expect(result.code).toBe('HOST_REVIEW_CONTEXT_UNAVAILABLE');
  });

  it('invariant 7d: isPendingCaptureUsable is a pure query — it never mutates the pending', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      NOW,
    );
    captureFor(state, baseRawFindings());
    const pending = [...state.pendingReviews.values()][0]!;
    const snapshot = JSON.stringify(pending);
    isPendingCaptureUsable(pending);
    expect(JSON.stringify(pending)).toBe(snapshot);
  });

  it('invariant 7e: a fresh correct signal replaces the defective pending and clears the blocker', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      signalWithoutAttestation(),
      NOW,
    );
    expect([...state.pendingReviews.values()][0]!.enforcementFailure).toBe(
      'host_attestation_constants_missing',
    );
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      modeAResponse(0, 1, OBLIGATION_ID),
      LATER,
    );
    const recovered = [...state.pendingReviews.values()][0]!;
    expect(recovered.enforcementFailure ?? null).toBeNull();
    expect(recovered.hostAttestationConstants).toEqual(HOST_CONSTANTS);
  });

  it('invariant 7f: a REVIEW_REQUIRED signal without an obligation identity fails closed at creation', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: '## Plan' },
      JSON.stringify({
        phase: 'PLAN',
        next: `${REVIEW_REQUIRED_PREFIX}: iteration=0, planVersion=1.`,
      }),
      NOW,
    );
    const pending = [...state.pendingReviews.values()][0]!;
    expect(pending.enforcementFailure).toBe('host_review_obligation_missing');
    const result = enforceBeforeSubagentCall(state, {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: validPrompt(0, 1),
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new TypeError('expected block');
    expect(result.code).toBe('HOST_REVIEW_CONTEXT_UNAVAILABLE');
  });

  it('invariant 7g: the CONTENT_ANALYSIS_REQUIRED bootstrap stays non-failed (pre-obligation state)', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_review',
      { text: 'content under review' },
      JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        requiredReviewAttestation: {
          reviewedBy: REVIEWER_SUBAGENT_TYPE,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          toolObligationId: OBLIGATION_ID,
          iteration: 1,
          planVersion: 1,
        },
      }),
      NOW,
    );
    const pending = [...state.pendingReviews.values()][0]!;
    expect(pending.enforcementFailure ?? null).toBeNull();
    expect(pending.obligationId).toBeNull();
  });
});
