/**
 * @module integration/plugin-orchestrator-arch-ssot.test
 * @description Tests for BUG-12 fix: architecture adrText/adrTitle SSOT enforcement.
 *
 * Validates:
 * - Architecture review prompt always uses sessionState.architecture.adrText/title (SSOT)
 * - toolArgs.adrText / toolArgs.title from LLM are ignored (same class as BUG-09)
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
import { makeState, POLICY_SNAPSHOT, TICKET, ARCHITECTURE_DECISION } from '../__fixtures__.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_ARCHITECTURE } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-arch-ssot-1';
const CHILD_SESSION_ID = 'child-session-arch-ssot-1';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';
const SESS_DIR = '/tmp/fg-arch-ssot-test';
const NOW = '2026-05-10T14:00:00.000Z';

const STATE_ADR_TEXT = ARCHITECTURE_DECISION.adrText;
const STATE_ADR_TITLE = ARCHITECTURE_DECISION.title;

function reviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'ARCHITECTURE',
    next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer with iteration=1 and planVersion=1',
    reviewObligationId: OBLIGATION_ID,
    reviewObligationIteration: 1,
    reviewObligationPlanVersion: 1,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
  });
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
  return makeState('ARCHITECTURE', {
    ticket: TICKET,
    architecture: ARCHITECTURE_DECISION,
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
          obligationType: 'architecture',
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
    [TOOL_FLOWGUARD_ARCHITECTURE].map((tool) => [
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
      resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-arch-ssot-1'),
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
      adapter: createTestAdapter(client),
    },
    logInfo,
  };
}

async function runArchReview(
  toolArgsAdrText: string | undefined,
  toolArgsTitle: string | undefined,
  stateOverrides: Partial<SessionState> = {},
) {
  const state = buildState(stateOverrides);
  const stateRef = { current: state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const { client, capturedPrompts } = buildCapturingClient(buildFindings());
  const { deps, logInfo } = buildDeps(client, stateRef);
  const output = { output: reviewRequiredOutput() };

  const input: Record<string, unknown> = { args: {} };
  if (toolArgsAdrText !== undefined) {
    (input.args as Record<string, unknown>).adrText = toolArgsAdrText;
  }
  if (toolArgsTitle !== undefined) {
    (input.args as Record<string, unknown>).title = toolArgsTitle;
  }

  const event: ToolCallEvent = {
    toolName: TOOL_FLOWGUARD_ARCHITECTURE,
    input,
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  };

  await runReviewOrchestration(deps, event);

  return { output, capturedPrompts, logInfo, state: stateRef.current, deps };
}

// =============================================================================
// BUG-12: Architecture adrText / adrTitle SSOT Enforcement
// =============================================================================

describe('BUG-12: architecture adrText/adrTitle SSOT enforcement', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
  });

  // --- HAPPY -----------------------------------------------------------------

  describe('HAPPY: state-sourced adrText and adrTitle', () => {
    it('architecture review prompt uses sessionState.architecture.adrText', async () => {
      const { capturedPrompts } = await runArchReview(undefined, undefined);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TEXT);
    });

    it('architecture review prompt uses sessionState.architecture.title', async () => {
      const { capturedPrompts } = await runArchReview(undefined, undefined);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TITLE);
    });
  });

  // --- BAD -------------------------------------------------------------------

  describe('BAD: agent-supplied toolArgs ignored', () => {
    it('toolArgs.adrText is ignored when different from state', async () => {
      const fabricatedAdr = 'FABRICATED ADR TEXT FROM LLM — SHOULD NOT APPEAR IN PROMPT';
      const { capturedPrompts } = await runArchReview(fabricatedAdr, undefined);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TEXT);
      expect(prompt).not.toContain(fabricatedAdr);
    });

    it('toolArgs.title is ignored when different from state', async () => {
      const fabricatedTitle = 'FABRICATED TITLE — SHOULD NOT APPEAR';
      const { capturedPrompts } = await runArchReview(undefined, fabricatedTitle);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TITLE);
      expect(prompt).not.toContain(fabricatedTitle);
    });
  });

  // --- CORNER ----------------------------------------------------------------

  describe('CORNER: null/missing architecture in state', () => {
    it('adrText is empty string when sessionState.architecture is null', async () => {
      const { capturedPrompts } = await runArchReview('LLM-supplied fallback', 'LLM title', {
        architecture: null as never,
      });

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).not.toContain('LLM-supplied fallback');
      expect(prompt).not.toContain('LLM title');
    });

    it('toolArgs.adrText matches state exactly — no regression', async () => {
      const { capturedPrompts } = await runArchReview(STATE_ADR_TEXT, STATE_ADR_TITLE);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TEXT);
      expect(prompt).toContain(STATE_ADR_TITLE);
    });
  });

  // --- EDGE ------------------------------------------------------------------

  describe('EDGE: non-string toolArgs', () => {
    it('toolArgs.adrText is a number — state adrText used', async () => {
      const { capturedPrompts } = await runArchReview(42 as unknown as string, undefined);

      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain(STATE_ADR_TEXT);
    });
  });

  // --- SMOKE -----------------------------------------------------------------

  describe('SMOKE: mismatch observability logging', () => {
    it('log contains adrTextMismatch=true when toolArgs.adrText differs from state', async () => {
      const { logInfo } = await runArchReview('DIFFERENT ADR TEXT', undefined);

      const invokingCalls = logInfo.mock.calls.filter(
        (call: unknown[]) => call[0] === 'orchestrator' && call[1] === 'invoking reviewer subagent',
      );
      expect(invokingCalls.length).toBe(1);
      const extra = invokingCalls[0]![2] as Record<string, unknown>;
      expect(extra.adrTextMismatch).toBe(true);
      expect(extra.toolArgsAdrTextLength).toBe('DIFFERENT ADR TEXT'.length);
    });

    it('log contains adrTextMismatch=false when toolArgs.adrText matches state', async () => {
      const { logInfo } = await runArchReview(STATE_ADR_TEXT, undefined);

      const invokingCalls = logInfo.mock.calls.filter(
        (call: unknown[]) => call[0] === 'orchestrator' && call[1] === 'invoking reviewer subagent',
      );
      expect(invokingCalls.length).toBe(1);
      const extra = invokingCalls[0]![2] as Record<string, unknown>;
      expect(extra.adrTextMismatch).toBe(false);
    });
  });
});
