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
import { makeState, POLICY_SNAPSHOT, PLAN_RECORD, TICKET } from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW,
} from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import { buildFrozenReviewMaterialContent } from './review/reviewer-context.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewObligation, ReviewObligationType } from '../state/evidence.js';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../shared/review-subject.js';

const PARENT_SESSION_ID = 'parent-session-ctx-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-reviewer-context-test';
const NOW = '2026-05-10T13:00:00.000Z';
const REVIEW_MATERIAL = 'persisted review material';
const REVIEW_MATERIAL_DIGEST = hashCanonicalReviewContent(REVIEW_MATERIAL);
const REVIEW_SUBJECT_DIGEST = hashCanonicalContentSubject(REVIEW_MATERIAL_DIGEST);
const HOST_ARTIFACT = 'frozen host-task artifact';

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
    subjectDigest: obligationType === 'review' ? REVIEW_SUBJECT_DIGEST : 'test-subject-digest',
    iteration: 1,
    planVersion: 1,
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
    reviewSubjectScope:
      obligationType === 'review'
        ? { kind: 'content', subjectDigest: REVIEW_SUBJECT_DIGEST, lineCount: 1 }
        : obligationType === 'architecture'
          ? {
              kind: 'artifact',
              artifact: {
                kind: 'adr',
                digest: 'test-subject-digest',
                sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
              },
            }
          : {
              kind: 'artifact',
              artifact: {
                kind: 'plan',
                digest: 'test-subject-digest',
                sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
              },
            },
    reviewMaterial: {
      content: REVIEW_MATERIAL,
      materialDigest: REVIEW_MATERIAL_DIGEST,
      subjectDigest: obligationType === 'review' ? REVIEW_SUBJECT_DIGEST : 'test-subject-digest',
    },
    ...(obligationType === 'review'
      ? {
          reviewSubject: {
            kind: 'content' as const,
            source: { kind: 'inline' as const, mediaType: 'text' as const },
            materialDigest: REVIEW_MATERIAL_DIGEST,
            subjectDigest: REVIEW_SUBJECT_DIGEST,
            lineCount: 1,
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function buildState(
  obligationType: ReviewObligationType,
  overrides: Partial<SessionState> = {},
  metadata?: Record<string, unknown>,
): SessionState {
  const baseState = makeState('PLAN', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    implementation: {
      changedFiles: ['src/foo.ts'],
      domainFiles: ['src/foo.ts'],
      digest: 'implementation-subject-digest',
      executedAt: NOW,
    },
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
      reviewInvocationPolicy: 'host_task_required',
      reviewOutputPolicy: 'structured_required',
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [],
      invocations: [],
      attempts: [],
    },
    ...overrides,
  });
  const material =
    obligationType === 'review'
      ? REVIEW_MATERIAL
      : buildFrozenReviewMaterialContent({
          obligationType,
          state: baseState,
          artifact: HOST_ARTIFACT,
        });
  const materialDigest = hashCanonicalReviewContent(material);
  const item = obligation(obligationType, metadata);
  const obligationWithMaterial = {
    ...item,
    reviewMaterial: {
      content: material,
      materialDigest,
      subjectDigest: item.subjectDigest,
    },
  };
  return {
    ...baseState,
    reviewAssurance: {
      ...baseState.reviewAssurance!,
      obligations: [obligationWithMaterial],
      attempts: [
        {
          attemptId: '22222222-2222-4222-8222-222222222222',
          obligationId: OBLIGATION_ID,
          obligationType,
          subjectDigest: item.subjectDigest,
          reviewMaterial: obligationWithMaterial.reviewMaterial,
          ordinal: 1,
          status: 'created' as const,
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          createdAt: NOW,
        },
      ],
    },
  };
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

  it.each(['plan', 'implement', 'architecture'] as const)(
    '%s review embeds all frozen comparison material without parent-appended context',
    async (obligationType) => {
      const prompt = await deliveredReviewerPrompt(buildState(obligationType));

      expect(prompt).toContain(HOST_ARTIFACT);
      expect(prompt).toContain('## Ticket Under Review (originating request)');
      expect(prompt).toContain(TICKET.text);
      if (obligationType === 'plan') expect(prompt).toContain('## Plan Artifact');
      if (obligationType === 'architecture') {
        expect(prompt).toContain('## Architecture Decision Artifact');
      }
      if (obligationType === 'implement') {
        expect(prompt).toContain('## Approved Plan (identity and content)');
        expect(prompt).toContain('## Changed Files');
        expect(prompt).toContain('## Verification Evidence (host-executed)');
        expect(prompt).toContain('## Implementation Subject Metadata');
      }
      expect(prompt.match(/## Ticket Under Review \(originating request\)/g)).toHaveLength(1);
      expect(prompt).not.toContain('content to review below this line:');
    },
  );

  it('renders an explicit marker instead of a JSON null when no ticket was recorded', async () => {
    const prompt = await deliveredReviewerPrompt(
      buildState('architecture', { ticket: null }),
      TOOL_FLOWGUARD_ARCHITECTURE,
    );
    expect(prompt).toContain('## Ticket Under Review (originating request)');
    expect(prompt).toContain('No ticket recorded for this session.');
    expect(prompt).not.toContain('null');
  });

  it('standalone review embeds its obligation material', async () => {
    const prompt = await deliveredReviewerPrompt(buildState('review'), TOOL_FLOWGUARD_REVIEW);
    expect(prompt).toContain(REVIEW_MATERIAL);
  });
});

/**
 * Contract: the host must not report a spent retry slot as corrupted material.
 *
 * The two states have opposite recoveries — an integrity failure forbids
 * re-running the reviewer, a spent attempt is resolved BY re-running the review
 * call — so conflating them strands the flow with unfollowable guidance.
 */
describe('reviewer context unavailability is classified by cause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function deliveredOutput(state: SessionState): Promise<Record<string, unknown>> {
    const stateRef = { current: state };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const output = { output: contentAnalysisRequiredOutput() };
    const event: ToolCallEvent = {
      toolName: TOOL_FLOWGUARD_REVIEW,
      input: { args: {} },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    } as unknown as ToolCallEvent;

    await runReviewOrchestration(buildDeps(stateRef, TOOL_FLOWGUARD_REVIEW), event);
    return JSON.parse(output.output) as Record<string, unknown>;
  }

  function withAttempts(
    state: SessionState,
    map: (attempt: NonNullable<SessionState['reviewAssurance']>['attempts'][number]) => unknown,
  ): SessionState {
    return {
      ...state,
      reviewAssurance: {
        ...state.reviewAssurance!,
        attempts: state.reviewAssurance!.attempts.map(map) as NonNullable<
          SessionState['reviewAssurance']
        >['attempts'],
      },
    };
  }

  it('reports a rejected attempt as REVIEW_ATTEMPT_UNAVAILABLE with a re-runnable recovery', async () => {
    const state = withAttempts(buildState('review'), (attempt) => ({
      ...attempt,
      status: 'rejected' as const,
      childSessionId: 'reviewer-child-1',
      completedAt: NOW,
    }));

    const parsed = await deliveredOutput(state);

    expect(parsed.code).toBe('REVIEW_ATTEMPT_UNAVAILABLE');
    expect(String(parsed.message)).toContain('was not invalidated');
    expect((parsed.recovery as string[]).join(' ')).toContain('reissue a bindable attempt');
    // The unfollowable instruction must be gone.
    expect((parsed.recovery as string[]).join(' ')).not.toContain(
      'Create a new standalone review obligation',
    );
  });

  it('ignores a tampered spent-attempt copy because obligation material is authoritative', async () => {
    const state = withAttempts(buildState('review'), (attempt) => ({
      ...attempt,
      status: 'rejected' as const,
      childSessionId: 'reviewer-child-1',
      completedAt: NOW,
      reviewMaterial: {
        content: 'tampered',
        materialDigest: REVIEW_MATERIAL_DIGEST,
        subjectDigest: REVIEW_SUBJECT_DIGEST,
      },
    }));

    const parsed = await deliveredOutput(state);

    expect(parsed.code).toBe('REVIEW_ATTEMPT_UNAVAILABLE');
  });

  it('delivers a reviewer prompt again once a bindable attempt was reissued', async () => {
    // The persisted state after the repair call: the spent attempt is staled and
    // a fresh bindable attempt carries the same frozen material forward.
    const base = buildState('review');
    const spent = base.reviewAssurance!.attempts[0]!;
    const state: SessionState = {
      ...base,
      reviewAssurance: {
        ...base.reviewAssurance!,
        attempts: [
          { ...spent, status: 'stale' as const, childSessionId: 'reviewer-child-1' },
          {
            ...spent,
            attemptId: '33333333-3333-4333-8333-333333333333',
            ordinal: 2,
            status: 'created' as const,
          },
        ],
      },
    };

    const parsed = await deliveredOutput(state);

    expect(parsed.code).not.toBe('REVIEW_ATTEMPT_UNAVAILABLE');
    expect(parsed.code).not.toBe('REVIEW_MATERIAL_INTEGRITY_FAILED');
    expect(typeof parsed.reviewerTaskPrompt).toBe('string');
    expect(String(parsed.reviewerTaskPrompt)).toContain(REVIEW_MATERIAL);
    expect(parsed.reviewAttemptId).toBe('33333333-3333-4333-8333-333333333333');
  });
});
