/**
 * @module integration/review-orchestrator.test
 * @description Tests for the deterministic review subagent orchestrator.
 *
 * Validates:
 * - Prompt building for plan and implementation reviews
 * - SDK client invocation with mock client
 * - Structured output response parsing (fail-closed: no text fallback)
 * - ReviewFindings parsing (clean JSON, embedded JSON, invalid)
 * - Output mutation (INDEPENDENT_REVIEW_REQUIRED → COMPLETED)
 * - Review-required detection
 * - Review context extraction from tool output
 * - Error handling and graceful degradation
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  buildReviewContentPrompt,
  selectReviewerProfileRules,
  type PlanReviewPromptOpts,
  type ImplReviewPromptOpts,
} from './prompt-builders.js';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import {
  buildReviewContentMutatedOutput,
  invokeReviewer,
  buildMutatedOutput,
  isReviewRequired,
  extractReviewContext,
  REVIEW_COMPLETED_PREFIX,
  type OrchestratorClient,
  type ReviewerSuccessResult,
} from './orchestrator.js';
import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';

import { TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { parseToolResult } from '../plugin-helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a valid ReviewFindings JSON string. */
function validFindings(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: '2026-04-24T12:00:00.000Z',
    attestation: {
      mandateDigest: 'test-mandate-digest',
      criteriaVersion: 'p35-v1',
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  });
}

/** Build a mock OpenCode SDK client. */
function mockClient(
  opts: {
    createResult?: { data?: { id: string }; error?: unknown };
    promptResult?: {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: {
          structured_output?: unknown;
          error?: { name: string; message: string };
        };
      };
      error?: unknown;
    };
    agentsResult?: { data?: Array<Record<string, unknown>>; error?: unknown };
  } = {},
): OrchestratorClient {
  return {
    app: {
      agents: vi.fn().mockResolvedValue(
        opts.agentsResult ?? {
          data: [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }],
        },
      ),
    },
    session: {
      create: vi
        .fn()
        .mockResolvedValue(
          opts.createResult ?? { data: { id: 'child-session-1' }, error: undefined },
        ),
      prompt: vi.fn().mockResolvedValue(
        opts.promptResult ?? {
          data: {
            parts: [{ type: 'text', text: validFindings() }],
            info: { structured_output: JSON.parse(validFindings()) as Record<string, unknown> },
          },
          error: undefined,
        },
      ),
    },
  };
}

/** Build a Mode A tool output with INDEPENDENT_REVIEW_REQUIRED. */
function modeAOutput(
  opts: {
    iteration?: number;
    planVersion?: number;
    tool?: string;
  } = {},
): string {
  const { iteration = 0, planVersion = 1 } = opts;
  return JSON.stringify({
    phase: 'PLAN',
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewObligationId: '11111111-1111-4111-8111-111111111111',
    reviewCriteriaVersion: 'p35-v1',
    reviewMandateDigest: 'test-mandate-digest',
    reviewMode: 'subagent',
    next:
      `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with iteration=${iteration}, ` +
      `planVersion=${planVersion}.`,
  });
}

/** Build a Mode A output with no independent-review next action. */
function noReviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Plan submitted (v1).',
    reviewMode: 'subagent',
    next: 'Plan submitted. Await explicit review routing.',
  });
}

describe('isReviewRequired', () => {
  // HAPPY: detects review required
  it('returns true for INDEPENDENT_REVIEW_REQUIRED next field', () => {
    expect(isReviewRequired(modeAOutput())).toBe(true);
  });

  // HAPPY: not required without independent-review marker
  it('returns false when required marker is absent', () => {
    expect(isReviewRequired(noReviewRequiredOutput())).toBe(false);
  });

  // BAD: invalid JSON
  it('returns false for invalid JSON', () => {
    expect(isReviewRequired('not json')).toBe(false);
  });

  // BAD: empty string
  it('returns false for empty string', () => {
    expect(isReviewRequired('')).toBe(false);
  });

  // EDGE: JSON without next field
  it('returns false for JSON without next field', () => {
    expect(isReviewRequired(JSON.stringify({ phase: 'PLAN' }))).toBe(false);
  });

  // EDGE: next field is not a string
  it('returns false when next is not a string', () => {
    expect(isReviewRequired(JSON.stringify({ next: 42 }))).toBe(false);
  });

  // BAD: footer format — JSON + "\nNext action: ..."
  it('detects INDEPENDENT_REVIEW_REQUIRED with NextAction footer', () => {
    const output = JSON.stringify({ next: 'INDEPENDENT_REVIEW_REQUIRED: call reviewer' });
    expect(isReviewRequired(output)).toBe(true);
  });

  // REGRESSION: clean JSON still detected
  it('still detects INDEPENDENT_REVIEW_REQUIRED without footer', () => {
    const output = JSON.stringify({ next: 'INDEPENDENT_REVIEW_REQUIRED: call reviewer' });
    expect(isReviewRequired(output)).toBe(true);
  });

  // BAD: /plan footer format
  it('detects /plan footer output', () => {
    const raw = JSON.stringify({
      phase: 'PLAN',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer',
      reviewObligationId: 'test-obl-id',
    });
    expect(isReviewRequired(raw)).toBe(true);
  });

  // BAD: /implement footer format
  it('detects /implement footer output', () => {
    const raw = JSON.stringify({
      phase: 'IMPLEMENTATION',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer',
      reviewObligationId: 'test-obl-id',
    });
    expect(isReviewRequired(raw)).toBe(true);
  });

  // BAD: /architecture footer format
  it('detects /architecture footer output', () => {
    const raw = JSON.stringify({
      phase: 'ARCHITECTURE',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer',
      reviewObligationId: 'test-obl-id',
    });
    expect(isReviewRequired(raw)).toBe(true);
  });

  // BAD: /review CONTENT_ANALYSIS_REQUIRED + footer
  it('detects /review CONTENT_ANALYSIS_REQUIRED with footer', () => {
    const raw = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: {
        toolObligationId: 'test-obl-id',
        mandateDigest: 'test-digest',
        criteriaVersion: 'v1',
        reviewedBy: 'flowguard-reviewer',
      },
    });
    expect(isReviewRequired(raw, TOOL_FLOWGUARD_REVIEW)).toBe(true);
  });

  // REGRESSION: parseToolResult and isReviewRequired agree
  it('parseToolResult and isReviewRequired agree on footer output', () => {
    const raw = JSON.stringify({ next: 'INDEPENDENT_REVIEW_REQUIRED: review me' });
    const parsed = parseToolResult(raw);
    expect(parsed?.next).toContain('INDEPENDENT_REVIEW_REQUIRED');
    expect(isReviewRequired(raw)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractReviewContext
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractReviewContext', () => {
  // HAPPY: extracts iteration and planVersion from plan output
  it('extracts context from plan Mode A output', () => {
    const parsed = JSON.parse(modeAOutput()) as Record<string, unknown>;
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(0);
    expect(ctx!.planVersion).toBe(1);
    expect(ctx!.obligationId).toBe('11111111-1111-4111-8111-111111111111');
  });

  // HAPPY: extracts context with different values
  it('extracts custom iteration and planVersion', () => {
    const parsed = JSON.parse(modeAOutput({ iteration: 2, planVersion: 4 })) as Record<
      string,
      unknown
    >;
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(2);
    expect(ctx!.planVersion).toBe(4);
  });

  // BAD: missing iteration
  it('returns null when iteration is missing from next field', () => {
    const parsed = {
      next: `${REVIEW_REQUIRED_PREFIX}: missing iteration, planVersion=1`,
      selfReviewIteration: 0,
    };
    expect(extractReviewContext('flowguard_plan', parsed)).toBeNull();
  });

  // BAD: missing planVersion
  it('returns null when planVersion is missing from next field', () => {
    const parsed = {
      next: `${REVIEW_REQUIRED_PREFIX}: iteration=0, missing version`,
      selfReviewIteration: 0,
    };
    expect(extractReviewContext('flowguard_plan', parsed)).toBeNull();
  });

  // BAD: no next field
  it('returns null when next is missing', () => {
    expect(extractReviewContext('flowguard_plan', { phase: 'PLAN' })).toBeNull();
  });

  it('returns null when obligation metadata is missing', () => {
    const parsed = {
      next: `${REVIEW_REQUIRED_PREFIX}: iteration=0, planVersion=1`,
      selfReviewIteration: 0,
    };
    expect(extractReviewContext('flowguard_plan', parsed)).toBeNull();
  });

  // EDGE: next field is not a string
  it('returns null when next is not a string', () => {
    expect(extractReviewContext('flowguard_plan', { next: 42 })).toBeNull();
  });

  // CORNER: iteration in next field doesn't match selfReviewIteration
  it('returns null when iteration is inconsistent with selfReviewIteration', () => {
    const parsed = JSON.parse(modeAOutput({ iteration: 0 })) as Record<string, unknown>;
    // Manually change selfReviewIteration to mismatch
    parsed.selfReviewIteration = 5;
    expect(extractReviewContext('flowguard_plan', parsed)).toBeNull();
  });

  // CORNER: implement tool (no selfReviewIteration check)
  it('does not validate selfReviewIteration for implement tool', () => {
    const parsed = {
      next: `${REVIEW_REQUIRED_PREFIX}: iteration=1, planVersion=2`,
      reviewObligationId: '11111111-1111-4111-8111-111111111111',
      reviewCriteriaVersion: 'p35-v1',
      reviewMandateDigest: 'test-mandate-digest',
      selfReviewIteration: 99, // different — but implement doesn't check
    };
    const ctx = extractReviewContext('flowguard_implement', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(1);
    expect(ctx!.planVersion).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: End-to-end orchestration flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end orchestration flow', () => {
  // HAPPY: full cycle — detect, invoke, mutate
  it('detects review-required, invokes reviewer, and produces mutated output', async () => {
    const original = modeAOutput({ iteration: 0, planVersion: 1 });

    // Step 1: Detect review required
    expect(isReviewRequired(original)).toBe(true);

    // Step 2: Extract context
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();

    // Step 3: Build prompt
    const prompt = buildPlanReviewPrompt({
      planText: '## Objective\nTest plan.',
      ticketText: 'Test ticket.',
      iteration: ctx!.iteration,
      planVersion: ctx!.planVersion,
      obligationId: ctx!.obligationId,
      criteriaVersion: ctx!.criteriaVersion,
      mandateDigest: ctx!.mandateDigest,
    });

    // Step 4: Invoke reviewer
    const client = mockClient();
    const result = await invokeReviewer(client, prompt, 'parent-session');
    expect(result).not.toBeNull();

    // Step 5: Mutate output
    const mutated = buildMutatedOutput(original, result!);
    expect(mutated).not.toBeNull();

    // Verify mutated output
    const mutatedParsed = JSON.parse(mutated!) as Record<string, unknown>;
    expect((mutatedParsed.next as string).startsWith(REVIEW_COMPLETED_PREFIX)).toBe(true);
    expect(mutatedParsed.pluginReviewFindings).toBeDefined();
    expect(mutatedParsed._pluginReviewSessionId).toBe('child-session-1');
    // Original fields preserved
    expect(mutatedParsed.phase).toBe('PLAN');
    expect(mutatedParsed.reviewObligationId).toBeDefined();
  });

  // EDGE: reviewer fails — graceful degradation (output unchanged)
  it('degrades gracefully when reviewer fails', async () => {
    const original = modeAOutput();

    const client = mockClient({
      createResult: { error: { message: 'Server error' } },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent');
    expect(result).toBeNull();

    // Output stays unchanged — the LLM will follow the original INDEPENDENT_REVIEW_REQUIRED
    expect(isReviewRequired(original)).toBe(true);
  });

  // CORNER: reviewer returns no structured output — fail-closed, no COMPLETED
  it('preserves INDEPENDENT_REVIEW_REQUIRED when structured output is missing', async () => {
    const original = modeAOutput();

    const client = mockClient({
      promptResult: {
        data: { parts: [{ type: 'text', text: 'Sorry, I could not review.' }] },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent');
    expect(result).toBeNull();

    expect(isReviewRequired(original)).toBe(true);
  });
});

// ─── buildReviewContentPrompt ────────────────────────────────────────────────
describe('buildReviewContentPrompt', () => {
  const opts = {
    content: 'PR diff content',
    ticketText: 'Fix auth bug',
    obligationId: '00000000-0000-0000-0000-000000000001',
    mandateDigest: 'a'.repeat(64),
    criteriaVersion: 'p35-v1',
    iteration: 1,
    planVersion: 1,
    discoveryContext: {},
  };

  it('includes content, ticket, and attestation values', () => {
    const prompt = buildReviewContentPrompt(opts);
    expect(prompt).toContain('PR diff content');
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain(opts.obligationId);
    expect(prompt).toContain(opts.mandateDigest);
    expect(prompt).toContain(opts.criteriaVersion);
    expect(prompt).toContain(REVIEWER_SUBAGENT_TYPE);
  });

  it('includes iteration and planVersion', () => {
    const prompt = buildReviewContentPrompt(opts);
    expect(prompt).toContain('1');
    expect(prompt).toContain('PlanVersion: 1');
  });

  it('handles empty ticket text', () => {
    const prompt = buildReviewContentPrompt({ ...opts, ticketText: '' });
    expect(prompt).not.toContain('Ticket context');
  });

  it('includes schema-allowed category guidance', () => {
    const prompt = buildReviewContentPrompt(opts);
    expect(prompt).toContain('completeness');
    expect(prompt).toContain('correctness');
    expect(prompt).toContain('feasibility');
    expect(prompt).toContain('risk');
    expect(prompt).toContain('quality');
  });

  it('includes output format instructions', () => {
    const prompt = buildReviewContentPrompt(opts);
    expect(prompt).toContain('ReviewFindings');
    expect(prompt).toContain('reviewMode');
    expect(prompt).toContain('no markdown fences');
  });
});

// ─── buildReviewContentMutatedOutput ─────────────────────────────────────────
describe('buildReviewContentMutatedOutput', () => {
  const findings = JSON.parse(
    JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'child-1' },
      reviewedAt: '2026-01-01T00:00:00.000Z',
      attestation: {
        mandateDigest: 'a'.repeat(64),
        criteriaVersion: 'p35-v1',
        toolObligationId: '00000000-0000-0000-0000-000000000001',
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    }),
  );

  it('returns null when findings are missing', () => {
    const result = buildReviewContentMutatedOutput('{}', {
      sessionId: 'child-1',
      findings: null as never,
      rawResponse: '',
    });
    expect(result).toBeNull();
  });

  it('injects pluginReviewFindings and review-specific next instruction', () => {
    const result = buildReviewContentMutatedOutput('{}', {
      sessionId: 'child-1',
      findings,
      rawResponse: '',
    });
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    expect(parsed.pluginReviewFindings).toBeDefined();
    expect(parsed.next).toContain('flowguard_review');
    expect(parsed.next).toContain('reviewFindings');
    expect(parsed.next).toContain('pluginReviewFindings');
    expect(parsed._pluginReviewSessionId).toBe('child-1');
  });

  it('does not contain plan/implement/architecture next instruction', () => {
    const result = buildReviewContentMutatedOutput('{}', {
      sessionId: 'child-1',
      findings,
      rawResponse: '',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.next).not.toContain('flowguard_plan');
    expect(parsed.next).not.toContain('reviewVerdict');
  });

  it('returns null on parse failure', () => {
    const result = buildReviewContentMutatedOutput('not-json', {
      sessionId: 'child-1',
      findings,
      rawResponse: '',
    });
    expect(result).toBeNull();
  });

  // BAD: footer format mutates /review output
  it('mutates /review output with NextAction footer', () => {
    const output = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: {
        reviewedBy: 'flowguard-reviewer',
        mandateDigest: 'a'.repeat(64),
        criteriaVersion: 'v1',
        toolObligationId: 'obl-1',
      },
    });
    const result = buildReviewContentMutatedOutput(output, {
      sessionId: 'child-1',
      findings: {
        overallVerdict: 'approve' as const,
        blockingIssues: [],
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        reviewedAt: '2026-01-01T00:00:00.000Z',
        reviewedBy: { sessionId: 'child-1', actorId: 'r' },
        attestation: {
          mandateDigest: 'a'.repeat(64),
          criteriaVersion: 'v1',
          toolObligationId: 'obl-1',
          iteration: 1,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer',
        },
      },
      rawResponse: '{}',
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.next).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toBeDefined();
  });
});

// ─── isReviewRequired with /review detection ─────────────────────────────────
describe('isReviewRequired for /review', () => {
  it('detects CONTENT_ANALYSIS_REQUIRED with requiredReviewAttestation for flowguard_review', () => {
    const output = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: {
        reviewedBy: 'flowguard-reviewer',
        mandateDigest: 'a'.repeat(64),
        criteriaVersion: 'p35-v1',
        toolObligationId: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(isReviewRequired(output, TOOL_FLOWGUARD_REVIEW)).toBe(true);
  });

  it('does not detect CONTENT_ANALYSIS_REQUIRED for non-review tools', () => {
    const output = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { reviewedBy: 'flowguard-reviewer' },
    });
    expect(isReviewRequired(output, 'flowguard_plan')).toBe(false);
  });

  it('still detects INDEPENDENT_REVIEW_REQUIRED prefix', () => {
    const output = JSON.stringify({
      next: 'INDEPENDENT_REVIEW_REQUIRED: call the reviewer',
    });
    expect(isReviewRequired(output)).toBe(true);
  });

  it('returns false for invalid JSON', () => {
    expect(isReviewRequired('not-json')).toBe(false);
  });
});

// ─── extractReviewContext for /review ────────────────────────────────────────
describe('extractReviewContext for /review', () => {
  it('extracts context from requiredReviewAttestation', () => {
    const result = extractReviewContext(TOOL_FLOWGUARD_REVIEW, {
      requiredReviewAttestation: {
        toolObligationId: '00000000-0000-0000-0000-000000000001',
        mandateDigest: 'a'.repeat(64),
        criteriaVersion: 'p35-v1',
      },
    });
    expect(result).toBeDefined();
    expect(result?.obligationId).toBe('00000000-0000-0000-0000-000000000001');
    expect(result?.iteration).toBe(1);
    expect(result?.planVersion).toBe(1);
  });

  it('returns null when requiredReviewAttestation is missing', () => {
    const result = extractReviewContext(TOOL_FLOWGUARD_REVIEW, {});
    expect(result).toBeNull();
  });

  it('returns null when toolObligationId is missing', () => {
    const result = extractReviewContext(TOOL_FLOWGUARD_REVIEW, {
      requiredReviewAttestation: { mandateDigest: 'a', criteriaVersion: 'b' },
    });
    expect(result).toBeNull();
  });
});

// ─── buildReviewContentPrompt edge cases ─────────────────────────────────────
describe('buildReviewContentPrompt edge cases', () => {
  const base = {
    content: 'test diff',
    ticketText: '',
    obligationId: '00000000-0000-0000-0000-000000000001',
    mandateDigest: 'a'.repeat(64),
    criteriaVersion: 'p35-v1',
    iteration: 0,
    planVersion: 1,
    discoveryContext: {},
  };

  it('handles zero iteration', () => {
    const prompt = buildReviewContentPrompt({ ...base, iteration: 0 });
    expect(prompt).toContain('Iteration: 0');
  });

  it('handles multiline content', () => {
    const prompt = buildReviewContentPrompt({
      ...base,
      content: 'line1\nline2\nline3',
      ticketText: 'fix auth',
    });
    expect(prompt).toContain('line1');
    expect(prompt).toContain('line2');
    expect(prompt).toContain('fix auth');
  });

  it('includes reviewMode: subagent instruction', () => {
    const prompt = buildReviewContentPrompt(base);
    expect(prompt).toContain('reviewMode');
    expect(prompt).toContain('subagent');
  });

  it('includes attestation fields in output', () => {
    const prompt = buildReviewContentPrompt(base);
    expect(prompt).toContain('ATTESTATION');
    expect(prompt).toContain('reviewedBy');
    expect(prompt).toContain('mandateDigest');
    expect(prompt).toContain('criteriaVersion');
    expect(prompt).toContain('toolObligationId');
  });

  it('produces non-empty output', () => {
    const prompt = buildReviewContentPrompt(base);
    expect(prompt.length).toBeGreaterThan(100);
  });

  // P9c: stack profile injection (review)
  describe('P9c — stack profile (review)', () => {
    it('does NOT include Stack Profile section when no profile data provided', () => {
      const prompt = buildReviewContentPrompt(base);
      expect(prompt).not.toContain('## Active Stack Profile');
      expect(prompt).not.toContain('## Stack Review Rules');
    });

    it('includes profile and rules when provided', () => {
      const prompt = buildReviewContentPrompt({
        ...base,
        profileName: 'backend-java',
        profileRules: '- Check Spring Boot\n- Validate JPA mappings',
      });
      expect(prompt).toContain('## Active Stack Profile');
      expect(prompt).toContain('backend-java');
      expect(prompt).toContain('## Stack Review Rules');
      expect(prompt).toContain('Spring Boot');
      expect(prompt).toContain('JPA');
    });
  });
});

// ─── isReviewRequired edge cases ──────────────────────────────────────────────
describe('isReviewRequired edge cases', () => {
  it('returns false for empty string', () => {
    expect(isReviewRequired('')).toBe(false);
  });

  it('returns false for object without error field', () => {
    expect(isReviewRequired(JSON.stringify({ code: 'OTHER' }), TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });

  it('returns false for CONTENT_ANALYSIS_REQUIRED without attestation', () => {
    expect(
      isReviewRequired(
        JSON.stringify({ error: true, code: 'CONTENT_ANALYSIS_REQUIRED' }),
        TOOL_FLOWGUARD_REVIEW,
      ),
    ).toBe(false);
  });
});

// ─── extractReviewContext edge cases ──────────────────────────────────────────
describe('extractReviewContext edge cases', () => {
  it('returns null for non-review tool without reviewObligation', () => {
    const result = extractReviewContext(TOOL_FLOWGUARD_REVIEW, {
      someField: 'value',
    });
    expect(result).toBeNull();
  });

  it('returns null when toolObligationId is empty string', () => {
    const result = extractReviewContext(TOOL_FLOWGUARD_REVIEW, {
      requiredReviewAttestation: {
        toolObligationId: '',
        mandateDigest: 'a',
        criteriaVersion: 'b',
      },
    });
    expect(result).toBeNull();
  });
});
// ─── buildReviewContentMutatedOutput extra edge cases ────────────────────────
describe('buildReviewContentMutatedOutput edge cases', () => {
  const findings = JSON.parse(
    JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'child-1' },
      reviewedAt: '2026-01-01T00:00:00.000Z',
      attestation: {
        mandateDigest: 'a'.repeat(64),
        criteriaVersion: 'p35-v1',
        toolObligationId: '00000000-0000-0000-0000-000000000001',
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    }),
  );

  it('preserves original fields from the blocked output', () => {
    const original = JSON.stringify({ code: 'CONTENT_ANALYSIS_REQUIRED', error: true });
    const result = buildReviewContentMutatedOutput(original, {
      sessionId: 's1',
      findings,
      rawResponse: '',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(parsed.error).toBe(true);
  });

  it('includes requiredReviewAttestation next instruction', () => {
    const result = buildReviewContentMutatedOutput('{}', {
      sessionId: 's1',
      findings,
      rawResponse: '',
    });
    const parsed = JSON.parse(result!);
    expect(parsed.next).toContain('reviewFindings');
    expect(parsed.next).toContain('pluginReviewFindings');
  });

  it('sets _pluginReviewSessionId correctly', () => {
    const result = buildReviewContentMutatedOutput('{}', {
      sessionId: 'child-session-xyz',
      findings,
      rawResponse: '',
    });
    const parsed = JSON.parse(result!);
    expect(parsed._pluginReviewSessionId).toBe('child-session-xyz');
  });
});

// ─── isReviewRequired with no toolName ────────────────────────────────────────
describe('isReviewRequired without toolName', () => {
  it('returns true for INDEPENDENT_REVIEW_REQUIRED without toolName arg', () => {
    const output = JSON.stringify({ next: 'INDEPENDENT_REVIEW_REQUIRED: test' });
    expect(isReviewRequired(output)).toBe(true);
  });

  it('returns false for CONTENT_ANALYSIS_REQUIRED without toolName arg', () => {
    const output = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { toolObligationId: 'x' },
    });
    expect(isReviewRequired(output)).toBe(false);
  });
});

// P9c: orchestrator profile rules mapping
describe('P9c — selectReviewerProfileRules mapping', () => {
  const profile = {
    name: 'backend-java',
    phaseRuleContent: {
      PLAN_REVIEW: 'plan-review-rules',
      IMPL_REVIEW: 'impl-review-rules',
      ARCH_REVIEW: 'arch-review-rules',
      REVIEW: 'standalone-review-rules',
    },
  };

  it('maps PLAN_REVIEW → planReviewRules', () => {
    const result = selectReviewerProfileRules(profile, 'PLAN_REVIEW');
    expect(result.profileName).toBe('backend-java');
    expect(result.profileRules).toBe('plan-review-rules');
  });

  it('maps IMPL_REVIEW → implReviewRules', () => {
    const result = selectReviewerProfileRules(profile, 'IMPL_REVIEW');
    expect(result.profileRules).toBe('impl-review-rules');
  });

  it('maps ARCH_REVIEW → archReviewRules', () => {
    const result = selectReviewerProfileRules(profile, 'ARCH_REVIEW');
    expect(result.profileRules).toBe('arch-review-rules');
  });

  it('maps REVIEW → standaloneReviewRules', () => {
    const result = selectReviewerProfileRules(profile, 'REVIEW');
    expect(result.profileRules).toBe('standalone-review-rules');
  });

  it('returns empty when activeProfile is null', () => {
    const result = selectReviewerProfileRules(null, 'PLAN_REVIEW');
    expect(result.profileName).toBeUndefined();
    expect(result.profileRules).toBeUndefined();
  });

  it('returns empty when phase is not in phaseRuleContent', () => {
    const result = selectReviewerProfileRules({ name: 'ts-node' }, 'PLAN_REVIEW');
    expect(result.profileName).toBe('ts-node');
    expect(result.profileRules).toBeUndefined();
  });

  it('does not leak IMPL_REVIEW rules into PLAN_REVIEW result', () => {
    const result = selectReviewerProfileRules(profile, 'PLAN_REVIEW');
    expect(result.profileRules).not.toBe('impl-review-rules');
  });
});
