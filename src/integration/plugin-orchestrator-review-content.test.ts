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

vi.mock('./plugin-review-audit.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../rails/review.js', () => ({
  loadExternalContent: vi.fn(),
}));

import { readState } from '../adapters/persistence.js';
import { loadExternalContent } from '../rails/review.js';
import { makeState, POLICY_SNAPSHOT } from '../__fixtures__.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps, ToolCallEvent } from './plugin-orchestrator.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review-assurance.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-review-1';
const CHILD_SESSION_ID = 'child-session-review-1';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SESS_DIR = '/tmp/fg-review-content-sess-dir';
const NOW = '2026-05-06T12:00:00.000Z';

function contentAnalysisRequiredOutput(): string {
  return (
    JSON.stringify({
      error: true,
      code: 'CONTENT_ANALYSIS_REQUIRED',
      phase: 'REVIEW',
      requiredReviewAttestation: {
        toolObligationId: OBLIGATION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        reviewedBy: 'flowguard-reviewer',
      },
    }) + '\nNext action: Run /continue'
  );
}

function buildFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

function buildClient(findings: Record<string, unknown> | null) {
  return {
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

function buildTextCompatClient(findings: Record<string, unknown>) {
  return {
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
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'review',
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

function buildDeps(
  client: unknown,
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
        sessionId: PARENT_SESSION_ID,
        pluginReviews: new Map(),
      }),
      log: { info: vi.fn(), warn: vi.fn() },
      client,
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
  clientOverride?: unknown,
  reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed',
) {
  const client = (clientOverride ?? buildClient(findings)) as
    | ReturnType<typeof buildClient>
    | ReturnType<typeof buildTextCompatClient>;
  const stateRef = {
    current: buildSessionState(strictEnforcement, reviewOutputPolicy, reviewInvocationPolicy),
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
    vi.mocked(loadExternalContent).mockResolvedValue({ content: 'diff content' } as never);
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
    expect(parsed.reviewInvocation).toMatchObject({
      policy: 'host_task_required',
      status: 'blocked_until_host_task',
      code: 'HOST_SUBAGENT_TASK_REQUIRED',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
    });
  });

  it('blocks with SUBAGENT_MANDATE_MISMATCH when strict /review attestation obligation mismatches', async () => {
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
      'SUBAGENT_MANDATE_MISMATCH',
      { obligationId: OBLIGATION_ID },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'SUBAGENT_MANDATE_MISMATCH',
    });
  });

  it('blocks with SUBAGENT_MANDATE_MISSING when strict /review findings omit attestation', async () => {
    const { attestation: _omit, ...findings } = buildFindings();
    void _omit;

    const { output, blockReviewOutcome } = await runReviewContent(findings);

    expect(blockReviewOutcome).toHaveBeenCalledWith(
      expect.anything(),
      OBLIGATION_ID,
      'SUBAGENT_MANDATE_MISSING',
      { obligationId: OBLIGATION_ID },
      output,
    );
    expect(JSON.parse(output.output)).toMatchObject({
      error: true,
      code: 'SUBAGENT_MANDATE_MISSING',
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
      obligationId: OBLIGATION_ID,
      obligationType: 'review',
      parentSessionId: PARENT_SESSION_ID,
      childSessionId: CHILD_SESSION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      fulfilledAt: NOW,
      source: 'host-orchestrated',
    });
    expect(invocation?.invocationId).toBe(obligation?.invocationId);
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toMatchObject({
      overallVerdict: 'approve',
      attestation: { toolObligationId: OBLIGATION_ID },
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

  it('supports direct /review input shape while injecting valid strict findings', async () => {
    const { output, blockReviewOutcome } = await runReviewContent(buildFindings(), {
      text: 'diff content',
      inputOrigin: 'manual_text',
    });

    expect(blockReviewOutcome).not.toHaveBeenCalled();
    expect(loadExternalContent).toHaveBeenCalledWith({
      text: 'diff content',
      prNumber: undefined,
      branch: undefined,
      url: undefined,
    });
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toMatchObject({
      attestation: { toolObligationId: OBLIGATION_ID },
    });
  });

  it('preserves non-strict /review fallback by injecting findings without blocking mismatch', async () => {
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
    expect(String(parsed.next)).toContain('PLUGIN_REVIEW_COMPLETED');
    expect(parsed.pluginReviewFindings).toMatchObject({
      attestation: { mandateDigest: 'wrong-digest-value' },
    });
  });
});
