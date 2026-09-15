/**
 * @module integration/plugin-orchestrator-review-content.test
 * @description Regression coverage for strict /review content analysis.
 *
 * Contract under test:
 * - In strict enforcement, host-orchestrated /review MUST fail closed when
 *   subagent findings are missing, lack attestation, or carry mismatched
 *   attestation.
 * - A valid attestation records bound structured evidence and directs a
 *   verdict-only follow-up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapters/persistence.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../rails/review.js', () => ({
  loadExternalContent: vi.fn(),
}));

import { readState } from '../adapters/persistence.js';
import { loadExternalContent } from '../rails/review.js';
import { makeState, POLICY_SNAPSHOT } from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { SessionState } from '../state/schema.js';
import type { OrchestratorClient } from './review/types.js';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../shared/review-subject.js';

const PARENT_SESSION_ID = 'parent-session-review-1';
const CHILD_SESSION_ID = 'child-session-review-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-review-content-sess-dir';
const NOW = '2026-05-06T12:00:00.000Z';
const PERSISTED_CONTENT = 'persisted diff content';
const MATERIAL_DIGEST = hashCanonicalReviewContent(PERSISTED_CONTENT);
const SUBJECT_DIGEST = hashCanonicalContentSubject(MATERIAL_DIGEST);
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

function contentAnalysisRequiredOutput(): string {
  return JSON.stringify({
    error: true,
    code: 'CONTENT_ANALYSIS_REQUIRED',
    phase: 'REVIEW',
    requiredReviewAttestation: {
      toolObligationId: OBLIGATION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewedBy: 'flowguard-reviewer',
    },
  });
}

function buildFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: {
      toolObligationId: OBLIGATION_ID,
    },
    ...overrides,
  };
}

function buildClient(findings: Record<string, unknown> | null): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
      prompt: vi.fn().mockResolvedValue(
        findings
          ? {
              data: { info: { structured: findings } },
              error: undefined,
            }
          : { data: { info: {} }, error: undefined },
      ),
    },
  };
}

function buildTextCompatClient(findings: Record<string, unknown>): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
      prompt: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            parts: [],
            info: { error: { name: 'APIError', message: 'does not support this tool_choice' } },
          },
          error: undefined,
        })
        .mockResolvedValueOnce({
          data: { parts: [{ type: 'text', text: JSON.stringify(findings) }], info: {} },
          error: undefined,
        }),
    },
  };
}

function buildSessionState(
  strictEnforcement = true,
  seedInvocations: NonNullable<SessionState['reviewAssurance']>['invocations'] = [],
) {
  return makeState('REVIEW', {
    ticket: {
      text: 'Review the authentication changes',
      digest: 'ticket-digest-review',
      source: 'user',
      createdAt: NOW,
    },
    policySnapshot: POLICY_SNAPSHOT,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'review',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'content_challenge',
          challengePolicyVersion: 'challenge-policy.v1',
          subjectDigest: SUBJECT_DIGEST,
          iteration: 1,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core',
          profileSource: 'policy_default',
          createdAt: NOW,
          pluginHandshakeAt: null,
          status: 'pending',
          invocationId: null,
          blockedCode: null,
          fulfilledAt: null,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'content',
            subjectDigest: SUBJECT_DIGEST,
            lineCount: 1,
          },
          reviewSubject: {
            kind: 'content',
            source: { kind: 'inline', mediaType: 'diff' },
            materialDigest: MATERIAL_DIGEST,
            subjectDigest: SUBJECT_DIGEST,
            lineCount: 1,
          },
          reviewMaterial: {
            content: PERSISTED_CONTENT,
            materialDigest: MATERIAL_DIGEST,
            subjectDigest: SUBJECT_DIGEST,
          },
        },
      ],
      invocations: seedInvocations,
      attempts: [
        {
          attemptId: ATTEMPT_ID,
          obligationId: OBLIGATION_ID,
          obligationType: 'review',
          subjectDigest: SUBJECT_DIGEST,
          ordinal: 1,
          status: 'created',
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          observations: [],
          createdAt: NOW,
        },
      ],
      dispatches: [],
    },
  });
}

function buildDeps(
  client: OrchestratorClient,
  stateRef: { current: SessionState },
): {
  deps: OrchestratorDeps;
  blockReviewOutcome: ReturnType<typeof vi.fn>;
  updateReviewAssurance: ReturnType<typeof vi.fn>;
} {
  const blockReviewOutcome = vi
    .fn()
    .mockImplementation(
      async (
        _ctx: unknown,
        _obligationId: string,
        code: string,
        detail: Record<string, string>,
        output: { output: string },
      ) => {
        output.output = JSON.stringify({ error: true, code, detail });
      },
    );
  const updateReviewAssurance = vi.fn().mockImplementation(async (_sessDir, update) => {
    stateRef.current = update(stateRef.current, NOW);
  });
  return {
    deps: {
      resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-review-1'),
      getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
      updateReviewAssurance,
      blockReviewOutcome,
      getEnforcementState: vi.fn().mockReturnValue({
        pendingReviews: new Map(),
        executedTaskPrompts: new Map(),
      }),
      log: { info: vi.fn(), warn: vi.fn() },
      client,
      adapter: createTestAdapter(client),
    },
    blockReviewOutcome,
    updateReviewAssurance,
  };
}

async function runReviewContent(
  findings: Record<string, unknown> | null,
  input: unknown = { args: { text: 'diff content', inputOrigin: 'manual_text' } },
  strictEnforcement = true,
  clientOverride?: OrchestratorClient,
  seedInvocations: NonNullable<SessionState['reviewAssurance']>['invocations'] = [],
  configureState?: (state: SessionState) => void,
) {
  const client = clientOverride ?? buildClient(findings);
  const stateRef = {
    current: buildSessionState(strictEnforcement, seedInvocations),
  };
  configureState?.(stateRef.current);
  vi.mocked(readState).mockResolvedValue(stateRef.current);
  const { deps, blockReviewOutcome, updateReviewAssurance } = buildDeps(client, stateRef);
  const output = { output: contentAnalysisRequiredOutput() };
  const event: ToolCallEvent = {
    toolName: TOOL_FLOWGUARD_REVIEW,
    input,
    output,
    sessionId: PARENT_SESSION_ID,
    now: NOW,
  };

  await runReviewOrchestration(deps, event);

  return { output, blockReviewOutcome, updateReviewAssurance, state: stateRef.current, client };
}

describe('runReviewOrchestration strict /review content analysis', () => {
  beforeEach(() => {
    vi.mocked(readState).mockReset();
    vi.mocked(loadExternalContent).mockReset();
    vi.mocked(loadExternalContent).mockResolvedValue({
      content: 'diff content',
      reviewedContentDigest: 'sha256:mock',
      reviewSubject: {
        kind: 'content',
        source: { kind: 'inline', mediaType: 'diff' },
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'a'.repeat(64),
        lineCount: 1,
      },
    });
  });

  it('reports malformed reviewer attestation as a structured-output contract violation', async () => {
    const findings = buildFindings({
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: '22222222-2222-4222-8222-222222222222',
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    });

    const { output } = await runReviewContent(findings);
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    });
  });

  it('reports missing reviewer attestation as a structured-output contract violation', async () => {
    const { attestation: _omit, ...findings } = buildFindings();
    void _omit;

    const { output } = await runReviewContent(findings);
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    });
  });

  it('reports missing structured reviewer output directly', async () => {
    const { output } = await runReviewContent(null);
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    });
  });

  it('blocks with SUBAGENT_UNABLE_TO_REVIEW when strict /review reviewer declares content unreviewable', async () => {
    // Item 1: the content pipeline MUST fail closed on the third LoopVerdict,
    // symmetric with plan/implement/architecture. A reviewer that returns
    // overallVerdict='unable_to_review' must NOT let /review complete.
    const findings = buildFindings({
      overallVerdict: 'unable_to_review',
      blockingIssues: [],
      majorRisks: [],
    });

    const { output, blockReviewOutcome, state } = await runReviewContent(findings);

    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'SUBAGENT_UNABLE_TO_REVIEW',
      { obligationId: OBLIGATION_ID },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'SUBAGENT_UNABLE_TO_REVIEW',
    });
    // Obligation must NOT be fulfilled when the reviewer is unable to review.
    expect(state.reviewAssurance?.obligations[0]?.status).not.toBe('fulfilled');
  });

  it('records bound structured evidence and returns a verdict-only follow-up', async () => {
    const { output, blockReviewOutcome, updateReviewAssurance, state, client } =
      await runReviewContent(buildFindings());

    expect(client.session.create).toHaveBeenCalledOnce();
    expect(client.session.prompt).toHaveBeenCalledOnce();
    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(updateReviewAssurance).toHaveBeenCalledOnce();
    const obligation = state.reviewAssurance?.obligations[0];
    expect(obligation).toMatchObject({
      obligationId: OBLIGATION_ID,
      obligationType: 'review',
      pluginHandshakeAt: NOW,
      status: 'fulfilled',
      fulfilledAt: expect.any(String),
    });
    const invocation = state.reviewAssurance?.invocations[0];
    expect(invocation).toMatchObject({
      invocationId: obligation?.invocationId,
      obligationId: OBLIGATION_ID,
      obligationType: 'review',
      parentSessionId: PARENT_SESSION_ID,
      childSessionId: CHILD_SESSION_ID,
      agentType: 'flowguard-reviewer',
      invocationMode: 'sdk_session_prompt',
      hostVisible: false,
      promptHash: expect.any(String),
      findingsHash: expect.any(String),
      attemptId: ATTEMPT_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      invokedAt: expect.any(String),
      fulfilledAt: expect.any(String),
      consumedByObligationId: null,
      source: 'host-orchestrated',
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      capturedVerdict: 'accept',
    });
    expect(invocation?.invocationId).toBe(obligation?.invocationId);
    expect(Date.parse(invocation!.invokedAt)).toBeLessThanOrEqual(
      Date.parse(invocation!.fulfilledAt!),
    );
    expect(state.reviewAssurance?.attempts[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      status: 'bound',
      childSessionId: CHILD_SESSION_ID,
    });
    const evidenceIntents = vi.mocked(updateReviewAssurance).mock.calls[0]![2]!(state, NOW);
    expect(evidenceIntents).toEqual([
      expect.objectContaining({
        event: 'review:subagent_invoked',
        detail: expect.objectContaining({
          obligationId: OBLIGATION_ID,
          obligationType: 'review',
          parentSessionId: PARENT_SESSION_ID,
          childSessionId: CHILD_SESSION_ID,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
        }),
      }),
      expect.objectContaining({
        event: 'review:obligation_fulfilled',
        detail: { obligationId: OBLIGATION_ID, childSessionId: CHILD_SESSION_ID },
      }),
    ]);
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(String(parsed.next)).toContain('reviewVerdict=accept');
    expect(parsed).not.toHaveProperty('pluginReviewFindings');
    expect(parsed).not.toHaveProperty('_pluginReviewSessionId');
  });

  it('blocks stale content-review generation before any SDK invocation or evidence mutation', async () => {
    const { output, blockReviewOutcome, updateReviewAssurance, state, client } =
      await runReviewContent(
        buildFindings(),
        undefined,
        undefined,
        undefined,
        undefined,
        (current) => {
          current.reviewAssurance!.obligations[0]!.criteriaVersion = 'p41-v1';
        },
      );

    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(updateReviewAssurance).not.toHaveBeenCalled();
    expect(state.reviewAssurance?.invocations).toEqual([]);
    expect(state.reviewAssurance?.attempts[0]?.status).toBe('created');
    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'REVIEW_GENERATION_MISMATCH',
      expect.anything(),
      output,
    );
  });

  it('uses persisted material rather than direct /review input and returns a verdict-only follow-up', async () => {
    const { output, blockReviewOutcome, client } = await runReviewContent(buildFindings(), {
      text: 'diff content',
      inputOrigin: 'manual_text',
    });

    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(loadExternalContent).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({ text: expect.stringContaining('persisted diff content') }),
          ],
        }),
      }),
    );
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(String(parsed.next)).toContain('reviewVerdict=accept');
    expect(parsed).not.toHaveProperty('pluginReviewFindings');
  });

  it('fails closed without any persisted attempt for the obligation', async () => {
    const client = buildClient(buildFindings());
    const stateRef = { current: buildSessionState() };
    stateRef.current = {
      ...stateRef.current,
      reviewAssurance: { ...stateRef.current.reviewAssurance!, attempts: [] },
    };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const { deps, blockReviewOutcome } = buildDeps(client, stateRef);
    const output = { output: contentAnalysisRequiredOutput() };

    await runReviewOrchestration(deps, {
      toolName: TOOL_FLOWGUARD_REVIEW,
      input: { args: { text: 'untrusted replacement' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    });

    expect(client.session.create).not.toHaveBeenCalled();
    // No attempt means no bindable reviewer context: the frozen obligation
    // material alone cannot reconstruct reviewer input without an attempt.
    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'REVIEW_ATTEMPT_UNAVAILABLE',
      expect.objectContaining({
        reason: expect.stringContaining('bindable attempt'),
      }),
      output,
    );
  });

  it('reports a spent attempt as REVIEW_ATTEMPT_UNAVAILABLE, not an integrity failure', async () => {
    const client = buildClient(buildFindings());
    const stateRef = { current: buildSessionState() };
    // The state after a reviewer Task produced schema-invalid output: the
    // attempt is rejected and correlated to its child session, so it is no
    // longer bindable — but its frozen material is untouched.
    stateRef.current = {
      ...stateRef.current,
      reviewAssurance: {
        ...stateRef.current.reviewAssurance!,
        attempts: [
          {
            ...stateRef.current.reviewAssurance!.attempts[0]!,
            status: 'rejected',
            childSessionId: CHILD_SESSION_ID,
            completedAt: NOW,
          },
        ],
      },
    };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const { deps, blockReviewOutcome } = buildDeps(client, stateRef);
    const output = { output: contentAnalysisRequiredOutput() };

    await runReviewOrchestration(deps, {
      toolName: TOOL_FLOWGUARD_REVIEW,
      input: { args: { text: 'untrusted replacement' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    });

    expect(client.session.create).not.toHaveBeenCalled();
    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'REVIEW_ATTEMPT_UNAVAILABLE',
      expect.objectContaining({ reason: expect.stringContaining('bindable attempt') }),
      output,
    );
  });

  it('fails closed when persisted material does not match the frozen subject', async () => {
    const client = buildClient(buildFindings());
    const stateRef = { current: buildSessionState() };
    stateRef.current = {
      ...stateRef.current,
      reviewAssurance: {
        ...stateRef.current.reviewAssurance!,
        obligations: stateRef.current.reviewAssurance!.obligations.map((obligation) =>
          obligation.obligationId === OBLIGATION_ID
            ? {
                ...obligation,
                reviewMaterial: {
                  content: 'wrong material',
                  materialDigest: 'b'.repeat(64),
                  subjectDigest: SUBJECT_DIGEST,
                },
              }
            : obligation,
        ),
      },
    };
    vi.mocked(readState).mockResolvedValue(stateRef.current);
    const { deps, blockReviewOutcome } = buildDeps(client, stateRef);
    const output = { output: contentAnalysisRequiredOutput() };

    await runReviewOrchestration(deps, {
      toolName: TOOL_FLOWGUARD_REVIEW,
      input: { args: { text: 'untrusted replacement' } },
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    });

    expect(client.session.create).not.toHaveBeenCalled();
    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'REVIEW_MATERIAL_INTEGRITY_FAILED',
      expect.objectContaining({ reason: expect.stringContaining('digest does not match') }),
      output,
    );
  });

  it('blocks with SUBAGENT_EVIDENCE_REUSED when subagent findings were already used (atomic reuse check)', async () => {
    // Item 4: the reuse check and evidence append happen in a single
    // updateReviewAssurance transaction. A pre-existing invocation that shares
    // the reviewer child session must block reuse and must NOT fulfil the
    // obligation.
    const { output, blockReviewOutcome, state } = await runReviewContent(
      buildFindings(),
      { args: { text: 'diff content', inputOrigin: 'manual_text' } },
      true,
      undefined,
      [
        {
          invocationId: 'prior-invocation-1',
          obligationId: 'prior-obligation-1',
          obligationType: 'review',
          attemptId: '00000000-0000-4000-8000-0000000000c1',
          parentSessionId: PARENT_SESSION_ID,
          childSessionId: CHILD_SESSION_ID,
          agentType: 'flowguard-reviewer',
          invocationMode: 'sdk_session_prompt',
          hostVisible: false,
          promptHash: 'prior-prompt-hash',
          findingsHash: 'prior-findings-hash',
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          invokedAt: NOW,
          fulfilledAt: NOW,
          source: 'host-orchestrated',
          consumedByObligationId: null,
          reviewOutputMode: 'structured_output',
          structuredOutputUsed: true,
          reviewAssuranceLevel: 'structured_high',
          capturedRawFindings: { overallVerdict: 'accept' },
        },
      ],
    );

    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'SUBAGENT_EVIDENCE_REUSED',
    });
    const obligation = state.reviewAssurance?.obligations[0];
    expect(obligation?.status).toBe('blocked');
    expect(obligation?.blockedCode).toBe('SUBAGENT_EVIDENCE_REUSED');
    // No new invocation may be appended on the reuse path.
    expect(state.reviewAssurance?.invocations).toHaveLength(1);
  });
});
