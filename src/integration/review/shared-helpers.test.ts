/**
 * @module integration/review/shared-helpers.test
 * @description Tests for shared-helpers pure functions — attestation validation,
 *              policy extraction, output detection, and session context construction.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validatePipelineAttestation,
  isStrictEnforcementEnabled,
  isOutputAlreadyBlocked,
  buildReviewDiscoveryContextForPipeline,
  buildAttemptSucceededLogger,
  REASON_MANDATE_MISSING,
  REASON_MANDATE_MISMATCH,
  REASON_UNABLE_TO_REVIEW,
} from './shared-helpers.js';
import type { PipelineContext } from './pipeline-types.js';
import type { SessionState } from '../../state/schema.js';
import { createLogger, type LogEntry } from '../../logging/logger.js';

const { buildReviewDiscoveryContext } = vi.hoisted(() => ({
  buildReviewDiscoveryContext: vi.fn(),
}));

vi.mock('./discovery-context-loader.js', () => ({
  buildReviewDiscoveryContext: (input: unknown) => buildReviewDiscoveryContext(input),
}));

vi.mock('../review/orchestrator.js', () => ({
  extractReviewContext: vi.fn(),
}));
vi.mock('../review/prompt-builders.js', () => ({
  buildPlanReviewPrompt: vi.fn(),
  buildImplReviewPrompt: vi.fn(),
  buildArchitectureReviewPrompt: vi.fn(),
  selectReviewerProfileRules: vi.fn(() => ({})),
}));

vi.mock('../plugin-helpers.js', () => ({
  parseToolResult: vi.fn((output: string) => {
    try {
      const parsed = JSON.parse(output);
      return parsed;
    } catch {
      return null;
    }
  }),
}));

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function fullExpected(overrides: Partial<Parameters<typeof validatePipelineAttestation>[1]> = {}) {
  return {
    obligationId: '00000000-0000-4000-8000-000000000001',
    criteriaVersion: '1.0.0',
    mandateDigest: 'mandate-digest-1',
    iteration: 0,
    planVersion: 1,
    checkReviewedBy: true,
    checkUnableToReview: false,
    ...overrides,
  };
}

function findings(overrides: Record<string, unknown> = {}) {
  return {
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    attestation: {
      toolObligationId: '00000000-0000-4000-8000-000000000001',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: '1.0.0',
      mandateDigest: 'mandate-digest-1',
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  };
}

// ─── validatePipelineAttestation ──────────────────────────────────────────────

describe('validatePipelineAttestation', () => {
  it('valid attestation returns { valid: true }', () => {
    expect(validatePipelineAttestation(findings(), fullExpected())).toEqual({
      valid: true,
    });
  });

  it('missing attestation returns MANDATE_MISSING', () => {
    const result = validatePipelineAttestation(findings({ attestation: null }), fullExpected());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISSING);
  });

  it('mandate digest mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({ attestation: { ...findings().attestation!, mandateDigest: 'wrong' } }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('iteration mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(findings(), fullExpected({ iteration: 2 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('reviewedBy mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({
        attestation: { ...findings().attestation!, reviewedBy: 'wrong-agent' },
      }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('unable_to_review verdict with enforce flag returns UNABLE_TO_REVIEW', () => {
    const result = validatePipelineAttestation(
      findings({ overallVerdict: 'unable_to_review' }),
      fullExpected({ checkUnableToReview: true }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_UNABLE_TO_REVIEW);
  });

  it('obligationId mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ obligationId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('criteriaVersion mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ criteriaVersion: '9.9.9' }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });
});

// ─── isStrictEnforcementEnabled ───────────────────────────────────────────────

describe('isStrictEnforcementEnabled', () => {
  it('returns true when selfReview.strictEnforcement is true', () => {
    const s = {
      policySnapshot: { selfReview: { strictEnforcement: true } },
    } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(true);
  });

  it('returns false when selfReview is absent', () => {
    const s = { policySnapshot: {} } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(false);
  });

  it('returns false when strictEnforcement is false', () => {
    const s = {
      policySnapshot: { selfReview: { strictEnforcement: false } },
    } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(false);
  });
});

// ─── isOutputAlreadyBlocked ───────────────────────────────────────────────────

describe('isOutputAlreadyBlocked', () => {
  it('detects blocked output from result string', () => {
    expect(
      isOutputAlreadyBlocked({
        output: JSON.stringify({ error: true, code: 'TEST_CODE' }),
      }),
    ).toBe(true);
  });

  it('returns false for non-blocked output', () => {
    expect(isOutputAlreadyBlocked({ output: JSON.stringify({ error: false }) })).toBe(false);
  });

  it('returns false for non-JSON output', () => {
    expect(isOutputAlreadyBlocked({ output: 'plain text output' })).toBe(false);
  });
});

// ─── buildReviewDiscoveryContextForPipeline (#401 drift) ──────────────────────

describe('buildReviewDiscoveryContextForPipeline (#401 drift)', () => {
  beforeEach(() => {
    buildReviewDiscoveryContext.mockReset();
    buildReviewDiscoveryContext.mockResolvedValue({ verificationCandidates: [] });
  });

  function makeCtx(): PipelineContext {
    return {
      sessionState: { binding: { worktree: '/tmp/repo' } },
      deps: {
        resolveFingerprint: vi.fn().mockResolvedValue('fp-1'),
        log: { warn: vi.fn(), info: vi.fn() },
        adapter: { getWorktree: () => '/tmp/repo' },
      },
    } as unknown as PipelineContext;
  }

  it('requests a drift check for content/PR review (includeDriftCheck: true)', async () => {
    await buildReviewDiscoveryContextForPipeline(makeCtx());

    expect(buildReviewDiscoveryContext).toHaveBeenCalledTimes(1);
    const input = buildReviewDiscoveryContext.mock.calls[0]?.[0] as {
      includeDriftCheck?: boolean;
    };
    expect(input.includeDriftCheck).toBe(true);
  });

  it('passes resolved fingerprint and worktree to the loader', async () => {
    await buildReviewDiscoveryContextForPipeline(makeCtx());

    const input = buildReviewDiscoveryContext.mock.calls[0]?.[0] as {
      fingerprint?: string | null;
      worktree?: string;
    };
    expect(input.fingerprint).toBe('fp-1');
    expect(input.worktree).toBe('/tmp/repo');
  });
});

describe('buildAttemptSucceededLogger', () => {
  function depsWithLog(entries: LogEntry[]) {
    const logger = createLogger('debug', (e) => {
      entries.push(e);
    });
    return { log: logger } as unknown as Parameters<typeof buildAttemptSucceededLogger>[0];
  }

  it('emits an INFO orchestrator log with parent/child correlation and timing', () => {
    const entries: LogEntry[] = [];
    const logSucceeded = buildAttemptSucceededLogger(depsWithLog(entries), 'flowguard_plan');

    logSucceeded({
      attempt: 1,
      step: 'session_prompt',
      parentSessionId: 'parent-1',
      childSessionId: 'child-9',
      durationMs: 42,
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.level).toBe('info');
    expect(entry.service).toBe('orchestrator');
    expect(entry.extra).toMatchObject({
      tool: 'flowguard_plan',
      step: 'session_prompt',
      parentSessionId: 'parent-1',
      childSessionId: 'child-9',
      durationMs: 42,
    });
  });

  it('correlation IDs survive the logger redaction path intact', () => {
    const entries: LogEntry[] = [];
    const logSucceeded = buildAttemptSucceededLogger(depsWithLog(entries), 'flowguard_review');

    // Realistic OpenCode-style session ids (no secrets, no absolute paths).
    logSucceeded({
      attempt: 2,
      step: 'session_create',
      parentSessionId: 'ses_abc123DEF',
      childSessionId: 'ses_child456GHI',
      durationMs: 7,
    });

    const extra = entries[0]!.extra as Record<string, unknown>;
    expect(extra.parentSessionId).toBe('ses_abc123DEF');
    expect(extra.childSessionId).toBe('ses_child456GHI');
    expect(extra.durationMs).toBe(7);
  });
});

// ─── Implementation Subject Authority (SDK prompt) ───────────────────────────

import { buildToolPrompt } from './shared-helpers.js';
import { buildImplReviewPrompt } from './prompt-builders.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../../fixtures.js';
import { TOOL_FLOWGUARD_IMPLEMENT } from '../tool-names.js';

function implementPromptState(overrides: {
  implementationDigest?: string | null;
  scopeKind?: 'implementation' | 'repository_change';
  scopeDigest?: string;
}): Parameters<typeof buildToolPrompt>[0] {
  const {
    implementationDigest = null,
    scopeKind = 'implementation',
    scopeDigest = 'subject-A',
  } = overrides;
  const obligation = {
    obligationId: 'ob-1',
    obligationType: 'implement' as const,
    requiredChallengeCount: 0,
    requiredChallengeKind: 'implementation_challenge' as const,
    challengePolicyVersion: 'challenge-policy.v1' as const,
    iteration: 1,
    planVersion: 1,
    criteriaVersion: 'p41-v1',
    mandateDigest: 'mandate-digest',
    maxReviewerOutputRepairAttempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    pluginHandshakeAt: null,
    status: 'pending' as const,
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    subjectDigest: 'subject-A',
    reviewProfile: 'core' as const,
    profileSource: 'policy_default' as const,
    reviewSubjectScope:
      scopeKind === 'implementation'
        ? ({ kind: 'implementation', implementationDigest: scopeDigest } as const)
        : ({
            kind: 'repository_change',
            paths: ['src/a.ts'],
            revisions: ['base', 'head'],
          } as const),
  };
  const state = makeState('IMPL_REVIEW', {
    implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    implementation: implementationDigest
      ? {
          changedFiles: ['src/a.ts'],
          domainFiles: ['src/a.ts'],
          digest: implementationDigest,
          executedAt: '2026-01-01T00:00:00.000Z',
        }
      : null,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [obligation],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
  });
  return {
    toolName: TOOL_FLOWGUARD_IMPLEMENT,
    texts: { planText: '## Plan\nFix', ticketText: '## Ticket\nTask', adrText: '', adrTitle: '' },
    reviewCtx: {
      obligationId: 'ob-1',
      iteration: 1,
      planVersion: 1,
      criteriaVersion: 'p41-v1',
      mandateDigest: 'mandate-digest',
    },
    parsedOutput: { changedFiles: ['src/a.ts'] },
    sessionState: state,
    rules: {
      planRules: {},
      implRules: {},
      archRules: {},
    },
    deps: {} as never,
    discoveryContext: {
      health: null,
      drift: null,
      detectedStack: null,
      verificationCandidates: [],
      implementationGuidance: null,
      notVerified: [],
    },
  };
}

describe('buildToolPrompt — implementation subject authority', () => {
  it('uses the OBLIGATION subject digest, not the mutable current implementation', () => {
    const params = implementPromptState({ implementationDigest: null });
    buildToolPrompt(params);
    expect(vi.mocked(buildImplReviewPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({ implementationDigest: 'subject-A' }),
    );
  });

  it('accepts a coherent current implementation digest equal to the subject digest', () => {
    const params = implementPromptState({ implementationDigest: 'subject-A' });
    buildToolPrompt(params);
    expect(vi.mocked(buildImplReviewPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({ implementationDigest: 'subject-A' }),
    );
  });

  it('fails closed when the current implementation digest diverges from the bound subject', () => {
    const params = implementPromptState({ implementationDigest: 'subject-B' });
    expect(() => buildToolPrompt(params)).toThrowError(
      expect.objectContaining({ code: 'REVIEW_MATERIAL_INTEGRITY_FAILED' }),
    );
  });

  it('fails closed when the bound scope digest diverges from the obligation subject digest', () => {
    const params = implementPromptState({ scopeDigest: 'other-digest' });
    expect(() => buildToolPrompt(params)).toThrowError(
      expect.objectContaining({ code: 'REVIEW_MATERIAL_INTEGRITY_FAILED' }),
    );
  });

  it('fails closed for a legacy repository_change scope on an implement obligation', () => {
    const params = implementPromptState({ scopeKind: 'repository_change' });
    expect(() => buildToolPrompt(params)).toThrowError(
      expect.objectContaining({ code: 'REVIEW_MATERIAL_INTEGRITY_FAILED' }),
    );
  });
});

it('fails closed when the orchestration context does not resolve an exact implement obligation', () => {
  const params = implementPromptState({ implementationDigest: null });
  params.sessionState = {
    ...params.sessionState,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
  };
  expect(() => buildToolPrompt(params)).toThrowError(
    expect.objectContaining({ code: 'REVIEW_MATERIAL_INTEGRITY_FAILED' }),
  );
});

it('fails closed when the resolved obligation is not an implement obligation', () => {
  const params = implementPromptState({ implementationDigest: null });
  const wrongType = {
    obligationId: 'ob-1',
    obligationType: 'plan' as const,
    requiredChallengeCount: 0,
    requiredChallengeKind: 'design_challenge' as const,
    challengePolicyVersion: 'challenge-policy.v1' as const,
    iteration: 1,
    planVersion: 1,
    criteriaVersion: 'p41-v1',
    mandateDigest: 'mandate-digest',
    maxReviewerOutputRepairAttempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    pluginHandshakeAt: null,
    status: 'pending' as const,
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    subjectDigest: 'subject-A',
    reviewProfile: 'core' as const,
    profileSource: 'policy_default' as const,
    reviewSubjectScope: {
      kind: 'artifact' as const,
      artifact: {
        kind: 'plan' as const,
        digest: 'subject-A',
        sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
      },
    },
  };
  params.sessionState = {
    ...params.sessionState,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [wrongType],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
  };
  expect(() => buildToolPrompt(params)).toThrowError(
    expect.objectContaining({ code: 'REVIEW_MATERIAL_INTEGRITY_FAILED' }),
  );
});
