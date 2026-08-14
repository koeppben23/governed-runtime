/**
 * @module integration/plugin-orchestrator-review-content.test
 * @description Regression coverage for strict host-orchestrated /review content analysis.
 *
 * Contract under test:
 * - In strict enforcement, host-orchestrated /review MUST fail closed when
 *   subagent findings are missing, lack attestation, or carry mismatched
 *   attestation.
 * - A valid attestation still injects pluginReviewFindings and records
 *   host-orchestrated evidence.
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
    attestation: {
      toolObligationId: OBLIGATION_ID,
    },
    ...overrides,
  };
}

function buildClient(findings: Record<string, unknown> | null): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: CHILD_SESSION_ID }, error: undefined }),
      prompt: vi
        .fn()
        .mockResolvedValue(
          findings
            ? { data: { info: { structured_output: findings } }, error: undefined }
            : { data: { info: {} }, error: undefined },
        ),
    },
  };
}

function buildTextCompatClient(findings: Record<string, unknown>): OrchestratorClient {
  return {
    app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
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
  reviewOutputPolicy: 'structured_required' | 'text_compat_allowed' = 'structured_required',
  reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed',
  seedInvocations: NonNullable<SessionState['reviewAssurance']>['invocations'] = [],
) {
  return makeState('REVIEW', {
    ticket: {
      text: 'Review the authentication changes',
      digest: 'ticket-digest-review',
      source: 'user',
      createdAt: NOW,
    },
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      selfReview: {
        subagentEnabled: true,
        fallbackToSelf: false,
        strictEnforcement,
      },
      reviewOutputPolicy,
      ...(reviewInvocationPolicy ? { reviewInvocationPolicy } : {}),
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'review',
          subjectDigest: SUBJECT_DIGEST,
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
          reviewMaterial: {
            content: PERSISTED_CONTENT,
            materialDigest: MATERIAL_DIGEST,
            subjectDigest: SUBJECT_DIGEST,
          },
          ordinal: 1,
          status: 'created',
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          createdAt: NOW,
        },
      ],
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
  reviewOutputPolicy: 'structured_required' | 'text_compat_allowed' = 'structured_required',
  clientOverride?: OrchestratorClient,
  reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed',
  seedInvocations: NonNullable<SessionState['reviewAssurance']>['invocations'] = [],
) {
  const client = clientOverride ?? buildClient(findings);
  const stateRef = {
    current: buildSessionState(
      strictEnforcement,
      reviewOutputPolicy,
      reviewInvocationPolicy,
      seedInvocations,
    ),
  };
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

  it('host_task_required does not call SDK for standalone /review', async () => {
    const { output, client } = await runReviewContent(
      buildFindings(),
      { args: { text: 'diff content', inputOrigin: 'manual_text' } },
      true,
      'structured_required',
      undefined,
      'host_task_required',
    );

    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.code).toBe('HOST_SUBAGENT_TASK_REQUIRED');
    expect(parsed.recovery).toEqual([
      expect.stringContaining('host-visible subagent invocation via the OpenCode Task tool'),
    ]);
    expect(parsed.reviewInvocation).toMatchObject({
      policy: 'host_task_required',
      status: 'blocked_until_host_task',
      code: 'HOST_SUBAGENT_TASK_REQUIRED',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
    });
  });

  it('standalone /review host-task instruction forwards obligation attestation + cycle context', async () => {
    // Regression: standalone /review Call 1 emits CONTENT_ANALYSIS_REQUIRED with
    // no `next`, so the host-task instruction previously omitted iteration/
    // planVersion AND the requiredReviewAttestation. The reviewer then defaulted
    // toolObligationId to "NOT_VERIFIED" and the verdict could not bind host-task
    // evidence. The instruction must now source these from the obligation.
    const { output } = await runReviewContent(
      buildFindings(),
      { args: { text: 'diff content', inputOrigin: 'manual_text' } },
      true,
      'structured_required',
      undefined,
      'host_task_required',
    );

    const parsed = JSON.parse(output.output) as Record<string, unknown>;

    // Structured attestation forwarded from the obligation (machine-readable).
    expect(parsed.requiredReviewAttestation).toMatchObject({
      reviewedBy: 'flowguard-reviewer',
      toolObligationId: OBLIGATION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration: 1,
      planVersion: 1,
    });

    // The host instruction identifies the obligation without asking the parent
    // agent to construct reviewer attestation fields.
    const next = String(parsed.next);
    expect(next).toContain('iteration=1');
    expect(next).toContain('planVersion=1');
    expect(next).toContain(`Host context identifies obligation ${OBLIGATION_ID}`);
    expect(next).toContain('do not construct reviewer attestation fields');
    const reviewerTaskPrompt = String(parsed.reviewerTaskPrompt);
    expect(reviewerTaskPrompt).toContain('persisted diff content');
    expect(reviewerTaskPrompt).toContain('## Frozen Review Subject');
    expect(reviewerTaskPrompt).toContain('## Review Subject Scope (frozen obligation scope)');
    expect(reviewerTaskPrompt).toContain(
      JSON.stringify({ kind: 'content', subjectDigest: SUBJECT_DIGEST, lineCount: 1 }),
    );
    expect(reviewerTaskPrompt).toContain(
      'Content review: subjectAnchors must use kind=content with the exact frozen subjectDigest.',
    );
    expect(reviewerTaskPrompt).not.toContain('content to review below this line:');
  });

  it('blocks malformed reviewer attestation at the strict input boundary', async () => {
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

    const { output, blockReviewOutcome } = await runReviewContent(findings);

    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'STRICT_REVIEW_ORCHESTRATION_FAILED',
      {
        obligationId: OBLIGATION_ID,
        reason: 'reviewer response did not match ReviewFindings schema',
      },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    });
  });

  it('blocks missing reviewer attestation at the strict input boundary', async () => {
    const { attestation: _omit, ...findings } = buildFindings();
    void _omit;

    const { output, blockReviewOutcome } = await runReviewContent(findings);

    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'STRICT_REVIEW_ORCHESTRATION_FAILED',
      {
        obligationId: OBLIGATION_ID,
        reason: 'reviewer response did not match ReviewFindings schema',
      },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    });
  });

  it('blocks with STRICT_REVIEW_ORCHESTRATION_FAILED when strict /review reviewer returns no findings', async () => {
    const { output, blockReviewOutcome } = await runReviewContent(null);

    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'STRICT_REVIEW_ORCHESTRATION_FAILED',
      {
        obligationId: OBLIGATION_ID,
        reason: 'reviewer response was not parseable as ReviewFindings',
      },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
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

  it('injects pluginReviewFindings and records evidence when strict /review attestation is valid', async () => {
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
      fulfilledAt: NOW,
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
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      invokedAt: NOW,
      fulfilledAt: NOW,
      consumedByObligationId: null,
      source: 'host-orchestrated',
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    });
    expect(invocation?.invocationId).toBe(obligation?.invocationId);
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toMatchObject({
      overallVerdict: 'accept',
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      attestation: {
        toolObligationId: OBLIGATION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    });
    expect(parsed._pluginReviewSessionId).toBe(CHILD_SESSION_ID);
  });

  it('passes explicit reviewOutputPolicy for /review content text compatibility', async () => {
    const findings = buildFindings();
    const textCompatClient = buildTextCompatClient(findings);
    const { output, blockReviewOutcome, state, client } = await runReviewContent(
      findings,
      { args: { text: 'diff content', inputOrigin: 'manual_text' } },
      true,
      'text_compat_allowed',
      textCompatClient,
    );

    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    const invocation = state.reviewAssurance?.invocations[0];
    expect(invocation).toMatchObject({
      reviewOutputMode: 'text_compat',
      structuredOutputUsed: false,
      reviewAssuranceLevel: 'text_compat_lower',
      extractionMethod: 'direct_json',
    });
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.pluginReviewOutput).toMatchObject({
      reviewOutputMode: 'text_compat',
      structuredOutputUsed: false,
      reviewAssuranceLevel: 'text_compat_lower',
      extractionMethod: 'direct_json',
    });
  });

  it('uses persisted material rather than direct /review input while injecting valid strict findings', async () => {
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
    expect(parsed.pluginReviewFindings).toMatchObject({
      attestation: { toolObligationId: OBLIGATION_ID },
    });
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
    // No attempt means the obligation predates the frozen-material contract:
    // current mutable state must not be used to reconstruct reviewer input.
    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'REVIEW_MATERIAL_INTEGRITY_FAILED',
      expect.objectContaining({
        reason: expect.stringContaining('predates frozen review material'),
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
        attempts: [
          {
            ...stateRef.current.reviewAssurance!.attempts[0]!,
            reviewMaterial: {
              content: 'wrong material',
              materialDigest: 'b'.repeat(64),
              subjectDigest: SUBJECT_DIGEST,
            },
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
      'REVIEW_MATERIAL_INTEGRITY_FAILED',
      expect.objectContaining({ reason: expect.stringContaining('digest does not match') }),
      output,
    );
  });

  it('does not mutate output for non-strict malformed reviewer input', async () => {
    const findings = buildFindings({
      attestation: {
        mandateDigest: 'wrong-digest-value',
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: OBLIGATION_ID,
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    });

    const { output, blockReviewOutcome, updateReviewAssurance } = await runReviewContent(
      findings,
      { args: { text: 'diff content', inputOrigin: 'manual_text' } },
      false,
    );

    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(updateReviewAssurance).not.toHaveBeenCalled();
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.next).toBeUndefined();
    expect(parsed.pluginReviewFindings).toBeUndefined();
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
      'structured_required',
      undefined,
      undefined,
      [
        {
          invocationId: 'prior-invocation-1',
          obligationId: 'prior-obligation-1',
          obligationType: 'review',
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
          capturedVerdict: 'accept',
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
