/**
 * @module integration/plugin-orchestrator-unable.test
 * @description P1.3 slice 4c — pins BLOCKED routing in
 * `runReviewOrchestration` when the subagent reviewer emits
 * `overallVerdict: 'unable_to_review'`.
 *
 * Contract under test (plugin-orchestrator.ts):
 * - In strict-enforcement mode, a parsed findings payload with
 *   `overallVerdict === 'unable_to_review'` MUST trigger
 *   `deps.blockReviewOutcome(ctx, obligationId, 'SUBAGENT_UNABLE_TO_REVIEW',
 *   {...}, output)` and MUST NOT proceed to fulfillment / mutated output.
 * - The HAPPY non-strict-blocked path (verdict='approve') must NOT call
 *   blockReviewOutcome with code 'SUBAGENT_UNABLE_TO_REVIEW' (regression
 *   guard against accidental branch capture).
 *
 * This test exercises the strict-enforcement branch of
 * runReviewOrchestration end-to-end with mocked I/O modules
 * (persistence, audit) and a mocked OpenCode SDK client.
 *
 * @test-policy HAPPY (strict approve, strict unable_to_review).
 *   CORNER coverage for non-strict and unable_to_review-without-strict
 *   is intentionally deferred to slice 8 e2e.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks for I/O modules used by plugin-orchestrator ────────────────────────
// These must be declared BEFORE the module under test is imported, so that
// the import graph picks up the mocked versions.

vi.mock('../adapters/persistence.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));

vi.mock('./plugin-review-audit.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { readState } from '../adapters/persistence.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type {
  OrchestratorDeps,
  ToolCallEvent,
} from './plugin-orchestrator.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import { REVIEW_REQUIRED_PREFIX } from './review-enforcement.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review-assurance.js';
import { POLICY_SNAPSHOT, makeState } from '../__fixtures__.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const PARENT_SESSION_ID = 'parent-session-1';
const CHILD_SESSION_ID = 'child-session-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-mock-sess-dir';

/** Build a Mode A plan tool output with INDEPENDENT_REVIEW_REQUIRED. */
function modeAPlanOutput(): string {
  return JSON.stringify({
    ok: true,
    phase: 'PLAN',
    next: `${REVIEW_REQUIRED_PREFIX} obligationId=${OBLIGATION_ID} iteration=0 planVersion=1`,
    reviewObligation: {
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
    },
  });
}

/** Build a ReviewFindings JSON string with configurable verdict. */
function findingsWithVerdict(verdict: 'approve' | 'unable_to_review'): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: CHILD_SESSION_ID },
    reviewedAt: '2026-04-24T12:00:00.000Z',
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  });
}

/** Mock OpenCode SDK client with a configurable findings payload. */
function buildMockClient(findingsJson: string) {
  return {
    session: {
      create: vi
        .fn()
        .mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          parts: [{ type: 'text', text: findingsJson }],
          info: { structured_output: JSON.parse(findingsJson) as Record<string, unknown> },
        },
        error: undefined,
      }),
    },
  };
}

/** Build a minimal OrchestratorDeps with spies. */
function buildDeps(client: unknown): {
  deps: OrchestratorDeps;
  blockReviewOutcome: ReturnType<typeof vi.fn>;
  updateReviewAssurance: ReturnType<typeof vi.fn>;
} {
  const blockReviewOutcome = vi
    .fn()
    .mockImplementation(
      async (
        _ctx: unknown,
        _oid: string,
        code: string,
        detail: Record<string, string>,
        output: { output: string },
      ) => {
        // Simulate strict-blocked output shape so downstream
        // parseToolResult(...).error === true short-circuits the
        // mutated-output path (mirrors plugin-workspace impl).
        output.output = JSON.stringify({ error: true, code, detail });
      },
    );
  const updateReviewAssurance = vi.fn().mockResolvedValue(undefined);
  const deps: OrchestratorDeps = {
    resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-1'),
    getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
    updateReviewAssurance,
    blockReviewOutcome,
    getEnforcementState: vi.fn().mockReturnValue({
      sessionId: PARENT_SESSION_ID,
      pluginReviews: new Map(),
    }),
    log: { info: vi.fn(), warn: vi.fn() },
    client,
  };
  return { deps, blockReviewOutcome, updateReviewAssurance };
}

/** Build a minimal session state snapshot with strictEnforcement enabled. */
function buildSessionState() {
  return makeState('PLAN', {
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement: true,
      },
    },
    plan: {
      version: 1,
      current: {
        body: 'plan body for review',
        digest: 'plan-digest-1',
        version: 1,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      history: [],
    },
    ticket: {
      text: 'ticket text',
      digest: 'ticket-digest-1',
      createdAt: '2026-04-24T12:00:00.000Z',
      source: 'user' as const,
      inputOrigin: 'manual_text' as const,
    },
  } as Parameters<typeof makeState>[1]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runReviewOrchestration — P1.3 slice 4c BLOCKED routing on unable_to_review', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
    vi.mocked(readState).mockResolvedValue(buildSessionState());
  });

  it('routes overallVerdict=unable_to_review to blockReviewOutcome with code SUBAGENT_UNABLE_TO_REVIEW (HAPPY: third-verdict pin)', async () => {
    const client = buildMockClient(findingsWithVerdict('unable_to_review'));
    const { deps, blockReviewOutcome } = buildDeps(client);

    const output = { output: modeAPlanOutput() };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { planText: 'plan body for review' },
      output,
      sessionId: PARENT_SESSION_ID,
      now: '2026-04-24T12:00:01.000Z',
    };

    await runReviewOrchestration(deps, event);

    // Pin: blockReviewOutcome was called exactly once with the new code.
    expect(blockReviewOutcome).toHaveBeenCalled();
    const matchingCalls = blockReviewOutcome.mock.calls.filter(
      (c) => c[2] === 'SUBAGENT_UNABLE_TO_REVIEW',
    );
    expect(matchingCalls.length).toBe(1);
    // Detail carries the obligationId so the SSOT reason renderer can
    // attribute the block correctly.
    expect(matchingCalls[0]![3]).toMatchObject({ obligationId: OBLIGATION_ID });
    // Output was rewritten by blockReviewOutcome — not by the mutated
    // success path. parseToolResult(output.output).error must be true.
    const parsed = JSON.parse(output.output) as { error?: boolean; code?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
  });

  it('does NOT call blockReviewOutcome with SUBAGENT_UNABLE_TO_REVIEW when verdict=approve (HAPPY: regression guard for branch capture)', async () => {
    const client = buildMockClient(findingsWithVerdict('approve'));
    const { deps, blockReviewOutcome } = buildDeps(client);

    const output = { output: modeAPlanOutput() };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: { planText: 'plan body for review' },
      output,
      sessionId: PARENT_SESSION_ID,
      now: '2026-04-24T12:00:01.000Z',
    };

    await runReviewOrchestration(deps, event);

    // The unable_to_review code must NOT fire on a normal approve
    // verdict. (Other blockReviewOutcome calls are out of scope for
    // this regression — we only pin that the new branch is verdict-
    // gated.)
    const matchingCalls = blockReviewOutcome.mock.calls.filter(
      (c) => c[2] === 'SUBAGENT_UNABLE_TO_REVIEW',
    );
    expect(matchingCalls.length).toBe(0);
  });
});
