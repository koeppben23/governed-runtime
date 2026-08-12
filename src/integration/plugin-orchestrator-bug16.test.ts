/**
 * @module integration/plugin-orchestrator-bug16.test
 * @description BUG-16 tests: buildHostTaskPolicyOutput preserves iteration/planVersion
 * from the original tool output's `next` field in the mutated output.
 *
 * BUG-18: Also verifies the reviewer-subagent "must NOT call FlowGuard tools" instruction.
 *
 * @test-policy HAPPY, EDGE, SMOKE — all categories present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapters/persistence.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { readState } from '../adapters/persistence.js';
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET, IMPL_EVIDENCE } from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_IMPLEMENT } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeSubagentCall,
} from './review/enforcement/enforcement.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import type { SessionState } from '../state/schema.js';
import type { OrchestratorClient } from './review/types.js';

const PARENT_SESSION_ID = 'parent-session-bug16-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-bug16-test';
const NOW = '2026-05-10T13:00:00.000Z';

/**
 * Build a tool output string with a specific iteration and planVersion in the next field.
 * This simulates the Mode A output that the orchestrator intercepts.
 */
function reviewRequiredOutput(iteration: number, planVersion: number): string {
  return JSON.stringify({
    phase: 'PLAN',
    next:
      `INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with a prompt that includes: ` +
      `(1) the full plan text, (2) the ticket text, (3) iteration=${iteration}, ` +
      `(4) planVersion=${planVersion}.`,
    reviewObligationId: OBLIGATION_ID,
    reviewObligationIteration: iteration,
    reviewObligationPlanVersion: planVersion,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
  });
}

function buildState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement: true,
      },
      reviewInvocationPolicy: 'host_task_required',
      reviewOutputPolicy: 'structured_required',
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v3' as const,
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          subjectDigest: 'test-subject-digest',
          iteration: 2,
          planVersion: 3,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerOutputRepairAttempts: 1,
          createdAt: NOW,
          pluginHandshakeAt: null,
          status: 'pending',
          invocationId: null,
          blockedCode: null,
          fulfilledAt: null,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change',
            paths: ['src/foo.ts'],
            revisions: ['base', 'head'],
          },
        },
      ],
      // NO invocations → no host evidence → buildHostTaskPolicyOutput(null) path
      invocations: [],
      attempts: [],
    },
    ...overrides,
  });
}

function buildDeps(stateRef: { current: SessionState }): OrchestratorDeps {
  const pendingReviews = new Map(
    [TOOL_FLOWGUARD_PLAN].map((tool) => [
      tool,
      {
        tool,
        requestedAt: NOW,
        subagentCalled: false,
        subagentRecord: null,
        contentMeta: { expectedIteration: 2, expectedPlanVersion: 3 },
        capturedFindings: null,
      },
    ]),
  );
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-bug16'),
    getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
    updateReviewAssurance: vi.fn().mockImplementation(async (_sessDir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
    blockReviewOutcome: vi.fn(),
    getEnforcementState: vi.fn().mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
    log: { info: vi.fn(), warn: vi.fn() },
    client: {
      app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
      },
    },
    adapter: createTestAdapter({
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
      },
    }),
  };
}

describe('BUG-16: buildHostTaskPolicyOutput preserves iteration/planVersion', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
  });

  it('HAPPY: preserves iteration=2 from original next field', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text here' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(parsed.next).toContain('iteration=2');
  });

  it('HAPPY: preserves planVersion=3 from original next field', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text here' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(parsed.next).toContain('planVersion=3');
  });

  it('EDGE: missing iteration/planVersion in original next → context falls back to obligation', async () => {
    // Original output has no iteration= or planVersion= pattern
    const malformedOutput = JSON.stringify({
      phase: 'PLAN',
      next: 'INDEPENDENT_REVIEW_REQUIRED: Review the plan.',
      reviewObligationId: OBLIGATION_ID,
      reviewObligationIteration: 0,
      reviewObligationPlanVersion: 1,
      reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    });

    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: malformedOutput };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text here' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    // Should still produce a valid next field (no crash on missing meta)
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_REQUIRED');
    // When the original `next` lacks iteration/planVersion, the host-task
    // instruction now falls back to the obligation's own values (issue: standalone
    // /review CONTENT_ANALYSIS has no `next`; the reviewer must still receive the
    // cycle context). The buildState() obligation is iteration=2, planVersion=3.
    expect(parsed.next).toContain('Context: iteration=2, planVersion=3');
  });

  it('EDGE: host_task_preferred first call → also preserves context', async () => {
    const state = buildState({
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        selfReview: {
          subagentEnabled: true,
          fallbackToSelf: false,
          strictEnforcement: true,
        },
        reviewInvocationPolicy: 'host_task_preferred',
        reviewOutputPolicy: 'structured_required',
      },
    });
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(0, 5) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(parsed.next).toContain('iteration=0');
    expect(parsed.next).toContain('planVersion=5');
    expect(parsed.next).toContain('Policy prefers');
    // Host-task contract (review-verdict disambiguation): verdict-only, and never
    // the dangerous "self-review fallback" / "submit the exact ReviewFindings" wording.
    expect(parsed.next).toContain('submit ONLY the verdict');
    expect(parsed.next).toContain('flowguard_review_implementation({ reviewerUnavailable: true })');
    expect(parsed.next).toContain('For other review types, report the transport failure and stop');
    expect(parsed.next).not.toMatch(/proceeds with self-review/i);
    expect(parsed.next).not.toMatch(/submit the exact ReviewFindings returned/i);
  });

  it('SMOKE: reviewer subagent instruction present (BUG-18)', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(1, 2) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(parsed.next).toContain('must NOT call any FlowGuard tools');
    expect(parsed.next).toContain('flowguard_plan');
    expect(parsed.next).toContain('flowguard_implement');
    expect(parsed.next).toContain('flowguard_architecture');
  });

  it('SMOKE: client session NOT invoked (host_task_required blocks before SDK path)', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    // Client should NOT be called — host_task_required blocks before SDK path
    expect(deps.client.session.create).not.toHaveBeenCalled();
  });

  it('BUG-19: next field includes a fail-closed reviewerUnavailable fallback instruction', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(0, 1) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(parsed.next).toContain('FALLBACK');
    expect(parsed.next).toContain('reviewerUnavailable: true');
    // Fail-closed semantics (review-verdict disambiguation): the fallback never
    // approves and never substitutes self-review.
    expect(parsed.next).toContain('REVIEWER_UNAVAILABLE_STRICT');
    expect(parsed.next).toContain('never approves');
    expect(parsed.next).not.toMatch(/self-review assurance/i);
  });

  // ─── F10: canonical copy-ready reviewer prompt ─────────────────────────────
  //
  // Root-cause fix for the first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT block:
  // the host-task blocked output now carries a reviewerTaskPrompt the agent can
  // paste verbatim as the Task prompt, and that prompt is built by the same
  // renderReviewContext serializer the enforcement matcher validates against.
  it('F10: host-task output carries a reviewerTaskPrompt with canonical context', async () => {
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const output = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };

    await runReviewOrchestration(deps, event);

    const parsed = JSON.parse(output.output);
    expect(typeof parsed.reviewerTaskPrompt).toBe('string');
    expect(parsed.reviewerTaskPrompt).toContain('iteration=2');
    expect(parsed.reviewerTaskPrompt).toContain('planVersion=3');
    expect(parsed.reviewerTaskPrompt).toContain(OBLIGATION_ID);
    // Anti-fabrication: the canonical prompt must not prefill a verdict.
    expect(parsed.reviewerTaskPrompt).not.toMatch(/overallVerdict"\s*:\s*"accept/i);
    // The next prose instructs verbatim use.
    expect(parsed.next).toContain('reviewerTaskPrompt');
    expect(parsed.next).toContain('VERBATIM');
  });

  it('F10: the emitted reviewerTaskPrompt passes enforcement on the FIRST attempt', async () => {
    // Reproduces the demo-log regression: previously the agent free-composed a
    // prompt WITHOUT iteration=/planVersion= and was blocked with
    // SUBAGENT_PROMPT_MISSING_CONTEXT on the first attempt. The canonical
    // reviewerTaskPrompt must clear the context requirement immediately.
    //
    // The canonical prompt ends by instructing the agent to append the artifact,
    // so the first attempt that follows that instruction is the prompt PLUS the
    // artifact. The instruction block on its own is asserted separately below.
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const toolOutput = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output: toolOutput,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };
    await runReviewOrchestration(deps, event);
    const parsed = JSON.parse(toolOutput.output);
    const reviewerTaskPrompt = parsed.reviewerTaskPrompt as string;

    // Register the pending review from the (mutated) tool output, exactly as the
    // plugin hook does, then run the real enforcement gate against the canonical
    // prompt the agent is told to paste, with the artifact appended below it.
    const enfState = createSessionState();
    onFlowGuardToolAfter(enfState, TOOL_FLOWGUARD_PLAN, {}, toolOutput.output, NOW);
    const result = enforceBeforeSubagentCall(enfState, {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: `${reviewerTaskPrompt}\n\n## Plan\n1. Fix auth\n2. Add tests\n`,
    });
    expect(result.allowed).toBe(true);
  });

  it('F10: the instruction block alone is blocked for the artifact, not for context', async () => {
    // The length floor and the iteration/planVersion match are both satisfied by
    // the canonical prompt by itself. Only the artifact requirement separates a
    // real review from dispatching a reviewer with nothing to review, and the
    // block must name that reason so the agent can act on it.
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const toolOutput = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output: toolOutput,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };
    await runReviewOrchestration(deps, event);
    const reviewerTaskPrompt = JSON.parse(toolOutput.output).reviewerTaskPrompt as string;

    const enfState = createSessionState();
    onFlowGuardToolAfter(enfState, TOOL_FLOWGUARD_PLAN, {}, toolOutput.output, NOW);
    const result = enforceBeforeSubagentCall(enfState, {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: reviewerTaskPrompt,
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('SUBAGENT_PROMPT_ARTIFACT_MISSING');
  });

  it('F10: a demo-log-style free-composed prompt (no iteration=/planVersion=) is still blocked', async () => {
    // Guard the enforcement is genuinely doing its job — the fix works because the
    // canonical prompt carries the context, NOT because enforcement was loosened.
    const state = buildState();
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const deps = buildDeps(stateRef);
    const toolOutput = { output: reviewRequiredOutput(2, 3) };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { args: { planText: 'Plan text' } },
      output: toolOutput,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    };
    await runReviewOrchestration(deps, event);

    const enfState = createSessionState();
    onFlowGuardToolAfter(enfState, TOOL_FLOWGUARD_PLAN, {}, toolOutput.output, NOW);
    // Attestation block present, but iteration=/planVersion= omitted — the exact
    // shape the agent produced in the failing demo run.
    const freeComposed =
      `You are the ${REVIEWER_SUBAGENT_TYPE} reviewer. Required attestation: ` +
      `toolObligationId=${OBLIGATION_ID}, mandateDigest=${REVIEW_MANDATE_DIGEST}, ` +
      `criteriaVersion=${REVIEW_CRITERIA_VERSION}. Review the plan for completeness, ` +
      `correctness, feasibility, risk, and quality, and return ReviewFindings JSON. ` +
      `Do not call any FlowGuard tools in your session.`;
    const result = enforceBeforeSubagentCall(enfState, {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: freeComposed,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('SUBAGENT_PROMPT_MISSING_CONTEXT');
    }
  });
});
