import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { invokeReviewer, type ReviewerSuccessResult } from './orchestrator.js';
import { buildPlanReviewPrompt } from './prompt-builders.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { validFindings, NO_SLEEP, makeClient, PROMPT } from './orchestrator-test-helpers.js';

function hostStructuredFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const {
    reviewedBy: _reviewedBy,
    reviewedAt: _reviewedAt,
    ...findings
  } = validFindings(overrides);
  return {
    ...findings,
    challenges: [],
    attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
  };
}

function expectReviewerSuccess(
  result: Awaited<ReturnType<typeof invokeReviewer>>,
): ReviewerSuccessResult {
  expect(result && !result.blocked).toBe(true);
  if (!result || result.blocked) throw new Error('Expected reviewer success result');
  return result;
}

const DISCOVERY_CONTEXT = {};

describe('invokeReviewer — agent capability and extraction edges', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('uses the isolated flowguard-reviewer without a prompt-level system substitute', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: { data: { parts: [], info: { structured: hostStructuredFindings() } } },
    });
    await invokeReviewer(client, PROMPT, 'parent-1', { _sleepFn: NO_SLEEP });

    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agent: 'flowguard-reviewer',
          parts: [{ type: 'text', text: PROMPT }],
          format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
        }),
      }),
    );
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.body.system).toBeUndefined();
  });

  it('returns structured findings from the isolated reviewer', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: { data: { parts: [], info: { structured: hostStructuredFindings() } } },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      _sleepFn: NO_SLEEP,
    });
    const success = expectReviewerSuccess(result);
    expect(success.sessionId).toBe('child-session-1');
    expect(success.findings?.overallVerdict).toBe('accept');
  });

  it('probes the agent registry only once after successful capability resolution', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: { data: { parts: [], info: { structured: hostStructuredFindings() } } },
    });
    await invokeReviewer(client, PROMPT, 'p1', {
      _sleepFn: NO_SLEEP,
    });
    await invokeReviewer(client, PROMPT, 'p2', {
      _sleepFn: NO_SLEEP,
    });
    expect(client.app.agents).toHaveBeenCalledTimes(1);
  });

  it('blocks rather than falling back when flowguard-reviewer is not registered', async () => {
    const client = makeClient({ agents: [{ id: 'general' }] });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({
      blocked: true,
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reviewInvocation: { status: 'blocked_capability_mismatch' },
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('blocks rather than falling back when the capability probe throws', async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const client = makeClient({ agentsThrows: true });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      _sleepFn: NO_SLEEP,
      _onAttemptFailed: (info) => diagnostics.push(info),
    });
    expect(result).toMatchObject({
      blocked: true,
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.step).toBe('agent_probe');
    const details = diagnostics[0]!.details as Record<string, unknown>;
    expect(details.reviewerSubagentType).toBe('flowguard-reviewer');
  });

  it('blocks when info.structured is absent rather than accepting text output', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: {
          parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
          info: {},
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      maxTransportRetries: 0,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({ blocked: true, code: 'HOST_STRUCTURED_OUTPUT_REQUIRED' });
  });

  it('accepts host-structured findings without reviewer-supplied provenance', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: { parts: [], info: { structured: hostStructuredFindings() } },
        error: undefined,
      },
    });
    const success = expectReviewerSuccess(
      await invokeReviewer(client, PROMPT, 'parent-1', {
        _sleepFn: NO_SLEEP,
      }),
    );
    expect(success.findings).not.toHaveProperty('reviewedBy');
  });

  it('carries a real plan-review prompt through the isolated structured path', async () => {
    const realPrompt = buildPlanReviewPrompt({
      planText: 'Add auth middleware to /settings route',
      ticketText: 'TICKET-123: Settings auth',
      iteration: 0,
      planVersion: 1,
      obligationId: '22222222-2222-4222-8222-222222222222',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'abc123',
      discoveryContext: DISCOVERY_CONTEXT,
    });
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: { data: { parts: [], info: { structured: hostStructuredFindings() } } },
    });
    const success = expectReviewerSuccess(
      await invokeReviewer(client, realPrompt, 'sess-e2e', {
        _sleepFn: NO_SLEEP,
      }),
    );
    expect(success.rawResponse).toBeTruthy();
    expect(JSON.parse(success.rawResponse)).toHaveProperty('overallVerdict');
    const call = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.body.agent).toBe('flowguard-reviewer');
    expect(call.body.system).toBeUndefined();
  });
});
