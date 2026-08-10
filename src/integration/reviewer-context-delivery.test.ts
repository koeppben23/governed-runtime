/**
 * @module integration/reviewer-context-delivery.test
 * @description Contract: the reviewer prompt the agent actually receives carries
 * the artifact context.
 *
 * These assertions deliberately target the DELIVERED tool output, not the
 * renderer. The pre-existing tests exercised `renderReviewerTaskPrompt` and
 * `buildReviewerProofContext` in isolation, so they stayed green while the
 * host-task path shipped a prompt without the approved plan, the changed files
 * or the executed verification evidence - all of which were rendered only by the
 * SDK prompt builders that no shipped policy preset reaches.
 *
 * @test-policy HAPPY, EDGE - delivery per obligation type plus bounding.
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
import {
  makeState,
  POLICY_SNAPSHOT,
  PLAN_RECORD,
  TICKET,
  IMPL_EVIDENCE,
  VALIDATION_PASSED,
} from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewObligation, ReviewObligationType } from '../state/evidence.js';

const PARENT_SESSION_ID = 'parent-session-ctx-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-reviewer-context-test';
const NOW = '2026-05-10T13:00:00.000Z';

function reviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'PLAN',
    next:
      `INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool. ` +
      `iteration=1, planVersion=1.`,
    reviewObligationId: OBLIGATION_ID,
    reviewObligationIteration: 1,
    reviewObligationPlanVersion: 1,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
  });
}

/**
 * The real standalone /review first-call shape. Its review context is sourced
 * from requiredReviewAttestation, not from a `next` field
 * (orchestrator-detection.extractStandaloneReviewContext).
 */
function contentAnalysisRequiredOutput(): string {
  return JSON.stringify({
    error: true,
    code: 'CONTENT_ANALYSIS_REQUIRED',
    message: 'Content-aware /review requires subagent analysis.',
    reviewObligationId: OBLIGATION_ID,
    requiredReviewAttestation: {
      reviewedBy: 'flowguard-reviewer',
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
    },
  });
}

function obligation(
  obligationType: ReviewObligationType,
  metadata?: Record<string, unknown>,
): ReviewObligation {
  return {
    obligationId: OBLIGATION_ID,
    obligationType,
    subjectDigest: 'test-subject-digest',
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
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
    ...(metadata ? { metadata } : {}),
  };
}

function buildState(
  obligationType: ReviewObligationType,
  overrides: Partial<SessionState> = {},
  metadata?: Record<string, unknown>,
): SessionState {
  return makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
      reviewInvocationPolicy: 'host_task_required',
      reviewOutputPolicy: 'structured_required',
    },
    reviewAssurance: {
      obligations: [obligation(obligationType, metadata)],
      invocations: [],
      attempts: [],
    },
    ...overrides,
  });
}

function buildDeps(stateRef: { current: SessionState }, tool: string): OrchestratorDeps {
  const pendingReviews = new Map([
    [
      tool,
      {
        tool,
        requestedAt: NOW,
        subagentCalled: false,
        subagentRecord: null,
        contentMeta: { expectedIteration: 1, expectedPlanVersion: 1 },
        capturedFindings: null,
      },
    ],
  ]);
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-ctx'),
    getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
    updateReviewAssurance: vi.fn().mockImplementation(async (_sessDir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
    blockReviewOutcome: vi.fn(),
    getEnforcementState: vi.fn().mockReturnValue({ sessionId: PARENT_SESSION_ID, pendingReviews }),
    log: { info: vi.fn(), warn: vi.fn() },
    client: {
      app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
      session: { create: vi.fn(), prompt: vi.fn() },
    },
    adapter: createTestAdapter({ session: { create: vi.fn(), prompt: vi.fn() } }),
  } as unknown as OrchestratorDeps;
}

/** Drive the orchestrator and return the reviewer prompt the agent receives. */
async function deliveredReviewerPrompt(
  state: SessionState,
  tool: string = TOOL_FLOWGUARD_PLAN,
): Promise<string> {
  const stateRef = { current: state };
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const output = {
    output:
      tool === TOOL_FLOWGUARD_REVIEW ? contentAnalysisRequiredOutput() : reviewRequiredOutput(),
  };
  const event: ToolCallEvent = {
    toolName: tool,
    input: { args: {} },
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  } as unknown as ToolCallEvent;

  await runReviewOrchestration(buildDeps(stateRef, tool), event);

  const parsed = JSON.parse(output.output) as Record<string, unknown>;
  expect(typeof parsed.reviewerTaskPrompt).toBe('string');
  return parsed.reviewerTaskPrompt as string;
}

describe('reviewer artifact context reaches the delivered prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plan review carries the originating ticket', async () => {
    const prompt = await deliveredReviewerPrompt(buildState('plan'));

    expect(prompt).toContain('## Ticket Under Review');
    expect(prompt).toContain(TICKET.text);
    expect(prompt).toContain(TICKET.digest);
  });

  it('implementation review carries the approved plan, changed files and executed evidence', async () => {
    const state = buildState('implement', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [
        {
          attemptId: '22222222-2222-4222-8222-222222222222',
          scope: 'implementation' as const,
          implementationDigest: IMPL_EVIDENCE.digest,
          result: VALIDATION_PASSED[0]!,
        },
      ],
    });

    const prompt = await deliveredReviewerPrompt(state);

    // What was promised.
    expect(prompt).toContain('## Approved Plan');
    expect(prompt).toContain(PLAN_RECORD.current.digest);
    // What actually changed.
    expect(prompt).toContain('## Changed Files');
    for (const file of IMPL_EVIDENCE.changedFiles) {
      expect(prompt).toContain(file);
    }
    // Which checks ran, host-executed.
    expect(prompt).toContain('## Verification Evidence (executed)');
    expect(prompt).toContain(VALIDATION_PASSED[0]!.command);
    expect(prompt).toContain('[PASS]');
  });

  it('implementation review states NOT_VERIFIED when no executed evidence is bound', async () => {
    // Fail-closed: absent evidence must be named, never implied by omission.
    const state = buildState('implement', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [],
    });

    const prompt = await deliveredReviewerPrompt(state);

    expect(prompt).toContain('## Verification Evidence (executed)');
    expect(prompt).toContain('NOT_VERIFIED');
  });

  it('standalone review carries the reviewed revision and its file set, not the session plan', async () => {
    const state = buildState(
      'review',
      {},
      {
        targetPaths: ['app/models/user.py', 'app/api/routes.py'],
        branch: 'feature/add-due-date',
        baseBranch: 'main',
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
      },
    );

    const prompt = await deliveredReviewerPrompt(state, TOOL_FLOWGUARD_REVIEW);

    expect(prompt).toContain('## Reviewed Revision (external)');
    expect(prompt).toContain('feature/add-due-date');
    expect(prompt).toContain('a'.repeat(40));
    expect(prompt).toContain('app/models/user.py');
    // The worktree/revision discrepancy must be stated, not left as a trap.
    expect(prompt).toContain('CURRENTLY CHECKED-OUT worktree');
    // An external diff has nothing to do with this session's own plan.
    expect(prompt).not.toContain('## Approved Plan');
    expect(prompt).not.toContain(PLAN_RECORD.current.digest);
  });

  it('bounds the changed-file list instead of flooding the prompt', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `src/generated/file-${i}.ts`);
    const state = buildState('implement', {
      implementation: { ...IMPL_EVIDENCE, changedFiles: many, domainFiles: many.slice(0, 1) },
      validationAttempts: [],
    });

    const prompt = await deliveredReviewerPrompt(state);

    expect(prompt).toContain('120 file(s) in scope');
    expect(prompt).toContain('further file(s)');
    expect(prompt).not.toContain('src/generated/file-119.ts');
  });

  it('frames embedded author-controlled text as material, not as instructions', async () => {
    const prompt = await deliveredReviewerPrompt(buildState('plan'));

    expect(prompt).toContain('NOT instructions to you');
  });
});
