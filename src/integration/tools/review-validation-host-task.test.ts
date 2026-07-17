import { describe, it, expect } from 'vitest';
import { resolveHostTaskFindings } from './review-validation.js';
import {
  setAdapterLogger,
  resetAdapterLogger,
  type AdapterLogger,
} from '../../logging/adapter-logger.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/assurance.js';
import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence-review.js';

// ═════════════════════════════════════════════════════════════════════════════
// resolveHostTaskFindings — BUG-15 Stufe 2
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveHostTaskFindings', () => {
  const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
  const now = new Date().toISOString();

  const validRawFindings: Record<string, unknown> = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };

  function makeObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
    return {
      obligationId: OBLIGATION_ID,
      obligationType: 'plan' as const,
      iteration: 0,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      createdAt: now,
      pluginHandshakeAt: now,
      status: 'fulfilled' as const,
      invocationId: INVOCATION_ID,
      blockedCode: null,
      fulfilledAt: now,
      consumedAt: null,
      ...overrides,
    };
  }

  function makeHostTaskInvocation(
    overrides: Partial<ReviewInvocationEvidence> = {},
  ): ReviewInvocationEvidence {
    return {
      invocationId: INVOCATION_ID,
      obligationId: OBLIGATION_ID,
      obligationType: 'plan' as const,
      parentSessionId: 'ses_parent',
      childSessionId: 'ses_child',
      agentType: 'flowguard-reviewer' as const,
      invocationMode: 'host_subagent_task' as const,
      hostVisible: true,
      promptHash: 'abc',
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      findingsHash: hashFindings(validRawFindings),
      invokedAt: now,
      fulfilledAt: now,
      consumedByObligationId: null,
      capturedVerdict: 'accept',
      capturedRawFindings: validRawFindings,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      ...overrides,
    };
  }

  // ── Happy Path ──────────────────────────────────────────────────────────

  it('HAPPY: resolves findings from host-task invocation with capturedRawFindings', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [makeHostTaskInvocation()],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('accept');
    expect(result.findings.iteration).toBe(0);
    expect(result.findings.planVersion).toBe(1);
    expect(result.findings.reviewMode).toBe('subagent');
    expect(result.invocation.invocationId).toBe(INVOCATION_ID);
  });

  it('HAPPY: resolves changes_requested verdict from evidence', () => {
    const rawFindings = { ...validRawFindings, overallVerdict: 'changes_requested' };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'changes_requested',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('changes_requested');
  });

  // ── F12: verdict/blocking-issues coherence at the host-task boundary ────
  // Reproduces the demo defect: host-captured findings with overallVerdict
  // 'accept' AND a non-empty blockingIssues array. Verdict-only submission in
  // host-task mode never reaches the tool-layer coherence check, so the host-
  // task resolution boundary MUST fail closed here.

  it('BAD: returns incoherent when captured findings are accept + blocking issue (demo shape)', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [{ severity: 'minor', category: 'quality', message: 'stale comment' }],
    };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'accept',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.blockingIssueCount).toBe(1);
  });

  it('BAD: incoherent for accept + critical/major blocking issues', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'accept',
      blockingIssues: [
        { severity: 'critical', category: 'correctness', message: 'contract drift' },
        { severity: 'major', category: 'risk', message: 'silent data loss' },
      ],
    };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'accept',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('incoherent');
    if (result.kind !== 'incoherent') throw new Error('expected incoherent');
    expect(result.blockingIssueCount).toBe(2);
  });

  it('HAPPY: changes_requested + blocking issues resolves normally (no coherence block)', () => {
    const rawFindings = {
      ...validRawFindings,
      overallVerdict: 'changes_requested',
      blockingIssues: [{ severity: 'critical', category: 'correctness', message: 'bug' }],
    };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedVerdict: 'changes_requested',
          capturedRawFindings: rawFindings,
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('resolved');
  });

  // ── Bad Path ────────────────────────────────────────────────────────────

  it('BAD: returns null when assurance is undefined', () => {
    expect(resolveHostTaskFindings(undefined, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns null when obligation is null', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [makeHostTaskInvocation()],
    };
    expect(resolveHostTaskFindings(assurance, null).kind).toBe('not_found');
  });

  it('BAD: returns null when no invocation exists for obligation', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [], // no invocations
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns null when invocation has no capturedRawFindings', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: undefined,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('BAD: returns unparseable when capturedRawFindings fails Zod parse (missing required fields)', () => {
    const invalidRaw = { overallVerdict: 'accept' }; // missing required fields
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: invalidRaw,
        }),
      ],
    };
    // Evidence WAS captured (reviewer ran) but is corrupt — distinct from the
    // "no evidence at all" not_found case so the caller can emit a distinct block.
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('unparseable');
  });

  it('D (hardening): logs a distinct warn when captured findings are present but unparseable', () => {
    const warnCalls: Array<{ service: string; message: string; extra?: Record<string, unknown> }> =
      [];
    const spy: AdapterLogger = {
      info: () => {},
      warn: (service, message, extra) => warnCalls.push({ service, message, extra }),
      error: () => {},
    };
    setAdapterLogger(spy);
    try {
      const invalidRaw = { overallVerdict: 'accept' }; // present but malformed
      const assurance = {
        obligations: [makeObligation()],
        invocations: [makeHostTaskInvocation({ capturedRawFindings: invalidRaw })],
      };

      const result = resolveHostTaskFindings(assurance, makeObligation());

      // Fail-closed and DISTINCT (unparseable, not the generic not_found): the
      // garbled capture is now both observable in logs and signalled to the caller.
      expect(result.kind).toBe('unparseable');
      const unparseable = warnCalls.find((c) => /unparseable/i.test(c.message));
      expect(unparseable).toBeDefined();
      expect(unparseable?.extra).toMatchObject({ invocationId: INVOCATION_ID });
    } finally {
      resetAdapterLogger();
    }
  });

  it('D (hardening): does NOT warn unparseable when there is simply no evidence', () => {
    const warnCalls: string[] = [];
    const spy: AdapterLogger = {
      info: () => {},
      warn: (_service, message) => warnCalls.push(message),
      error: () => {},
    };
    setAdapterLogger(spy);
    try {
      const assurance = { obligations: [makeObligation()], invocations: [] };
      expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
      expect(warnCalls.find((m) => /unparseable/i.test(m))).toBeUndefined();
    } finally {
      resetAdapterLogger();
    }
  });

  it('BAD: rejects host-task findings when obligation is blocked', () => {
    const assurance = {
      obligations: [
        makeObligation({
          status: 'blocked',
          blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
        }),
      ],
      invocations: [makeHostTaskInvocation()],
    };
    const result = resolveHostTaskFindings(
      assurance,
      makeObligation({ status: 'blocked', blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED' }),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');
    expect(result.rejection.status).toBe('blocked');
    expect(result.rejection.path).toBe('host_task');
  });

  it('BAD: rejects host-task findings when obligation status is consumed', () => {
    const assurance = {
      obligations: [makeObligation({ status: 'consumed' })],
      invocations: [makeHostTaskInvocation()],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation({ status: 'consumed' }));

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  it('BAD: rejects host-task findings when obligation has consumedAt', () => {
    const consumedAt = new Date(Date.now() + 1).toISOString();
    const assurance = {
      obligations: [makeObligation({ consumedAt })],
      invocations: [makeHostTaskInvocation()],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation({ consumedAt }));

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  it('EDGE: skips already-consumed invocations', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          consumedByObligationId: '99999999-9999-4999-8999-999999999999',
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('invocation_consumed');
    expect(result.rejection.path).toBe('host_task');
  });

  it('EDGE: skips SDK invocations (only host_subagent_task)', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          invocationMode: 'sdk_session_prompt',
          hostVisible: false,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: skips non-host-visible invocations', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          hostVisible: false,
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: skips invocations with mismatched obligationId', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          obligationId: '33333333-3333-4333-8333-333333333333',
        }),
      ],
    };
    expect(resolveHostTaskFindings(assurance, makeObligation()).kind).toBe('not_found');
  });

  it('EDGE: rejects the first matching consumed invocation when multiple exist', () => {
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          consumedByObligationId: '99999999-9999-4999-8999-999999999999', // consumed
        }),
        makeHostTaskInvocation({
          invocationId: '44444444-4444-4444-8444-444444444444',
          // unconsumed
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected findings');
    expect(result.rejection.reason).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(result.rejection.status).toBe('invocation_consumed');
  });

  it('CORNER: extra unknown fields in capturedRawFindings are stripped by Zod parse', () => {
    const rawWithExtras = {
      ...validRawFindings,
      extraField: 'should-be-stripped',
      _internal: { foo: 'bar' },
    };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: rawWithExtras,
        }),
      ],
    };
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('accept');
    // Extra fields are stripped by Zod
    expect((result.findings as Record<string, unknown>).extraField).toBeUndefined();
  });

  it('CORNER: findings with unable_to_review verdict still resolve (defense-in-depth at tool layer)', () => {
    const rawFindings = { ...validRawFindings, overallVerdict: 'unable_to_review' };
    const assurance = {
      obligations: [makeObligation()],
      invocations: [
        makeHostTaskInvocation({
          capturedRawFindings: rawFindings,
          capturedVerdict: 'unable_to_review',
          findingsHash: hashFindings(rawFindings),
        }),
      ],
    };
    // resolveHostTaskFindings itself does NOT block unable_to_review —
    // that's the tool layer's defense-in-depth responsibility.
    const result = resolveHostTaskFindings(assurance, makeObligation());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(result.findings.overallVerdict).toBe('unable_to_review');
  });
});
