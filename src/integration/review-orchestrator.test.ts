/**
 * @module integration/review-orchestrator.test
 * @description Tests for the deterministic review subagent orchestrator.
 *
 * Validates:
 * - Prompt building for plan and implementation reviews
 * - SDK client invocation with mock client
 * - Response text extraction from various Part shapes
 * - ReviewFindings parsing (clean JSON, embedded JSON, invalid)
 * - Output mutation (INDEPENDENT_REVIEW_REQUIRED → COMPLETED)
 * - Review-required detection
 * - Review context extraction from tool output
 * - Error handling and graceful degradation
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  buildReviewContentPrompt,
  buildReviewContentMutatedOutput,
  invokeReviewer,
  buildMutatedOutput,
  isReviewRequired,
  extractReviewContext,
  REVIEW_COMPLETED_PREFIX,
  type OrchestratorClient,
  type PlanReviewPromptOpts,
  type ImplReviewPromptOpts,
  type ReviewerResult,
} from './review-orchestrator.js';
import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './review-enforcement.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';

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
  } = {},
): OrchestratorClient {
  return {
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
    _audit: { transitions: [] },
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// invokeReviewer
// ═══════════════════════════════════════════════════════════════════════════════

describe('invokeReviewer', () => {
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
    const { REVIEW_FINDINGS_JSON_SCHEMA } = await import('./review-orchestrator.js');
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
        format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA },
      },
    });
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

  // BAD: prompt returns no structured output
  it('returns null when prompt returns no structured output', async () => {
    const client = mockClient({
      promptResult: {
        data: { parts: [{ type: 'text', text: validFindings() }] },
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
  const reviewerResult: ReviewerResult = {
    sessionId: 'child-session-1',
    rawResponse: validFindings(),
    findings: JSON.parse(validFindings()) as Record<string, unknown>,
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
    expect(parsed._audit).toBeDefined();
  });

  // HAPPY: mutation with changes_requested findings
  it('injects changes_requested findings correctly', () => {
    const changesFindings: ReviewerResult = {
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
    };

    const mutated = buildMutatedOutput(modeAOutput(), changesFindings);
    expect(mutated).not.toBeNull();

    const parsed = JSON.parse(mutated!) as Record<string, unknown>;
    const findings = parsed.pluginReviewFindings as Record<string, unknown>;
    expect(findings.overallVerdict).toBe('changes_requested');
  });

  // EDGE: findings is null (parsing failed) — fail-closed: returns null
  it('returns null when findings is null (fail-closed)', () => {
    const nullFindingsResult: ReviewerResult = {
      sessionId: 'child-session-3',
      rawResponse: 'Unparseable response text',
      findings: null,
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// isReviewRequired
// ═══════════════════════════════════════════════════════════════════════════════

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
    expect(mutatedParsed._audit).toBeDefined();
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
    expect(parsed.next).toContain('analysisFindings');
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
    expect(parsed.next).not.toContain('selfReviewVerdict');
  });

  it('returns null on parse failure', () => {
    const result = buildReviewContentMutatedOutput('not-json', {
      sessionId: 'child-1',
      findings,
      rawResponse: '',
    });
    expect(result).toBeNull();
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
    expect(parsed.next).toContain('analysisFindings');
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
