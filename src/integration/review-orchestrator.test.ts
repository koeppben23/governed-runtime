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
  invokeReviewer,
  extractResponseText,
  parseReviewerFindings,
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
// extractResponseText
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractResponseText', () => {
  // HAPPY: single text part
  it('extracts text from a single TextPart', () => {
    const parts = [{ type: 'text', text: 'Hello world' }];
    expect(extractResponseText(parts)).toBe('Hello world');
  });

  // HAPPY: multiple text parts are concatenated
  it('concatenates multiple text parts', () => {
    const parts = [
      { type: 'text', text: 'Part 1 ' },
      { type: 'text', text: 'Part 2' },
    ];
    expect(extractResponseText(parts)).toBe('Part 1 Part 2');
  });

  // HAPPY: non-text parts are filtered out
  it('filters out non-text parts', () => {
    const parts = [
      { type: 'reasoning', text: 'Thinking...' },
      { type: 'text', text: 'Response text' },
      { type: 'tool', text: 'tool output' },
    ];
    expect(extractResponseText(parts)).toBe('Response text');
  });

  // BAD: null parts
  it('returns null for null parts', () => {
    expect(extractResponseText(null)).toBeNull();
  });

  // BAD: undefined parts
  it('returns null for undefined parts', () => {
    expect(extractResponseText(undefined)).toBeNull();
  });

  // BAD: empty array
  it('returns null for empty array', () => {
    expect(extractResponseText([])).toBeNull();
  });

  // EDGE: only whitespace text
  it('returns null when text is only whitespace', () => {
    const parts = [{ type: 'text', text: '   \n  ' }];
    expect(extractResponseText(parts)).toBeNull();
  });

  // CORNER: parts with missing type or text
  it('skips parts with missing type', () => {
    const parts = [
      { text: 'no type' } as { type?: string; text?: string },
      { type: 'text', text: 'valid' },
    ];
    expect(extractResponseText(parts)).toBe('valid');
  });

  it('skips parts with missing text', () => {
    const parts = [
      { type: 'text' } as { type?: string; text?: string },
      { type: 'text', text: 'valid' },
    ];
    expect(extractResponseText(parts)).toBe('valid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseReviewerFindings
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseReviewerFindings', () => {
  // HAPPY: clean JSON
  it('parses clean JSON ReviewFindings', () => {
    const json = validFindings();
    const result = parseReviewerFindings(json);
    expect(result).not.toBeNull();
    expect(result!.overallVerdict).toBe('approve');
    expect(result!.blockingIssues).toEqual([]);
  });

  // HAPPY: changes_requested verdict with blocking issues
  it('parses changes_requested findings', () => {
    const json = validFindings({
      overallVerdict: 'changes_requested',
      blockingIssues: [
        { severity: 'critical', category: 'correctness', message: 'Bug found', location: 'foo.ts' },
      ],
    });
    const result = parseReviewerFindings(json);
    expect(result).not.toBeNull();
    expect(result!.overallVerdict).toBe('changes_requested');
    expect(Array.isArray(result!.blockingIssues)).toBe(true);
    expect((result!.blockingIssues as unknown[]).length).toBe(1);
  });

  // HAPPY: JSON embedded in surrounding text
  it('extracts JSON embedded in text', () => {
    const text = `Here are my findings:\n${validFindings()}\n\nThat concludes my review.`;
    const result = parseReviewerFindings(text);
    expect(result).not.toBeNull();
    expect(result!.overallVerdict).toBe('approve');
  });

  // BAD: completely invalid text
  it('returns null for completely invalid text', () => {
    expect(parseReviewerFindings('This is not JSON at all')).toBeNull();
  });

  // BAD: valid JSON but missing overallVerdict
  it('returns null for JSON without overallVerdict', () => {
    const json = JSON.stringify({ blockingIssues: [], iteration: 0 });
    expect(parseReviewerFindings(json)).toBeNull();
  });

  // BAD: valid JSON but invalid verdict value
  it('returns null for JSON with invalid verdict value', () => {
    const json = JSON.stringify({
      overallVerdict: 'maybe',
      blockingIssues: [],
    });
    expect(parseReviewerFindings(json)).toBeNull();
  });

  // BAD: valid JSON but missing blockingIssues array
  it('returns null for JSON without blockingIssues', () => {
    const json = JSON.stringify({ overallVerdict: 'approve' });
    expect(parseReviewerFindings(json)).toBeNull();
  });

  // EDGE: empty string
  it('returns null for empty string', () => {
    expect(parseReviewerFindings('')).toBeNull();
  });

  // CORNER: JSON wrapped in markdown code fences
  it('extracts JSON from markdown code fences', () => {
    const text = '```json\n' + validFindings() + '\n```';
    const result = parseReviewerFindings(text);
    expect(result).not.toBeNull();
    expect(result!.overallVerdict).toBe('approve');
  });

  // CORNER: nested JSON objects (findings within findings-like structure)
  it('handles nested JSON correctly', () => {
    const findings = validFindings({
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'Object {foo: "bar"} is wrong',
          location: 'src/x.ts:10',
        },
      ],
      overallVerdict: 'changes_requested',
    });
    const result = parseReviewerFindings(findings);
    expect(result).not.toBeNull();
    expect(result!.overallVerdict).toBe('changes_requested');
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

  // CORNER: reviewer returns valid findings with session ID
  it('captures session ID from reviewer findings', async () => {
    const findingsJson = validFindings({ reviewedBy: { sessionId: 'reviewer-ses-42' } });
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
    expect(reviewedBy.sessionId).toBe('reviewer-ses-42');
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
    expect(parsed._pluginReviewFindings).toBeDefined();
    const findings = parsed._pluginReviewFindings as Record<string, unknown>;
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
    const findings = parsed._pluginReviewFindings as Record<string, unknown>;
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
    expect(mutatedParsed._pluginReviewFindings).toBeDefined();
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
