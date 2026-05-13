/**
 * @module integration/plugin-orchestrator-plan-ssot.test
 * @description Tests for BUG-09 fix: plan text SSOT enforcement.
 *
 * Validates:
 * - Plan review prompt always uses sessionState.plan.current.body (SSOT)
 * - toolArgs.planText from LLM is ignored (prevents post-compaction corruption)
 * - Mismatch logging for observability
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE — all categories present.
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
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET } from '../__fixtures__.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-ssot-1';
const CHILD_SESSION_ID = 'child-session-ssot-1';
const OBLIGATION_ID = '22222222-2222-4222-8222-222222222222';
const SESS_DIR = '/tmp/fg-plan-ssot-test';
const NOW = '2026-05-10T12:00:00.000Z';

const STATE_PLAN_TEXT = '## Plan\n1. Fix auth\n2. Add tests';

function reviewRequiredOutput(): string {
  return (
    JSON.stringify({
      phase: 'PLAN',
      next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer with iteration=1 and planVersion=1',
      reviewObligationId: OBLIGATION_ID,
      reviewObligationIteration: 1,
      reviewObligationPlanVersion: 1,
      reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    }) + '\nNext action: Run /continue'
  );
}

function buildFindings() {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: CHILD_SESSION_ID },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  };
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
      reviewOutputPolicy: 'structured_required',
    },
    reviewAssurance: {
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          iteration: 1,
          planVersion: 1,
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
      invocations: [],
    },
    ...overrides,
  });
}

/**
 * Build a mock client that captures the prompt text passed to session.prompt.
 * Returns the captured prompt for assertion.
 */
function buildCapturingClient(findings: Record<string, unknown>) {
  const capturedPrompts: string[] = [];
  return {
    client: {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
        prompt: vi
          .fn()
          .mockImplementation(async (req: { body?: { parts?: { text?: string }[] } }) => {
            const text = req?.body?.parts?.[0]?.text;
            if (text) capturedPrompts.push(text);
            return {
              data: { info: { structured_output: findings } },
              error: undefined,
            };
          }),
      },
    },
    capturedPrompts,
  };
}

function buildDeps(
  client: unknown,
  stateRef: { current: SessionState },
): { deps: OrchestratorDeps; logInfo: ReturnType<typeof vi.fn> } {
  const logInfo = vi.fn();
  const pendingReviews = new Map(
    [TOOL_FLOWGUARD_PLAN].map((tool) => [
      tool,
      {
        tool,
        requestedAt: NOW,
        subagentCalled: false,
        subagentRecord: null,
        contentMeta: { expectedIteration: 1, expectedPlanVersion: 1 },
        capturedFindings: null,
      },
    ]),
  );
  return {
    deps: {
      resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-ssot-1'),
      getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
      updateReviewAssurance: vi.fn().mockImplementation(async (_sessDir, update) => {
        stateRef.current = update(stateRef.current, NOW);
      }),
      blockReviewOutcome: vi
        .fn()
        .mockImplementation(async (_ctx, _obligationId, code, detail, output) => {
          output.output = JSON.stringify({ error: true, code, detail });
        }),
      getEnforcementState: vi
        .fn()
        .mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
      log: { info: logInfo, warn: vi.fn() },
      client,
    },
    logInfo,
  };
}

async function runPlanReview(
  toolArgsPlanText: string | undefined,
  stateOverrides: Partial<SessionState> = {},
) {
  const state = buildState(stateOverrides);
  const stateRef = { current: state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const { client, capturedPrompts } = buildCapturingClient(buildFindings());
  const { deps, logInfo } = buildDeps(client, stateRef);
  const output = { output: reviewRequiredOutput() };

  const input: Record<string, unknown> = { args: {} };
  if (toolArgsPlanText !== undefined) {
    (input.args as Record<string, unknown>).planText = toolArgsPlanText;
  }

  const event: ToolCallEvent = {
    toolName: TOOL_FLOWGUARD_PLAN,
    input,
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  };

  await runReviewOrchestration(deps, event);

  return { output, capturedPrompts, logInfo, state: stateRef.current, deps };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-09: Plan Text SSOT Enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-09: plan text SSOT enforcement', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY: state-sourced plan text', () => {
    it('plan review uses sessionState.plan.current.body, not toolArgs.planText', async () => {
      const llmPlanText = 'CORRUPTED HALLUCINATED PLAN FROM LLM';
      const { capturedPrompts } = await runPlanReview(llmPlanText);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      // SSOT plan text should appear in the prompt
      expect(prompt).toContain(STATE_PLAN_TEXT);
      // LLM-supplied corrupted text must NOT appear
      expect(prompt).not.toContain(llmPlanText);
    });

    it('toolArgs.planText ignored even when present and different', async () => {
      const differentPlan = 'Completely different plan text that should not be used';
      const { capturedPrompts } = await runPlanReview(differentPlan);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_PLAN_TEXT);
      expect(prompt).not.toContain(differentPlan);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD: empty state plan', () => {
    it('sessionState.plan.current.body is empty string -> empty plan in prompt', async () => {
      const emptyPlanState = {
        plan: {
          current: {
            body: '',
            digest: 'digest-empty',
            sections: [] as string[],
            createdAt: NOW,
          },
          history: [],
        },
      };
      const { capturedPrompts } = await runPlanReview('LLM fallback text', emptyPlanState);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      // Should contain empty plan section, not the LLM fallback
      expect(prompt).not.toContain('LLM fallback text');
      // The prompt should still have the review structure
      expect(prompt).toContain('## Plan to Review');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER: edge matching', () => {
    it('toolArgs.planText matches state exactly -> same result (no regression)', async () => {
      const { capturedPrompts } = await runPlanReview(STATE_PLAN_TEXT);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_PLAN_TEXT);
    });

    it('toolArgs.planText is not a string (number) -> state fallback used', async () => {
      // Force a non-string type through the tool args
      const { capturedPrompts } = await runPlanReview(42 as unknown as string);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_PLAN_TEXT);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────────

  describe('EDGE: large plan text', () => {
    it('plan text very long (>10K chars) -> full text passed to prompt', async () => {
      const longPlan = 'A'.repeat(15_000);
      const longPlanState = {
        plan: {
          current: {
            body: longPlan,
            digest: 'digest-long',
            sections: ['Plan'] as string[],
            createdAt: NOW,
          },
          history: [],
        },
      };
      const { capturedPrompts } = await runPlanReview('short LLM text', longPlanState);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(longPlan);
      expect(prompt).not.toContain('short LLM text');
    });
  });

  // ─── SMOKE ──────────────────────────────────────────────────────────────────

  describe('SMOKE: mismatch observability logging', () => {
    it('log contains planTextMismatch=true when toolArgs differs from state', async () => {
      const { logInfo } = await runPlanReview('DIFFERENT PLAN TEXT');

      const invokingCalls = logInfo.mock.calls.filter(
        (call: unknown[]) => call[0] === 'orchestrator' && call[1] === 'invoking reviewer subagent',
      );
      expect(invokingCalls.length).toBe(1);
      const extra = invokingCalls[0]![2] as Record<string, unknown>;
      expect(extra.planTextSource).toBe('sessionState');
      expect(extra.planTextLength).toBe(STATE_PLAN_TEXT.length);
      expect(extra.planTextMismatch).toBe(true);
      expect(extra.toolArgsPlanTextLength).toBe('DIFFERENT PLAN TEXT'.length);
    });

    it('log contains planTextMismatch=false when toolArgs matches state', async () => {
      const { logInfo } = await runPlanReview(STATE_PLAN_TEXT);

      const invokingCalls = logInfo.mock.calls.filter(
        (call: unknown[]) => call[0] === 'orchestrator' && call[1] === 'invoking reviewer subagent',
      );
      expect(invokingCalls.length).toBe(1);
      const extra = invokingCalls[0]![2] as Record<string, unknown>;
      expect(extra.planTextMismatch).toBe(false);
    });
  });
});
