import { describe, it, expect } from 'vitest';
import {
  validateReviewFindings,
  type ReviewFindingsValidationContext,
} from './review-validation.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence-review.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  appendInvocationEvidence,
  ensureReviewAssurance,
} from '../review/assurance.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from '../review/enforcement/enforcement.js';
import { buildHostTaskEvidence } from '../review/evidence-binding.js';
import { REVIEW_REQUIRED_PREFIX } from '../review/enforcement/types.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
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
    reviewedBy: { sessionId: 'ses_test' },
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<ReviewFindingsValidationContext> = {},
): ReviewFindingsValidationContext {
  return {
    subagentEnabled: true,
    fallbackToSelf: false,
    expectedPlanVersion: 1,
    expectedIteration: 0,
    ...overrides,
  };
}

function parseBlocked(result: string): { code: string; error: boolean } {
  return JSON.parse(result) as { code: string; error: boolean };
}

function parseDiagnosticCode(result: string): string | undefined {
  const parsed = JSON.parse(result) as { diagnostics?: { diagnosticCode?: string } };
  return parsed.diagnostics?.diagnosticCode;
}

function finding(message: string) {
  const location = { path: 'src/foo.ts', revision: 'head' as const, line: 1 };
  return {
    severity: 'major' as const,
    category: 'risk' as const,
    message,
    relation: {
      subjectAnchors: [{ kind: 'repository_location' as const, location }],
      evidenceLocations: [location],
    },
  };
}

/** Subject digest shared by the plan obligation and its reviewer attempt. */
const ANTI_FORGERY_SUBJECT_DIGEST = 'anti-forgery-plan-subject-digest';

function strictFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return makeFindings({
    reviewedBy: { sessionId: 'ses_child' },
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  });
}

type ReviewAssuranceFixture = {
  assuranceSchemaVersion: 'review-assurance.v2';
  attempts: [];
  obligations: ReviewObligation[];
  invocations: ReviewInvocationEvidence[];
};

function strictAssuranceFixture(
  findings: ReviewFindings = strictFindings(),
): ReviewAssuranceFixture {
  return {
    assuranceSchemaVersion: 'review-assurance.v2' as const,
    attempts: [],
    obligations: [
      {
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        subjectDigest: 'test-subject-digest',
        iteration: 0,
        planVersion: 1,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        maxReviewerOutputRepairAttempts: 1,
        createdAt: new Date().toISOString(),
        pluginHandshakeAt: new Date().toISOString(),
        status: 'fulfilled' as const,
        invocationId: '22222222-2222-4222-8222-222222222222',
        blockedCode: null,
        fulfilledAt: new Date().toISOString(),
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'repository_change',
          paths: ['src/foo.ts'],
          revisions: ['base', 'head'],
        },
        repositoryRevisionProvenance: {
          kind: 'available',
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
        },
      },
    ],
    invocations: [
      {
        invocationId: '22222222-2222-4222-8222-222222222222',
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        parentSessionId: 'ses_parent',
        childSessionId: 'ses_child',
        agentType: 'flowguard-reviewer' as const,
        invocationMode: 'sdk_session_prompt' as const,
        hostVisible: false,
        promptHash: 'abc',
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        findingsHash: hashFindings(findings),
        invokedAt: new Date().toISOString(),
        fulfilledAt: new Date().toISOString(),
        consumedByObligationId: null,
        reviewOutputMode: 'structured_output',
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high',
      },
    ],
  };
}

function manualAttestedAssuranceFixture(findings: ReviewFindings = strictFindings()) {
  const assurance = strictAssuranceFixture(findings);
  assurance.obligations[0] = {
    ...assurance.obligations[0]!,
    pluginHandshakeAt: null,
    status: 'fulfilled',
    fulfilledAt: new Date().toISOString(),
  };
  assurance.invocations[0] = {
    ...assurance.invocations[0]!,
    invocationMode: 'manual_attested',
    hostVisible: false,
    source: 'agent-submitted-attested',
    findingsHash: hashFindings(findings),
  };
  return assurance;
}

function nativeAttestedAssuranceFixture(findings: ReviewFindings = strictFindings()) {
  const assurance = manualAttestedAssuranceFixture(findings);
  assurance.invocations[0] = {
    ...assurance.invocations[0]!,
    invocationMode: 'native_subagent_attested',
    hostCapturedAgentId: 'agent_abc123',
    hostCapturedAgentType: 'flowguard-reviewer',
    hostCaptureSource: 'post_tool_use_hook',
  };
  return assurance;
}

// ═════════════════════════════════════════════════════════════════════════════
// Anti-forgery: manual findings without persisted evidence
// ═════════════════════════════════════════════════════════════════════════════

describe('anti-forgery — manual findings without persisted evidence', () => {
  it('NOT_PROVIDED_BY_RUNTIME attestation values are rejected', () => {
    const findings = strictFindings({
      attestation: {
        mandateDigest: 'NOT_PROVIDED_BY_RUNTIME',
        criteriaVersion: 'NOT_PROVIDED_BY_RUNTIME',
        toolObligationId: 'NOT_PROVIDED_BY_RUNTIME',
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    });
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: strictAssuranceFixture(strictFindings()),
        obligationType: 'plan',
      }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_MANDATE_MISMATCH');
  });

  it('correct-looking attestation without fulfilled obligation is rejected', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0]!.status = 'pending';
    assurance.obligations[0]!.invocationId = null;
    assurance.obligations[0]!.fulfilledAt = null;
    const result = validateReviewFindings(
      findings,
      makeCtx({ strictEnforcement: true, assurance, obligationType: 'plan' }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(parseDiagnosticCode(result!)).toBe('REVIEW_INVOCATION_EVIDENCE_MISSING');
    expect(blocked.diagnosticCard).toBeUndefined();
  });

  it('correct attestation without matching invocation evidence is rejected', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.invocations = [];
    const result = validateReviewFindings(
      findings,
      makeCtx({ strictEnforcement: true, assurance, obligationType: 'plan' }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(blocked.diagnostics.required).toContain(
      'matching ReviewInvocationEvidence for the active obligation',
    );
  });

  it('accepts matching fulfilled obligation and matching invocation evidence', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: strictAssuranceFixture(findings),
        obligationType: 'plan',
      }),
    );
    expect(result).toBeNull();
  });

  it('accepts Claude/Codex manual_attested evidence without plugin handshake when policy allows it', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: manualAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).toBeNull();
  });

  it('rejects OpenCode host-orchestrated evidence without plugin handshake', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = { ...assurance.obligations[0]!, pluginHandshakeAt: null };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'opencode',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects host_task_required evidence without plugin handshake', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: null,
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      capturedVerdict: 'accept',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects manual_attested evidence without explicit invocation policy', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: manualAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects manual_attested self-approval from the governed parent session', () => {
    const findings = strictFindings({ reviewedBy: { sessionId: 'ses_parent' } });
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      childSessionId: 'ses_parent',
      parentSessionId: 'ses_parent',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewParentSessionId: 'ses_parent',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_SELF_APPROVAL_DENIED');
  });

  it('rejects manual_attested evidence bound to the wrong obligation', () => {
    const findings = strictFindings();
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      obligationId: '33333333-3333-4333-8333-333333333333',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'codex',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects stale manual_attested evidence without plugin handshake', () => {
    const findings = strictFindings({ iteration: 0 });

    const result = validateReviewFindings(
      findings,
      makeCtx({
        expectedIteration: 1,
        strictEnforcement: true,
        assurance: manualAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
  });

  it('rejects wrong-planVersion manual_attested evidence without plugin handshake', () => {
    const findings = strictFindings({ planVersion: 1 });

    const result = validateReviewFindings(
      findings,
      makeCtx({
        expectedPlanVersion: 2,
        strictEnforcement: true,
        assurance: manualAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'codex',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
  });

  it('rejects manual_attested evidence with mismatched childSessionId', () => {
    const findings = strictFindings();
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      childSessionId: 'ses_other_child',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects manual_attested evidence with mismatched criteriaVersion', () => {
    const findings = strictFindings();
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      criteriaVersion: 'wrong-criteria-version',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'codex',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects manual_attested evidence with mismatched mandateDigest', () => {
    const findings = strictFindings();
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      mandateDigest: 'wrong-mandate-digest',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects manual_attested evidence with missing attestation', () => {
    const findings = strictFindings({ attestation: undefined });
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: manualAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'sdk_allowed',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_MANDATE_MISSING');
  });

  it('rejects reused manual_attested evidence', () => {
    const findings = strictFindings();
    const assurance = manualAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      consumedByObligationId: '33333333-3333-4333-8333-333333333333',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'codex',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_EVIDENCE_REUSED');
  });

  // ── native_subagent_attested tier ────────────────────────────────────────

  // Issue #419: native_subagent_attested corroboration is agent-writable plaintext
  // (reviewer-captures.jsonl has no hash chain), so it cannot establish enforcement
  // availability. Without a first-party plugin handshake the native path MUST fail
  // closed exactly like solo / host_task_preferred, never accept.
  it('denies native_subagent_attested evidence when plugin enforcement is unavailable', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: nativeAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    // Surfaces the native path structurally so the plugin boundary can log it (#419).
    const parsed = JSON.parse(result!) as { diagnostics?: { deniedReviewPath?: string } };
    expect(parsed.diagnostics?.deniedReviewPath).toBe('native');
  });

  it('rejects native_subagent_attested evidence missing hostCapturedAgentId', () => {
    const findings = strictFindings();
    const assurance = nativeAttestedAssuranceFixture(findings);
    const { hostCapturedAgentId: _omit, ...withoutAgentId } = assurance.invocations[0]!;
    assurance.invocations[0] = withoutAgentId;

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects native_subagent_attested evidence missing hostCaptureSource', () => {
    const findings = strictFindings();
    const assurance = nativeAttestedAssuranceFixture(findings);
    const { hostCaptureSource: _omit, ...withoutSource } = assurance.invocations[0]!;
    assurance.invocations[0] = withoutSource;

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects native_subagent_attested evidence with an invalid hostCaptureSource value', () => {
    const findings = strictFindings();
    const assurance = nativeAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      hostCaptureSource: 'forged_source' as unknown as 'post_tool_use_hook',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('never accepts native_subagent_attested under host_task_required policy', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: nativeAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('rejects native_subagent_attested self-approval from the governed parent session', () => {
    const findings = strictFindings({ reviewedBy: { sessionId: 'ses_parent' } });
    const assurance = nativeAttestedAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      childSessionId: 'ses_parent',
      parentSessionId: 'ses_parent',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewParentSessionId: 'ses_parent',
        reviewHostPlatform: 'claude-code',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_SELF_APPROVAL_DENIED');
  });

  it('rejects native_subagent_attested evidence on OpenCode host (external-host only)', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: nativeAttestedAssuranceFixture(findings),
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_preferred',
        reviewHostPlatform: 'opencode',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('host_task_required accepts pending host-visible invocation only when findings match evidence', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      findingsHash: hashFindings(findings),
      capturedVerdict: 'accept',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).toBeNull();
  });

  it('host_task_required rejects when submitted verdict differs from capturedVerdict (BUG-15: verdict tamper)', () => {
    const storedFindings = strictFindings({ overallVerdict: 'changes_requested' });
    const submittedFindings = strictFindings({ overallVerdict: 'accept' }); // tampered verdict
    const assurance = strictAssuranceFixture(storedFindings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      findingsHash: hashFindings(storedFindings),
      capturedVerdict: 'changes_requested',
    };

    const result = validateReviewFindings(
      submittedFindings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
  });

  // ── BUG-15: host_task_required verdict-based validation ─────────────────

  it('BUG-15 HAPPY: host_task_required accepts when hash differs but verdict matches (core fix)', () => {
    // This is THE BUG-15 scenario: agent reconstructs findings JSON with
    // different key order / Zod-stripped fields, causing hash mismatch.
    // With capturedVerdict, verdict match suffices.
    const storedFindings = strictFindings({ overallVerdict: 'accept' });
    const submittedFindings = strictFindings({
      overallVerdict: 'accept',
      // Different majorRisks array → different hash, same verdict
      majorRisks: [finding('agent-reconstructed')],
    });
    const assurance = strictAssuranceFixture(storedFindings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      findingsHash: hashFindings(storedFindings),
      capturedVerdict: 'accept',
    };

    // Verify hashes actually differ (precondition for this test)
    expect(hashFindings(submittedFindings)).not.toBe(hashFindings(storedFindings));

    const result = validateReviewFindings(
      submittedFindings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).toBeNull();
  });

  it('BUG-15 HAPPY: host_task_required accepts changes_requested verdict (revision loop)', () => {
    const findings = strictFindings({ overallVerdict: 'changes_requested' });
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      findingsHash: hashFindings(findings),
      capturedVerdict: 'changes_requested',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).toBeNull();
  });

  it('BUG-15 CORNER: host_task_required accepts with different sessionId from evidence', () => {
    // After BUG-14 fix, sessionId is injected into output. But agent may
    // still reconstruct it differently. Host-task mode skips hard sessionId block.
    const findings = strictFindings({
      reviewedBy: { sessionId: 'ses_agent_reconstructed' },
    });
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      childSessionId: 'ses_real_child', // different from agent's reconstruction
      findingsHash: 'does-not-matter-for-host-task',
      capturedVerdict: 'accept',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).toBeNull();
  });

  it('BUG-15 EDGE: host_task_required falls back to hash when capturedVerdict is missing (legacy evidence)', () => {
    // Legacy invocation evidence without capturedVerdict → falls back to hash comparison
    const storedFindings = strictFindings();
    const submittedFindings = strictFindings({
      majorRisks: [finding('extra')],
    });
    const assurance = strictAssuranceFixture(storedFindings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: new Date().toISOString(),
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      parentSessionId: 'ses_parent',
      findingsHash: hashFindings(storedFindings),
      // no capturedVerdict → legacy evidence
    };

    const result = validateReviewFindings(
      submittedFindings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
  });

  it('BUG-15 REGRESSION: sdk_session_prompt still uses hash comparison', () => {
    // SDK path MUST NOT use verdict-based validation — hash comparison stays
    const storedFindings = strictFindings();
    const submittedFindings = strictFindings({
      majorRisks: [finding('sdk tampered')],
    });
    const assurance = strictAssuranceFixture(storedFindings);

    const result = validateReviewFindings(
      submittedFindings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        // no reviewInvocationPolicy → defaults to SDK-like behavior
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
  });

  it('BUG-15 BAD: sdk_session_prompt rejects sessionId mismatch (non-host-task hard block)', () => {
    const findings = strictFindings({
      reviewedBy: { sessionId: 'ses_wrong' },
    });
    const assurance = strictAssuranceFixture(findings);
    // Fix the invocation to have a different childSessionId so lookup works via invocationId
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      childSessionId: 'ses_correct',
    };

    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance,
        obligationType: 'plan',
        // no reviewInvocationPolicy → SDK-like
      }),
    );

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_SESSION_MISMATCH');
  });

  it('task-tool after evidence is available before the next FlowGuard verdict submit validates findings', () => {
    const now = new Date().toISOString();
    const findings = strictFindings();
    const enforcementState = createSessionState();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      pluginHandshakeAt: now,
      invocationId: null,
      fulfilledAt: null,
      // Binding requires the obligation and its attempt to name the same subject.
      subjectDigest: ANTI_FORGERY_SUBJECT_DIGEST,
    };
    assurance.invocations = [];

    onFlowGuardToolAfter(
      enforcementState,
      'flowguard_plan',
      {},
      JSON.stringify({ next: `${REVIEW_REQUIRED_PREFIX}: iteration=0 planVersion=1` }),
      now,
    );
    onTaskToolAfter(
      enforcementState,
      {
        subagent_type: 'flowguard-reviewer',
        prompt: `Review iteration=0 planVersion=1 ${'x'.repeat(240)}`,
      },
      JSON.stringify(findings),
      now,
    );
    const bindResult = buildHostTaskEvidence(enforcementState, 'ses_parent', now, {
      obligations: assurance.obligations,
      invocations: assurance.invocations,
      // Binding is attempt-first: the host pre-registers the attempt and binds
      attempts:
        // the reviewer child session to it before evidence can be captured.
        [
          {
            attemptId: '33333333-3333-4333-8333-333333333333',
            obligationId: assurance.obligations[0]!.obligationId,
            obligationType: 'plan',
            subjectDigest: ANTI_FORGERY_SUBJECT_DIGEST,
            ordinal: 0,
            childSessionId: 'ses_child',
            status: 'created',
            origin: { kind: 'initial' } as const,
            createdAt: now,
          },
        ],
    });

    expect(bindResult.evidence).not.toBeNull();
    const assuranceWithTaskEvidence = appendInvocationEvidence(
      ensureReviewAssurance(assurance),
      bindResult.evidence!,
    );
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: assuranceWithTaskEvidence,
        obligationType: 'plan',
        reviewInvocationPolicy: 'host_task_required',
        reviewParentSessionId: 'ses_parent',
      }),
    );

    expect(result).toBeNull();
  });
});
