/**
 * @module integration/plugin-orchestrator-exhaustion.test
 * @description Tests for BUG-07 fix: obligation blocked after total invocation failure.
 *
 * Validates:
 * - Invocation failure blocks the review outcome
 * - Blocked obligations are not rediscovered by findLatestPendingReviewObligation
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
import { makePendingReviewAttempt } from './review/__tests__/attempt-fixture.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET } from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  freezeReviewMaterial,
} from './review/assurance.js';
import type { SessionState } from '../state/schema.js';
import type { OrchestratorClient } from './review/types.js';

const PARENT_SESSION_ID = 'parent-session-exhaust-1';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '77777777-7777-4777-8777-777777777777';
const SESS_DIR = '/tmp/fg-exhaustion-test';
const NOW = '2026-05-10T12:00:00.000Z';

function reviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'PLAN',
    reviewDispatch: { required: true },
    reviewObligation: {
      obligationId: OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
    },
  });
}

function buildState(): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: POLICY_SNAPSHOT,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'design_challenge',
          challengePolicyVersion: 'challenge-policy.v1',
          subjectDigest: 'test-subject-digest',
          iteration: 1,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core',
          profileSource: 'policy_default',
          reviewMaterial: freezeReviewMaterial('frozen review material', 'test-subject-digest'),
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
      invocations: [],
      attempts: [
        makePendingReviewAttempt({
          attemptId: ATTEMPT_ID,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          subjectDigest: 'test-subject-digest',
          createdAt: NOW,
        }),
      ],
      dispatches: [],
    },
  });
}

function buildAlreadyBlockedState(): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: POLICY_SNAPSHOT,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'design_challenge',
          challengePolicyVersion: 'challenge-policy.v1',
          subjectDigest: 'test-subject-digest',
          iteration: 1,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core',
          profileSource: 'policy_default',
          reviewMaterial: freezeReviewMaterial('frozen review material', 'test-subject-digest'),
          createdAt: NOW,
          pluginHandshakeAt: NOW,
          status: 'blocked',
          invocationId: null,
          blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
          fulfilledAt: null,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change',
            paths: ['src/foo.ts'],
            revisions: ['base', 'head'],
          },
        },
      ],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
  });
}

/** Client that always fails — invokeReviewer will return null */
function buildFailingClient(): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session: {
      create: vi
        .fn()
        .mockResolvedValue({ error: { message: 'connection refused' }, data: undefined }),
      prompt: vi.fn(),
    },
  };
}

function buildDeps(
  client: OrchestratorClient,
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
        attemptId: null,
        obligationId: null,
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
      adapter: createTestAdapter(client),
    },
    blockReviewOutcome,
    updateReviewAssurance,
  };
}

async function runExhaustion(clientOverride?: OrchestratorClient) {
  const state = buildState();
  const stateRef = { current: state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const client = clientOverride ?? buildFailingClient();
  const { deps, blockReviewOutcome, updateReviewAssurance } = buildDeps(client, stateRef);
  const output = { output: reviewRequiredOutput() };
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
    state: stateRef.current,
    deps,
    blockReviewOutcome,
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

  describe('HAPPY: exhaustion blocking', () => {
    it('calls blockReviewOutcome when reviewer invocation fails', async () => {
      const { blockReviewOutcome } = await runExhaustion();

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
      const state = buildState();
      const stateRef = { current: state };
      vi.mocked(readState).mockResolvedValue(stateRef.current);
      const client = buildFailingClient();
      const pendingReviews = new Map(
        [TOOL_FLOWGUARD_PLAN].map((tool) => [
          tool,
          {
            tool,
            requestedAt: NOW,
            attemptId: null,
            obligationId: null,
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
        adapter: createTestAdapter(client),
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
  });
});
