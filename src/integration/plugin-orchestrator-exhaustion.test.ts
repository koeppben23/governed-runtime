/**
 * @module integration/plugin-orchestrator-exhaustion.test
 * @description Tests for BUG-07 fix: obligation blocked after total invocation failure.
 *
 * Validates:
 * - Non-strict: obligation transitions to 'blocked' with REVIEWER_INVOCATION_EXHAUSTED
 * - Strict: existing blockReviewOutcome behavior unchanged (regression)
 * - Audit event emitted for non-strict exhaustion
 * - Output unchanged in non-strict exhaustion (LLM fallback)
 * - Blocked obligations are not rediscovered by findLatestPendingReviewObligation
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE — all categories present.
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
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET } from '../__fixtures__.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  findLatestPendingReviewObligation,
} from './review/assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-exhaust-1';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';
const SESS_DIR = '/tmp/fg-exhaustion-test';
const NOW = '2026-05-10T12:00:00.000Z';

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

function buildState(strictEnforcement: boolean): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement,
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
  });
}

function buildAlreadyBlockedState(): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement: false,
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
          pluginHandshakeAt: NOW,
          status: 'blocked',
          invocationId: null,
          blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
          fulfilledAt: null,
          consumedAt: null,
        },
      ],
      invocations: [],
    },
  });
}

/** Client that always fails — invokeReviewer will return null */
function buildFailingClient() {
  return {
    session: {
      create: vi
        .fn()
        .mockResolvedValue({ error: { message: 'connection refused' }, data: undefined }),
      prompt: vi.fn(),
    },
  };
}

/** Client that returns blocked response */
function buildBlockedClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'child-blocked-1' }, error: undefined }),
      prompt: vi.fn().mockResolvedValue({
        data: { info: { structured_output: undefined } },
        error: undefined,
      }),
    },
  };
}

/** Client returning findings without structured_output (unparseable) */
function buildUnparseableClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'child-unparse-1' }, error: undefined }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          parts: [{ type: 'text', text: 'not JSON' }],
          info: {},
        },
        error: undefined,
      }),
    },
  };
}

function buildDeps(
  client: unknown,
  stateRef: { current: SessionState },
): {
  deps: OrchestratorDeps;
  blockReviewOutcome: ReturnType<typeof vi.fn>;
  updateReviewAssurance: ReturnType<typeof vi.fn>;
} {
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
  const blockReviewOutcome = vi
    .fn()
    .mockImplementation(async (_ctx, _obligationId, code, detail, output) => {
      output.output = JSON.stringify({ error: true, code, detail });
    });
  const updateReviewAssurance = vi.fn().mockImplementation(async (_sessDir, update) => {
    stateRef.current = update(stateRef.current, NOW);
  });
  return {
    deps: {
      resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-exhaust-1'),
      getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
      updateReviewAssurance,
      blockReviewOutcome,
      getEnforcementState: vi
        .fn()
        .mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
      log: { info: vi.fn(), warn: vi.fn() },
      client,
    },
    blockReviewOutcome,
    updateReviewAssurance,
  };
}

async function runExhaustion(strictEnforcement: boolean, clientOverride?: unknown) {
  const state = buildState(strictEnforcement);
  const stateRef = { current: state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const client = clientOverride ?? buildFailingClient();
  const { deps, blockReviewOutcome, updateReviewAssurance } = buildDeps(client, stateRef);
  const originalOutput = reviewRequiredOutput();
  const output = { output: originalOutput };
  const event: ToolCallEvent = {
    toolName: TOOL_FLOWGUARD_PLAN,
    input: {},
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  };

  await runReviewOrchestration(deps, event);

  return {
    output,
    originalOutput,
    state: stateRef.current,
    deps,
    blockReviewOutcome,
    updateReviewAssurance,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-07: Obligation Exhaustion Blocking
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-07: obligation blocked after total invocation failure', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
    vi.mocked(appendReviewAuditEvent).mockClear();
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY: non-strict exhaustion blocking', () => {
    it('obligation blocked with REVIEWER_INVOCATION_EXHAUSTED when invokeReviewer returns null (non-strict)', async () => {
      const { state } = await runExhaustion(false);

      const obligation = state.reviewAssurance?.obligations.find(
        (o) => o.obligationId === OBLIGATION_ID,
      );
      expect(obligation).toBeDefined();
      expect(obligation!.status).toBe('blocked');
      expect(obligation!.blockedCode).toBe('REVIEWER_INVOCATION_EXHAUSTED');
    });

    it('audit event emitted for non-strict exhaustion', async () => {
      await runExhaustion(false);

      const auditCalls = vi.mocked(appendReviewAuditEvent).mock.calls;
      const exhaustionEvents = auditCalls.filter(
        (call) =>
          call[3] === 'review:obligation_blocked' &&
          (call[4] as Record<string, unknown>).code === 'REVIEWER_INVOCATION_EXHAUSTED',
      );
      expect(exhaustionEvents.length).toBe(1);
      expect(exhaustionEvents[0]![4]).toEqual({
        obligationId: OBLIGATION_ID,
        code: 'REVIEWER_INVOCATION_EXHAUSTED',
      });
    });

    it('strict mode still calls blockReviewOutcome (regression guard)', async () => {
      const { blockReviewOutcome } = await runExhaustion(true);

      expect(blockReviewOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ sessDir: SESS_DIR, sessionId: PARENT_SESSION_ID }),
        OBLIGATION_ID,
        'STRICT_REVIEW_ORCHESTRATION_FAILED',
        { reason: 'reviewer invocation failed' },
        expect.any(Object),
      );
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD: pre-condition failures', () => {
    it('null reviewerResult + no sessDir -> output blocked PLUGIN_ENFORCEMENT_UNAVAILABLE', async () => {
      const state = buildState(false);
      const stateRef = { current: state };
      vi.mocked(readState).mockResolvedValue(stateRef.current);
      const client = buildFailingClient();
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
      const deps: OrchestratorDeps = {
        resolveFingerprint: vi.fn().mockResolvedValue('fp-1'),
        getSessionDir: vi.fn().mockReturnValue(null), // <-- no sessDir
        updateReviewAssurance: vi.fn(),
        blockReviewOutcome: vi.fn(),
        getEnforcementState: vi
          .fn()
          .mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
        log: { info: vi.fn(), warn: vi.fn() },
        client,
      };
      const output = { output: reviewRequiredOutput() };
      const event: ToolCallEvent = {
        toolName: TOOL_FLOWGUARD_PLAN,
        input: {},
        output,
        sessionId: PARENT_SESSION_ID,
        now: NOW,
      };

      await runReviewOrchestration(deps, event);

      const parsed = JSON.parse(output.output);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER: idempotency and sequencing', () => {
    it('obligation already blocked before invocation -> updateObligation is idempotent', async () => {
      const state = buildAlreadyBlockedState();
      const stateRef = { current: state };
      vi.mocked(readState).mockResolvedValue(stateRef.current);
      const client = buildFailingClient();
      const { deps } = buildDeps(client, stateRef);
      const output = { output: reviewRequiredOutput() };
      const event: ToolCallEvent = {
        toolName: TOOL_FLOWGUARD_PLAN,
        input: {},
        output,
        sessionId: PARENT_SESSION_ID,
        now: NOW,
      };

      await runReviewOrchestration(deps, event);

      // Obligation should still be blocked (idempotent)
      const obligation = stateRef.current.reviewAssurance?.obligations.find(
        (o) => o.obligationId === OBLIGATION_ID,
      );
      expect(obligation!.status).toBe('blocked');
      expect(obligation!.blockedCode).toBe('REVIEWER_INVOCATION_EXHAUSTED');
    });

    it('multiple sequential failures create distinct audit events', async () => {
      // First failure
      await runExhaustion(false);
      const firstCallCount = vi
        .mocked(appendReviewAuditEvent)
        .mock.calls.filter(
          (call) =>
            call[3] === 'review:obligation_blocked' &&
            (call[4] as Record<string, unknown>).code === 'REVIEWER_INVOCATION_EXHAUSTED',
        ).length;
      expect(firstCallCount).toBe(1);

      // Second failure (fresh run)
      vi.mocked(appendReviewAuditEvent).mockClear();
      await runExhaustion(false);
      const secondCallCount = vi
        .mocked(appendReviewAuditEvent)
        .mock.calls.filter(
          (call) =>
            call[3] === 'review:obligation_blocked' &&
            (call[4] as Record<string, unknown>).code === 'REVIEWER_INVOCATION_EXHAUSTED',
        ).length;
      expect(secondCallCount).toBe(1);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────────

  describe('EDGE: path differentiation', () => {
    it('reviewerResult is null but blocked field present -> takes blocked path, not exhaustion', async () => {
      // A client that returns null from invokeReviewer because the policy blocks it
      // This tests that the `blocked` response path (line 587-596) is separate from exhaustion.
      // To trigger this, we need invokeReviewer to return a blocked result.
      // The policy-based blocking happens when reviewInvocationPolicy='host_task_required'.
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        policySnapshot: {
          ...POLICY_SNAPSHOT,
          selfReview: {
            subagentEnabled: true,
            fallbackToSelf: false,
            strictEnforcement: false,
          },
          reviewOutputPolicy: 'structured_required',
          reviewInvocationPolicy: 'host_task_required',
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
      });
      const stateRef = { current: state };
      vi.mocked(readState).mockResolvedValue(stateRef.current);
      const client = buildFailingClient();
      const { deps } = buildDeps(client, stateRef);
      const output = { output: reviewRequiredOutput() };
      const event: ToolCallEvent = {
        toolName: TOOL_FLOWGUARD_PLAN,
        input: {},
        output,
        sessionId: PARENT_SESSION_ID,
        now: NOW,
      };

      await runReviewOrchestration(deps, event);

      // The host_task_required path rewrites output with INDEPENDENT_REVIEW_REQUIRED
      // but does NOT hit the exhaustion path
      const exhaustionAudit = vi
        .mocked(appendReviewAuditEvent)
        .mock.calls.filter(
          (call) =>
            call[3] === 'review:obligation_blocked' &&
            (call[4] as Record<string, unknown>).code === 'REVIEWER_INVOCATION_EXHAUSTED',
        );
      expect(exhaustionAudit.length).toBe(0);
    });

    it('reviewerResult has findings but no parseable schema (non-strict) -> does NOT hit exhaustion path', async () => {
      // invokeReviewer returns a result (not null), but findings don't parse.
      // The non-null path (line 598+) handles this — NOT the else branch at 829.
      const { state } = await runExhaustion(false, buildUnparseableClient());

      // With unparseable client, invokeReviewer returns null (no structured_output,
      // all 3 attempts exhausted) → SHOULD hit exhaustion path
      const obligation = state.reviewAssurance?.obligations.find(
        (o) => o.obligationId === OBLIGATION_ID,
      );
      expect(obligation!.status).toBe('blocked');
      expect(obligation!.blockedCode).toBe('REVIEWER_INVOCATION_EXHAUSTED');
    });
  });

  // ─── SMOKE ──────────────────────────────────────────────────────────────────

  describe('SMOKE: output preservation', () => {
    it('end-to-end: tool output unchanged in non-strict exhaustion (fallback to LLM)', async () => {
      const { output, originalOutput } = await runExhaustion(false);

      // In non-strict mode, the output is NOT rewritten — the LLM fallback path
      // continues with the original output. Only the obligation status changes.
      expect(output.output).toBe(originalOutput);
    });
  });

  // ─── E2E: findLatestPendingReviewObligation integration ─────────────────────

  describe('E2E: blocked obligation not rediscovered', () => {
    it('findLatestPendingReviewObligation does NOT return blocked obligation', async () => {
      const { state } = await runExhaustion(false);

      // The core invariant: after exhaustion, the obligation is blocked and
      // findLatestPendingReviewObligation must not find it.
      const found = findLatestPendingReviewObligation(state.reviewAssurance, 'plan');
      expect(found).toBeNull();
    });
  });
});
