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

describe('MUTATION_KILL: buildStackProfileSection via buildPlanReviewPrompt', () => {
  const baseOpts: PlanReviewPromptOpts = {
    planText: 'plan',
    ticketText: 'ticket',
    iteration: 0,
    planVersion: 1,
    obligationId: 'obl-1',
    criteriaVersion: 'v1',
    mandateDigest: 'digest-1',
  };

  it('includes stack profile section when profileName is provided', () => {
    const prompt = buildPlanReviewPrompt({ ...baseOpts, profileName: 'ts-node' });
    expect(prompt).toContain('## Active Stack Profile');
    expect(prompt).toContain('ts-node');
  });

  it('includes stack review rules when profileRules is provided', () => {
    const prompt = buildPlanReviewPrompt({ ...baseOpts, profileRules: 'Rule: no any types' });
    expect(prompt).toContain('## Stack Review Rules');
    expect(prompt).toContain('Rule: no any types');
  });

  it('includes both sections when both are provided', () => {
    const prompt = buildPlanReviewPrompt({
      ...baseOpts,
      profileName: 'react-app',
      profileRules: 'Must use hooks',
    });
    expect(prompt).toContain('## Active Stack Profile');
    expect(prompt).toContain('react-app');
    expect(prompt).toContain('## Stack Review Rules');
    expect(prompt).toContain('Must use hooks');
  });

  it('omits stack section when neither profileName nor profileRules given', () => {
    const prompt = buildPlanReviewPrompt(baseOpts);
    expect(prompt).not.toContain('## Active Stack Profile');
    expect(prompt).not.toContain('## Stack Review Rules');
  });
});

describe('MUTATION_KILL: invokeReviewer StructuredOutputError with structured_output present', () => {
  it('returns null even when structured_output co-exists with StructuredOutputError', async () => {
    // This kills the L534 BlockStatement mutation (removing the return null)
    const client = mockClient({
      promptResult: {
        data: {
          info: {
            error: { name: 'StructuredOutputError', message: 'schema validation failed' },
            structured_output: JSON.parse(validFindings()) as Record<string, unknown>,
          },
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent-1');
    expect(result).toBeNull();
  });

  it('returns findings when error name is NOT StructuredOutputError', async () => {
    // This kills L534 EqualityOperator mutation (=== to !==)
    const client = mockClient({
      promptResult: {
        data: {
          info: {
            error: { name: 'OtherError', message: 'something else' },
            structured_output: JSON.parse(validFindings()) as Record<string, unknown>,
          },
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent-1');
    expect(result).not.toBeNull();
    expect(result!.findings).not.toBeNull();
  });
});

describe('MUTATION_KILL: invokeReviewer reviewedBy injection edge cases', () => {
  it('creates reviewedBy when it is a non-object primitive (string)', async () => {
    const findings = JSON.parse(validFindings()) as Record<string, unknown>;
    findings.reviewedBy = 'not-an-object';
    const client = mockClient({
      promptResult: {
        data: { info: { structured_output: findings } },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent-1');
    expect(result).not.toBeNull();
    const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe('child-session-1');
  });

  it('creates reviewedBy when it is null', async () => {
    const findings = JSON.parse(validFindings()) as Record<string, unknown>;
    findings.reviewedBy = null;
    const client = mockClient({
      promptResult: {
        data: { info: { structured_output: findings } },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, 'test prompt', 'parent-1');
    expect(result).not.toBeNull();
    const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe('child-session-1');
  });
});

describe('MUTATION_KILL: isReviewRequired /review CONTENT_ANALYSIS_REQUIRED boundary', () => {
  it('returns false when error is true but code is wrong', () => {
    const output = JSON.stringify({
      error: true,
      code: 'SOME_OTHER_CODE',
      requiredReviewAttestation: { toolObligationId: 'x' },
    });
    expect(isReviewRequired(output, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });

  it('returns false when code is correct but error is false', () => {
    const output = JSON.stringify({
      error: false,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: { toolObligationId: 'x' },
    });
    expect(isReviewRequired(output, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });

  it('returns false when requiredReviewAttestation is not an object', () => {
    const output = JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      requiredReviewAttestation: 'not-object',
    });
    expect(isReviewRequired(output, TOOL_FLOWGUARD_REVIEW)).toBe(false);
  });
});

describe('MUTATION_KILL: extractReviewContext regex fallback with multi-digit and whitespace', () => {
  const baseFields = {
    reviewObligationId: '11111111-1111-4111-8111-111111111111',
    reviewCriteriaVersion: 'p35-v1',
    reviewMandateDigest: 'test-mandate-digest',
  };

  it('extracts multi-digit iteration from regex (kills \\d+ → \\d)', () => {
    const parsed = {
      ...baseFields,
      next: `${REVIEW_REQUIRED_PREFIX}: iteration=12, planVersion=34`,
    };
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(12);
    expect(ctx!.planVersion).toBe(34);
  });

  it('extracts iteration with whitespace separator (kills \\s → \\S)', () => {
    const parsed = {
      ...baseFields,
      next: `${REVIEW_REQUIRED_PREFIX}: iteration 5, planVersion 7`,
    };
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(5);
    expect(ctx!.planVersion).toBe(7);
  });

  it('extracts iteration with colon separator', () => {
    const parsed = {
      ...baseFields,
      next: `${REVIEW_REQUIRED_PREFIX}: iteration: 3, planVersion: 9`,
    };
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(3);
    expect(ctx!.planVersion).toBe(9);
  });

  it('returns null when iteration regex does not match (kills conditional true)', () => {
    const parsed = {
      ...baseFields,
      next: `${REVIEW_REQUIRED_PREFIX}: no numeric fields here`,
    };
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).toBeNull();
  });

  it('uses structured field over regex when both present', () => {
    const parsed = {
      ...baseFields,
      reviewObligationIteration: 10,
      reviewObligationPlanVersion: 20,
      next: `${REVIEW_REQUIRED_PREFIX}: iteration=99, planVersion=99`,
    };
    const ctx = extractReviewContext('flowguard_plan', parsed);
    expect(ctx).not.toBeNull();
    expect(ctx!.iteration).toBe(10);
    expect(ctx!.planVersion).toBe(20);
  });
});

describe('MUTATION_KILL: buildReviewContentPrompt with stack section', () => {
  const baseOpts = {
    content: 'file content here',
    ticketText: 'Fix bug #123',
    obligationId: 'obl-1',
    mandateDigest: 'digest-1',
    criteriaVersion: 'v1',
    iteration: 1,
    planVersion: 1,
    discoveryContext: {},
  };

  it('includes stack section when profileName and profileRules are given', () => {
    const prompt = buildReviewContentPrompt({
      ...baseOpts,
      profileName: 'ts-strict',
      profileRules: 'No implicit any',
    });
    expect(prompt).toContain('## Active Stack Profile');
    expect(prompt).toContain('ts-strict');
    expect(prompt).toContain('## Stack Review Rules');
    expect(prompt).toContain('No implicit any');
  });

  it('omits stack section when neither profileName nor profileRules given', () => {
    const prompt = buildReviewContentPrompt(baseOpts);
    expect(prompt).not.toContain('## Active Stack Profile');
    expect(prompt).not.toContain('## Stack Review Rules');
  });

  it('includes ticket context when ticketText is provided', () => {
    const prompt = buildReviewContentPrompt(baseOpts);
    expect(prompt).toContain('Ticket context: Fix bug #123');
  });

  it('omits ticket context when ticketText is empty', () => {
    const prompt = buildReviewContentPrompt({ ...baseOpts, ticketText: '' });
    expect(prompt).not.toContain('Ticket context:');
  });
});

// ---------------------------------------------------------------------------
// M2: format object retryCount regression guards (audit fix)
// ---------------------------------------------------------------------------

describe('M2 — retryCount in format object', () => {
  const PROMPT = 'Review this plan for correctness.';

  it('HAPPY — retryCount: 1 is sent to the server', async () => {
    // Without retryCount, the server defaults to 2 retries, wasting tokens
    // on deterministic schema failures. retryCount: 1 caps this.
    const client = mockClient();
    _resetAgentResolutionCache();
    await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: async () => {} });
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body.format.retryCount).toBe(1);
  });

  it('BAD — retryCount is not 0 (would disable retries entirely)', async () => {
    const client = mockClient();
    _resetAgentResolutionCache();
    await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: async () => {} });
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body.format.retryCount).not.toBe(0);
  });

  it('CORNER — retryCount is a positive integer', async () => {
    const client = mockClient();
    _resetAgentResolutionCache();
    await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: async () => {} });
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Number.isInteger(call.body.format.retryCount)).toBe(true);
    expect(call.body.format.retryCount).toBeGreaterThan(0);
  });

  it('EDGE — format type is json_schema alongside retryCount', async () => {
    const client = mockClient();
    _resetAgentResolutionCache();
    await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: async () => {} });
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body.format.type).toBe('json_schema');
    expect(call.body.format).toHaveProperty('schema');
    expect(call.body.format).toHaveProperty('retryCount', 1);
  });
});
