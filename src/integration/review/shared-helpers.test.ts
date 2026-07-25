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
