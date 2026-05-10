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

vi.mock('./plugin-review-audit.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { readState } from '../adapters/persistence.js';
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET, IMPL_EVIDENCE } from '../__fixtures__.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_IMPLEMENT } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review-assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-bug16-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-bug16-test';
const NOW = '2026-05-10T13:00:00.000Z';

/**
 * Build a tool output string with a specific iteration and planVersion in the next field.
 * This simulates the Mode A output that the orchestrator intercepts.
 */
function reviewRequiredOutput(iteration: number, planVersion: number): string {
  return (
    JSON.stringify({
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
    }) + '\nNext action: Run /continue'
  );
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
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          iteration: 2,
          planVersion: 3,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          createdAt: NOW,
          pluginHandshakeAt: null,
          status: 'pending',
          invocationId: null,
          blockedCode: null,
          fulfilledAt: null,
          consumedAt: null,
        },
      ],
      // NO invocations → no host evidence → buildHostTaskPolicyOutput(null) path
      invocations: [],
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
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
      },
    },
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

  it('EDGE: missing iteration/planVersion in original next → no context suffix', async () => {
    // Original output has no iteration= or planVersion= pattern
    const malformedOutput =
      JSON.stringify({
        phase: 'PLAN',
        next: 'INDEPENDENT_REVIEW_REQUIRED: Review the plan.',
        reviewObligationId: OBLIGATION_ID,
        reviewObligationIteration: 0,
        reviewObligationPlanVersion: 1,
        reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
        reviewMandateDigest: REVIEW_MANDATE_DIGEST,
      }) + '\nNext action: Run /continue';

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
    // Should NOT contain "Context:" since there's no iteration/planVersion
    expect(parsed.next).not.toContain('Context:');
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
    const client = deps.client as { session: { create: ReturnType<typeof vi.fn> } };
    expect(client.session.create).not.toHaveBeenCalled();
  });
});
