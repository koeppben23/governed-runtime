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

// ═══════════════════════════════════════════════════════════════════════════════
// buildPlanReviewPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildPlanReviewPrompt', () => {
  const baseOpts: PlanReviewPromptOpts = {
    planText: '## Objective\nBuild feature X.\n## Steps\n1. Create file.ts',
    ticketText: 'Implement feature X for the users.',
    iteration: 0,
    planVersion: 1,
    obligationId: '11111111-1111-4111-8111-111111111111',
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest',
  };

  // HAPPY: produces a prompt containing all required elements
  it('includes plan text, ticket text, iteration, and planVersion', () => {
    const prompt = buildPlanReviewPrompt(baseOpts);
    expect(prompt).toContain('iteration=0');
    expect(prompt).toContain('planVersion=1');
    expect(prompt).toContain('Build feature X');
    expect(prompt).toContain('Implement feature X');
    expect(prompt).toContain('## Ticket');
    expect(prompt).toContain('## Plan to Review');
    expect(prompt).toContain('## Instructions');
  });

  // HAPPY: different iteration and planVersion values are reflected
  it('reflects custom iteration and planVersion', () => {
    const prompt = buildPlanReviewPrompt({ ...baseOpts, iteration: 2, planVersion: 3 });
    expect(prompt).toContain('iteration=2');
    expect(prompt).toContain('planVersion=3');
  });

  // EDGE: empty plan text still produces a prompt (reviewer will flag it)
  it('handles empty plan text', () => {
    const prompt = buildPlanReviewPrompt({ ...baseOpts, planText: '' });
    expect(prompt).toContain('## Plan to Review');
    expect(prompt).toContain('iteration=0');
  });

  // CORNER: plan text with special characters
  it('handles plan text with special characters', () => {
    const prompt = buildPlanReviewPrompt({
      ...baseOpts,
      planText: 'Plan with "quotes" and \n newlines and {braces}',
    });
    expect(prompt).toContain('"quotes"');
    expect(prompt).toContain('{braces}');
  });

  // CORNER: prompt length exceeds minimum (for L3 enforcement)
  it('produces prompt longer than MIN_SUBAGENT_PROMPT_LENGTH', () => {
    const prompt = buildPlanReviewPrompt(baseOpts);
    // MIN_SUBAGENT_PROMPT_LENGTH is 200 chars
    expect(prompt.length).toBeGreaterThan(200);
  });

  // SURVIVOR_KILL: pin every literal phrase emitted by the prompt builder so that
  // string-literal mutations cannot survive.
  it('emits every canonical instruction phrase verbatim', () => {
    const prompt = buildPlanReviewPrompt({
      ...baseOpts,
      iteration: 5,
      planVersion: 7,
      obligationId: 'OBL-42',
      criteriaVersion: 'CRIT-v9',
      mandateDigest: 'MD-deadbeef',
    });
    expect(prompt).toContain('You are reviewing a plan for iteration=5, planVersion=7.');
    expect(prompt).toContain('## Ticket');
    expect(prompt).toContain('## Plan to Review');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain(
      'Review this plan against the ticket requirements. Follow your review criteria',
    );
    expect(prompt).toContain(
      'for plans. Return your findings as a single JSON object matching the',
    );
    expect(prompt).toContain(
      'ReviewFindings schema. Use the exact iteration and planVersion values above.',
    );
    expect(prompt).toContain('Set iteration=5 and planVersion=7 in your response.');
    expect(prompt).toContain('Set attestation.toolObligationId=OBL-42.');
    expect(prompt).toContain('Set attestation.criteriaVersion=CRIT-v9.');
    expect(prompt).toContain('Set attestation.mandateDigest=MD-deadbeef.');
    expect(prompt).toContain('Set attestation.iteration=5.');
    expect(prompt).toContain('Set attestation.planVersion=7.');
    expect(prompt).toContain('Set attestation.reviewedBy="flowguard-reviewer".');
  });

  it('joins prompt lines with "\\n" (kills join-char string mutant)', () => {
    const prompt = buildPlanReviewPrompt(baseOpts);
    const lines = prompt.split('\n');
    // Empty join would collapse to 1 line; canonical prompt has many.
    expect(lines.length).toBeGreaterThan(15);
    // First line must be the canonical opening.
    expect(lines[0]).toBe('You are reviewing a plan for iteration=0, planVersion=1.');
    // Section headings must appear on their own lines surrounded by blanks.
    const ticketIdx = lines.indexOf('## Ticket');
    expect(ticketIdx).toBeGreaterThan(-1);
    expect(lines[ticketIdx - 1]).toBe('');
    expect(lines[ticketIdx + 1]).toBe('');
  });

  // P9c: stack profile injection
  describe('P9c — stack profile (plan)', () => {
    it('does NOT include Stack Profile section when no profile data provided', () => {
      const prompt = buildPlanReviewPrompt(baseOpts);
      expect(prompt).not.toContain('## Active Stack Profile');
      expect(prompt).not.toContain('## Stack Review Rules');
    });

    it('includes profile name when profileName is provided', () => {
      const prompt = buildPlanReviewPrompt({
        ...baseOpts,
        profileName: 'backend-java',
      });
      expect(prompt).toContain('## Active Stack Profile');
      expect(prompt).toContain('backend-java');
    });

    it('includes stack review rules when profileRules is provided', () => {
      const prompt = buildPlanReviewPrompt({
        ...baseOpts,
        profileName: 'backend-java',
        profileRules: '- Use Spring Boot conventions\n- Validate with JUnit 5',
      });
      expect(prompt).toContain('## Stack Review Rules');
      expect(prompt).toContain('Spring Boot');
      expect(prompt).toContain('JUnit 5');
    });

    it('profile section appears before Instructions', () => {
      const prompt = buildPlanReviewPrompt({
        ...baseOpts,
        profileName: 'ts-node',
        profileRules: 'Use strict TypeScript',
      });
      const profileIdx = prompt.indexOf('## Active Stack Profile');
      const instructionsIdx = prompt.indexOf('## Instructions');
      expect(profileIdx).toBeLessThan(instructionsIdx);
    });
  });
});

// P9c: phase-specific non-leakage — profileRules are phase-locked.
describe('P9c — profile rule non-leakage', () => {
  const makePlanOpts = (profileRules?: string) => ({
    planText: 'Test plan',
    ticketText: 'Test ticket',
    iteration: 0,
    planVersion: 1,
    obligationId: '11111111-1111-4111-8111-111111111111',
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-digest',
    profileName: 'backend-java',
    profileRules,
  });

  it('plan prompt does not contain IMPL_REVIEW, REVIEW, or ARCH_REVIEW rules', () => {
    const prompt = buildPlanReviewPrompt(makePlanOpts('plan-rule-123'));
    expect(prompt).toContain('plan-rule-123');
    expect(prompt).not.toContain('impl-rule-456');
    expect(prompt).not.toContain('review-rule-789');
    expect(prompt).not.toContain('arch-rule-abc');
  });

  it('impl prompt does not contain PLAN_REVIEW or ARCH_REVIEW rules', () => {
    const prompt = buildImplReviewPrompt({
      changedFiles: [],
      planText: 'Test',
      ticketText: 'Test',
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p35-v1',
      mandateDigest: 'test-digest',
      profileName: 'backend-java',
      profileRules: 'impl-rule-456',
    });
    expect(prompt).toContain('impl-rule-456');
    expect(prompt).not.toContain('plan-rule-123');
    expect(prompt).not.toContain('arch-rule-abc');
  });

  it('architecture prompt does not contain IMPL_REVIEW or REVIEW rules', () => {
    const prompt = buildArchitectureReviewPrompt({
      adrText: '# ADR',
      adrTitle: 'ADR-1',
      ticketText: 'Test',
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p35-v1',
      mandateDigest: 'test-digest',
      profileName: 'backend-java',
      profileRules: 'arch-rule-abc',
    });
    expect(prompt).toContain('arch-rule-abc');
    expect(prompt).not.toContain('impl-rule-456');
    expect(prompt).not.toContain('review-rule-789');
  });

  it('review prompt does not contain PLAN_REVIEW or IMPL_REVIEW rules', () => {
    const prompt = buildReviewContentPrompt({
      content: 'test content',
      ticketText: 'Test',
      obligationId: '11111111-1111-4111-8111-111111111111',
      mandateDigest: 'test-digest',
      criteriaVersion: 'p35-v1',
      iteration: 0,
      planVersion: 1,
      profileName: 'backend-java',
      profileRules: 'review-rule-789',
      discoveryContext: {},
    });
    expect(prompt).toContain('review-rule-789');
    expect(prompt).not.toContain('plan-rule-123');
    expect(prompt).not.toContain('impl-rule-456');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildImplReviewPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildImplReviewPrompt', () => {
  const baseOpts: ImplReviewPromptOpts = {
    changedFiles: ['src/foo.ts', 'src/bar.ts', 'test/foo.test.ts'],
    planText: '## Steps\n1. Modify foo.ts\n2. Add bar.ts',
    ticketText: 'Implement feature Y.',
    iteration: 1,
    planVersion: 2,
    obligationId: '11111111-1111-4111-8111-111111111111',
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest',
  };

  // HAPPY: includes all required elements
  it('includes changed files, plan, ticket, iteration, and planVersion', () => {
    const prompt = buildImplReviewPrompt(baseOpts);
    expect(prompt).toContain('iteration=1');
    expect(prompt).toContain('planVersion=2');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/bar.ts');
    expect(prompt).toContain('test/foo.test.ts');
    expect(prompt).toContain('Implement feature Y');
    expect(prompt).toContain('## Approved Plan');
    expect(prompt).toContain('## Changed Files');
  });

  // EDGE: empty changed files list
  it('handles empty changed files', () => {
    const prompt = buildImplReviewPrompt({ ...baseOpts, changedFiles: [] });
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('iteration=1');
  });

  // CORNER: changed files with special path characters
  it('handles paths with spaces and special characters', () => {
    const prompt = buildImplReviewPrompt({
      ...baseOpts,
      changedFiles: ['src/my file.ts', 'src/@scope/pkg.ts'],
    });
    expect(prompt).toContain('- src/my file.ts');
    expect(prompt).toContain('- src/@scope/pkg.ts');
  });

  // SURVIVOR_KILL: pin every literal phrase emitted by the impl prompt builder.
  it('emits every canonical instruction phrase verbatim', () => {
    const prompt = buildImplReviewPrompt({
      ...baseOpts,
      iteration: 4,
      planVersion: 6,
      obligationId: 'OBL-99',
      criteriaVersion: 'CRIT-impl-v3',
      mandateDigest: 'MD-cafebabe',
    });
    expect(prompt).toContain('You are reviewing an implementation for iteration=4, planVersion=6.');
    expect(prompt).toContain('## Ticket');
    expect(prompt).toContain('## Approved Plan');
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('Review this implementation against the approved plan and ticket.');
    expect(prompt).toContain(
      'Read the changed files using the read/glob/grep tools to verify correctness.',
    );
    expect(prompt).toContain('Follow your review criteria for implementations.');
    expect(prompt).toContain(
      'Return your findings as a single JSON object matching the ReviewFindings schema.',
    );
    expect(prompt).toContain('Set iteration=4 and planVersion=6 in your response.');
    expect(prompt).toContain('Set attestation.toolObligationId=OBL-99.');
    expect(prompt).toContain('Set attestation.criteriaVersion=CRIT-impl-v3.');
    expect(prompt).toContain('Set attestation.mandateDigest=MD-cafebabe.');
    expect(prompt).toContain('Set attestation.iteration=4.');
    expect(prompt).toContain('Set attestation.planVersion=6.');
    expect(prompt).toContain('Set attestation.reviewedBy="flowguard-reviewer".');
  });

  it('joins changed files with "\\n" using "- " bullet prefix', () => {
    const prompt = buildImplReviewPrompt({
      ...baseOpts,
      changedFiles: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(prompt).toContain('- a.ts\n- b.ts\n- c.ts');
  });

  // P9c: stack profile injection (impl)
  describe('P9c — stack profile (impl)', () => {
    it('does NOT include Stack Profile section when no profile data provided', () => {
      const prompt = buildImplReviewPrompt(baseOpts);
      expect(prompt).not.toContain('## Active Stack Profile');
    });

    it('includes stack profile when provided', () => {
      const prompt = buildImplReviewPrompt({
        ...baseOpts,
        profileName: 'angular-frontend',
        profileRules: '- Use standalone components\n- Check signal usage',
      });
      expect(prompt).toContain('## Active Stack Profile');
      expect(prompt).toContain('angular-frontend');
      expect(prompt).toContain('## Stack Review Rules');
      expect(prompt).toContain('standalone components');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildArchitectureReviewPrompt (F13 slice 6)
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildArchitectureReviewPrompt', () => {
  const baseOpts = {
    adrText: '## Context\nFoo.\n\n## Decision\nBar.\n\n## Consequences\nBaz.',
    adrTitle: 'ADR-001 Use X over Y',
    ticketText: 'Pick X or Y for the auth flow',
    iteration: 0,
    planVersion: 1,
    obligationId: '11111111-1111-4111-8111-111111111111',
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest',
  };

  it('includes ADR title in the section heading', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    expect(prompt).toContain('## ADR to Review: ADR-001 Use X over Y');
  });

  it('includes the full ADR text', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    expect(prompt).toContain('## Context\nFoo.');
    expect(prompt).toContain('## Decision\nBar.');
    expect(prompt).toContain('## Consequences\nBaz.');
  });

  it('embeds iteration and planVersion in the body and attestation lines', () => {
    const prompt = buildArchitectureReviewPrompt({
      ...baseOpts,
      iteration: 2,
      planVersion: 3,
    });
    expect(prompt).toContain('iteration=2, planVersion=3');
    expect(prompt).toContain('Set iteration=2 and planVersion=3');
    expect(prompt).toContain('Set attestation.iteration=2.');
    expect(prompt).toContain('Set attestation.planVersion=3.');
  });

  it('embeds obligationId, criteriaVersion, and mandateDigest in attestation block', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    expect(prompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(prompt).toContain('Set attestation.criteriaVersion=p35-v1.');
    expect(prompt).toContain('Set attestation.mandateDigest=test-mandate-digest.');
  });

  it('includes the ticket text for scope-creep verification', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    expect(prompt).toContain('## Ticket');
    expect(prompt).toContain('Pick X or Y for the auth flow');
  });

  it('instructs the reviewer to use ADR-specific review criteria', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    // Anchors the prompt to the REVIEWER_AGENT body section added in F13 slice 4.
    expect(prompt).toContain('Architecture');
    expect(prompt).toContain('problem framing');
    expect(prompt).toContain('alternatives considered');
    expect(prompt).toContain('reversibility');
    expect(prompt).toContain('out-of-scope clarity');
  });

  it('does NOT include a Changed Files section (ADR is a self-contained document)', () => {
    const prompt = buildArchitectureReviewPrompt(baseOpts);
    expect(prompt).not.toContain('## Changed Files');
  });

  it('handles empty ticket text without throwing', () => {
    const prompt = buildArchitectureReviewPrompt({ ...baseOpts, ticketText: '' });
    expect(prompt).toContain('## Ticket');
    expect(prompt).toContain('## ADR to Review:');
  });

  // P9c: stack profile injection (arch)
  describe('P9c — stack profile (arch)', () => {
    it('does NOT include Stack Profile section when no profile data provided', () => {
      const prompt = buildArchitectureReviewPrompt(baseOpts);
      expect(prompt).not.toContain('## Active Stack Profile');
    });

    it('includes stack profile when provided', () => {
      const prompt = buildArchitectureReviewPrompt({
        ...baseOpts,
        profileName: 'backend-java',
        profileRules: '- Check for JPA usage\n- Validate transaction boundaries',
      });
      expect(prompt).toContain('## Active Stack Profile');
      expect(prompt).toContain('backend-java');
      expect(prompt).toContain('## Stack Review Rules');
      expect(prompt).toContain('JPA');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// invokeReviewer
// ═══════════════════════════════════════════════════════════════════════════════

describe('invokeReviewer', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  const PROMPT = buildPlanReviewPrompt({
    planText: 'Test plan',
    ticketText: 'Test ticket',
    iteration: 0,
    planVersion: 1,
    obligationId: '11111111-1111-4111-8111-111111111111',
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest',
  });

  // HAPPY: successful invocation
  it('creates child session and invokes reviewer', async () => {
    const { REVIEW_FINDINGS_JSON_SCHEMA } = await import('./findings-schema.js');
    const client = mockClient();
    const result = await invokeReviewer(client, PROMPT, 'parent-session-1');

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('child-session-1');
    expect(result!.findings).not.toBeNull();
    expect(result!.findings!.overallVerdict).toBe('approve');

    // Verify SDK calls
    expect(client.session.create).toHaveBeenCalledWith({
      body: {
        parentID: 'parent-session-1',
        title: 'FlowGuard Independent Review',
      },
    });
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: 'child-session-1' },
      body: {
        agent: REVIEWER_SUBAGENT_TYPE,
        parts: [{ type: 'text', text: PROMPT }],
        format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
      },
    });
  });

  it('returns typed HOST_SUBAGENT_TASK_REQUIRED result without SDK calls when host task is required', async () => {
    const client = mockClient();
    const result = await invokeReviewer(client, PROMPT, 'parent-session-1', {
      reviewInvocationPolicy: 'host_task_required',
    });

    expect(result).toMatchObject({
      blocked: true,
      code: 'HOST_SUBAGENT_TASK_REQUIRED',
      reviewInvocation: {
        policy: 'host_task_required',
        status: 'blocked_until_host_task',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
      },
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  // BAD: session creation fails
  it('returns null when session creation fails', async () => {
    const client = mockClient({
      createResult: { error: { message: 'Failed' } },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // BAD: session creation returns no data
  it('returns null when session creation returns no data', async () => {
    const client = mockClient({
      createResult: { data: undefined, error: undefined },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // BAD: prompt fails
  it('returns null when prompt fails', async () => {
    const client = mockClient({
      promptResult: { error: { message: 'Prompt failed' } },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // BAD: prompt returns no data
  it('returns null when prompt returns no data', async () => {
    const client = mockClient({
      promptResult: { data: undefined, error: undefined },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // CORNER: prompt returns no structured output but valid JSON in text parts
  // With fail-closed strict mode, text fallback is NOT used — must return null.
  // This validates the FlowGuard invariant: only SDK-validated structured_output is accepted.
  it('returns null when structured_output is absent even if text parts contain valid JSON (fail-closed)', async () => {
    const client = mockClient({
      promptResult: {
        data: { parts: [{ type: 'text', text: validFindings() }] },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    // Fail-closed: text content is NOT accepted as structured output substitute
    expect(result).toBeNull();
  });

  // BAD: prompt returns no structured output AND no valid JSON in parts
  it('returns null when neither structured_output nor text parts have valid JSON', async () => {
    const client = mockClient({
      promptResult: {
        data: { parts: [{ type: 'text', text: 'I cannot review this.' }] },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // EDGE: structured output validation failed
  it('returns null when structured output validation failed', async () => {
    const client = mockClient({
      promptResult: {
        data: {
          info: { error: { name: 'StructuredOutputError', message: 'schema mismatch' } },
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).toBeNull();
  });

  // CORNER: runtime authoritatively overwrites reviewedBy.sessionId with childSessionId (B3)
  it('overwrites findings.reviewedBy.sessionId with authoritative childSessionId', async () => {
    const findingsJson = validFindings({ reviewedBy: { sessionId: 'reviewer-guessed-id' } });
    const client = mockClient({
      promptResult: {
        data: { info: { structured_output: JSON.parse(findingsJson) as Record<string, unknown> } },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).not.toBeNull();
    expect(result!.findings).not.toBeNull();
    expect(result!.reviewOutputMode).toBe('structured_output');
    expect(result!.structuredOutputUsed).toBe(true);
    expect(result!.reviewAssuranceLevel).toBe('structured_high');
    expect(result!.extractionMethod).toBeUndefined();
    const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
    // Authoritative override: real SDK childSessionId, NOT subagent-supplied guess.
    expect(reviewedBy.sessionId).toBe('child-session-1');
  });

  // CORNER: missing reviewedBy is reconstructed from authoritative childSessionId
  it('reconstructs reviewedBy when subagent omits it', async () => {
    const findingsJson = validFindings();
    const parsed = JSON.parse(findingsJson) as Record<string, unknown>;
    delete parsed.reviewedBy;
    const client = mockClient({
      promptResult: {
        data: { info: { structured_output: parsed } },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).not.toBeNull();
    const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe('child-session-1');
  });

  // P1.3 slice 4c: third LoopVerdict propagation through invokeReviewer.
  // Pins that subagent-emitted overallVerdict='unable_to_review' is
  // preserved verbatim through ReviewFindings parsing and authoritative
  // reviewedBy reconstruction. The downstream consumer
  // (plugin-orchestrator.ts) reads parsedFindings.data.overallVerdict
  // for the BLOCKED-routing branch; this test fixes that contract.
  it('propagates overallVerdict=unable_to_review verbatim (HAPPY: third verdict end-to-end)', async () => {
    const findingsJson = validFindings({
      overallVerdict: 'unable_to_review',
      blockingIssues: [],
      majorRisks: [],
    });
    const client = mockClient({
      promptResult: {
        data: { info: { structured_output: JSON.parse(findingsJson) as Record<string, unknown> } },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1');
    expect(result).not.toBeNull();
    expect(result!.findings).not.toBeNull();
    expect(result!.findings!.overallVerdict).toBe('unable_to_review');
    // Confirm reviewedBy is still authoritatively set; the unreviewable
    // verdict must NOT bypass childSessionId enforcement.
    const reviewedBy = result!.findings!.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe('child-session-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildMutatedOutput
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildMutatedOutput', () => {
  const reviewerResult: ReviewerSuccessResult = {
    sessionId: 'child-session-1',
    rawResponse: validFindings(),
    findings: JSON.parse(validFindings()) as Record<string, unknown>,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
  };

  // HAPPY: successful mutation
  it('replaces next field and injects findings', () => {
    const original = modeAOutput();
    const mutated = buildMutatedOutput(original, reviewerResult);

    expect(mutated).not.toBeNull();
    const parsed = JSON.parse(mutated!) as Record<string, unknown>;

    // next field should start with REVIEW_COMPLETED_PREFIX
    expect(typeof parsed.next).toBe('string');
    expect((parsed.next as string).startsWith(REVIEW_COMPLETED_PREFIX)).toBe(true);

    // Findings should be injected
    expect(parsed.pluginReviewFindings).toBeDefined();
    const findings = parsed.pluginReviewFindings as Record<string, unknown>;
    expect(findings.overallVerdict).toBe('approve');

    // Session ID should be injected
    expect(parsed._pluginReviewSessionId).toBe('child-session-1');

    // Original fields should be preserved
    expect(parsed.phase).toBe('PLAN');
    expect(parsed.reviewMode).toBe('subagent');
    expect(parsed.reviewObligationId).toBeDefined();
  });

  // HAPPY: mutation with changes_requested findings
  it('injects changes_requested findings correctly', () => {
    const changesFindings: ReviewerSuccessResult = {
      sessionId: 'child-session-2',
      rawResponse: validFindings({
        overallVerdict: 'changes_requested',
        blockingIssues: [{ severity: 'critical', message: 'Bug' }],
      }),
      findings: JSON.parse(
        validFindings({
          overallVerdict: 'changes_requested',
          blockingIssues: [{ severity: 'critical', message: 'Bug' }],
        }),
      ) as Record<string, unknown>,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    };

    const mutated = buildMutatedOutput(modeAOutput(), changesFindings);
    expect(mutated).not.toBeNull();

    const parsed = JSON.parse(mutated!) as Record<string, unknown>;
    const findings = parsed.pluginReviewFindings as Record<string, unknown>;
    expect(findings.overallVerdict).toBe('changes_requested');
  });

  // EDGE: findings is null (parsing failed) — fail-closed: returns null
  it('returns null when findings is null (fail-closed)', () => {
    const nullFindingsResult: ReviewerSuccessResult = {
      sessionId: 'child-session-3',
      rawResponse: 'Unparseable response text',
      findings: null,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    };
    const mutated = buildMutatedOutput(modeAOutput(), nullFindingsResult);
    expect(mutated).toBeNull();
  });

  // BAD: invalid original output
  it('returns null for invalid original output', () => {
    expect(buildMutatedOutput('not json', reviewerResult)).toBeNull();
  });

  // BAD: empty original output
  it('returns null for empty original output', () => {
    expect(buildMutatedOutput('', reviewerResult)).toBeNull();
  });

  // BAD: footer format — mutates JSON with NextAction footer
  it('mutates output with NextAction footer', () => {
    const output = JSON.stringify({ next: 'INDEPENDENT_REVIEW_REQUIRED: review me' });
    const mutated = buildMutatedOutput(output, reviewerResult);
    expect(mutated).not.toBeNull();
    const parsed = JSON.parse(mutated!);
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toBeDefined();
    expect(parsed._pluginReviewSessionId).toBeDefined();
  });

  // BAD: /plan footer mutation
  it('mutates /plan footer output to INDEPENDENT_REVIEW_COMPLETED', () => {
    const output = JSON.stringify({
      phase: 'PLAN',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call reviewer',
    });
    const mutated = buildMutatedOutput(output, reviewerResult);
    expect(mutated).not.toBeNull();
    const parsed = JSON.parse(mutated!);
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toBeDefined();
  });

  // BAD: /implement footer mutation
  it('mutates /implement footer output to INDEPENDENT_REVIEW_COMPLETED', () => {
    const output = JSON.stringify({
      phase: 'IMPLEMENTATION',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call reviewer',
    });
    const mutated = buildMutatedOutput(output, reviewerResult);
    expect(mutated).not.toBeNull();
    const parsed = JSON.parse(mutated!);
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toBeDefined();
  });

  // BAD: /architecture footer mutation
  it('mutates /architecture footer output to INDEPENDENT_REVIEW_COMPLETED', () => {
    const output = JSON.stringify({
      phase: 'ARCHITECTURE',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call reviewer',
    });
    const mutated = buildMutatedOutput(output, reviewerResult);
    expect(mutated).not.toBeNull();
    const parsed = JSON.parse(mutated!);
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toBeDefined();
  });
});
