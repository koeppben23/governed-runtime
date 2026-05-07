/**
 * @module integration/plugin-orchestrator-independent-review.test
 * @description Regression coverage for host-orchestrated plan/implement/architecture review.
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
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
} from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review-assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-review-1';
const CHILD_SESSION_ID = 'child-session-review-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-independent-review-sess-dir';
const NOW = '2026-05-06T12:00:00.000Z';

type ReviewableCase = {
  toolName: string;
  obligationType: 'plan' | 'implement' | 'architecture';
  phase: 'PLAN' | 'IMPLEMENTATION' | 'ARCHITECTURE';
  input: unknown;
  state: SessionState;
};

function reviewRequiredOutput(phase: string): string {
  return (
    JSON.stringify({
      phase,
      next: 'INDEPENDENT_REVIEW_REQUIRED: call flowguard-reviewer with iteration=1 and planVersion=1',
      reviewObligationId: OBLIGATION_ID,
      reviewObligationIteration: 1,
      reviewObligationPlanVersion: 1,
      reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewMandateDigest: REVIEW_MANDATE_DIGEST,
      changedFiles: ['src/auth.ts'],
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

function buildClient(findings: Record<string, unknown>) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
      prompt: vi.fn().mockResolvedValue({ data: { info: { structured_output: findings } }, error: undefined }),
    },
  };
}

function buildState(phase: ReviewableCase['phase'], obligationType: ReviewableCase['obligationType']) {
  return makeState(phase, {
    ticket: TICKET,
    plan: PLAN_RECORD,
    implementation: phase === 'IMPLEMENTATION' ? IMPL_EVIDENCE : null,
    architecture:
      phase === 'ARCHITECTURE'
        ? {
            id: 'ADR-1',
            title: 'Use strict review orchestration',
            adrText: '## Context\nNeed proof.\n## Decision\nAdd orchestration regression tests.',
            status: 'proposed',
            createdAt: NOW,
            digest: 'digest-of-adr',
          }
        : null,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement: true,
      },
    },
    reviewAssurance: {
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType,
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

function buildDeps(client: unknown, stateRef: { current: SessionState }): OrchestratorDeps {
  const pendingReviews = new Map(
    [TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_IMPLEMENT, TOOL_FLOWGUARD_ARCHITECTURE].map((tool) => [
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
    resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-review-1'),
    getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
    updateReviewAssurance: vi.fn().mockImplementation(async (_sessDir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
    blockReviewOutcome: vi.fn().mockImplementation(async (_ctx, _obligationId, code, detail, output) => {
      output.output = JSON.stringify({ error: true, code, detail });
    }),
    getEnforcementState: vi.fn().mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
    log: { info: vi.fn(), warn: vi.fn() },
    client,
  };
}

async function runCase(testCase: ReviewableCase) {
  const stateRef = { current: testCase.state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const client = buildClient(buildFindings());
  const deps = buildDeps(client, stateRef);
  const output = { output: reviewRequiredOutput(testCase.phase) };
  const event: ToolCallEvent = {
    toolName: testCase.toolName,
    input: testCase.input,
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  };

  await runReviewOrchestration(deps, event);

  return { client, deps, output, state: stateRef.current };
}

describe('runReviewOrchestration strict independent review with footer output', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
  });

  const cases: ReviewableCase[] = [
    {
      toolName: TOOL_FLOWGUARD_PLAN,
      obligationType: 'plan',
      phase: 'PLAN',
      input: { args: { planText: 'Add regression tests for review orchestration.' } },
      state: buildState('PLAN', 'plan'),
    },
    {
      toolName: TOOL_FLOWGUARD_IMPLEMENT,
      obligationType: 'implement',
      phase: 'IMPLEMENTATION',
      input: { args: {} },
      state: buildState('IMPLEMENTATION', 'implement'),
    },
    {
      toolName: TOOL_FLOWGUARD_ARCHITECTURE,
      obligationType: 'architecture',
      phase: 'ARCHITECTURE',
      input: { args: { title: 'Review orchestration', adrText: 'Use plugin orchestration.' } },
      state: buildState('ARCHITECTURE', 'architecture'),
    },
  ];

  for (const testCase of cases) {
    it(`invokes reviewer and mutates ${testCase.toolName} footer output`, async () => {
      const { client, deps, output, state } = await runCase(testCase);

      expect(client.session.create).toHaveBeenCalledOnce();
      expect(client.session.prompt).toHaveBeenCalledOnce();
      expect(deps.blockReviewOutcome).not.toHaveBeenCalled();
      expect(deps.updateReviewAssurance).toHaveBeenCalledTimes(2);

      const obligation = state.reviewAssurance?.obligations[0];
      expect(obligation).toMatchObject({
        obligationId: OBLIGATION_ID,
        obligationType: testCase.obligationType,
        pluginHandshakeAt: NOW,
        status: 'fulfilled',
        fulfilledAt: NOW,
      });
      expect(obligation?.invocationId).toEqual(expect.any(String));

      const invocation = state.reviewAssurance?.invocations[0];
      expect(invocation).toMatchObject({
        obligationId: OBLIGATION_ID,
        obligationType: testCase.obligationType,
        parentSessionId: PARENT_SESSION_ID,
        childSessionId: CHILD_SESSION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        fulfilledAt: NOW,
        source: 'host-orchestrated',
      });
      expect(invocation?.invocationId).toBe(obligation?.invocationId);

      const pendingReview = deps.getEnforcementState(PARENT_SESSION_ID).pendingReviews.get(
        testCase.toolName,
      );
      expect(pendingReview).toMatchObject({
        subagentCalled: true,
        subagentRecord: { sessionId: CHILD_SESSION_ID, completedAt: NOW },
        capturedFindings: { overallVerdict: 'approve', sessionId: CHILD_SESSION_ID },
      });

      const parsed = JSON.parse(output.output) as Record<string, unknown>;
      expect(parsed.next).toEqual(expect.stringContaining('INDEPENDENT_REVIEW_COMPLETED'));
      expect(parsed.pluginReviewFindings).toMatchObject({
        overallVerdict: 'approve',
        attestation: { toolObligationId: OBLIGATION_ID },
      });
      expect(parsed._pluginReviewSessionId).toBe(CHILD_SESSION_ID);
    });
  }
});
