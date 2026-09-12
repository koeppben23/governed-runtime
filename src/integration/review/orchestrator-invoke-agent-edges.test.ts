import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { invokeReviewer, type ReviewerSuccessResult } from './orchestrator.js';
import { buildPlanReviewPrompt } from './prompt-builders.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { validFindings, NO_SLEEP, makeClient, PROMPT } from './orchestrator-test-helpers.js';

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
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });

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
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });
    const success = expectReviewerSuccess(result);
    expect(success.sessionId).toBe('child-session-1');
    expect(success.findings?.overallVerdict).toBe('accept');
  });

  it('probes the agent registry only once after successful capability resolution', async () => {
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await invokeReviewer(client, PROMPT, 'p1', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });
    await invokeReviewer(client, PROMPT, 'p2', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });
    expect(client.app.agents).toHaveBeenCalledTimes(1);
  });

  it('blocks rather than falling back when flowguard-reviewer is not registered', async () => {
    const client = makeClient({ agents: [{ id: 'general' }] });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({
      blocked: true,
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
      reviewInvocation: { status: 'blocked_capability_mismatch' },
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('blocks rather than falling back when the capability probe throws', async () => {
    const client = makeClient({ agentsThrows: true });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      _sleepFn: NO_SLEEP,
    });
    expect(result).toMatchObject({ blocked: true, code: 'REVIEWER_INVOCATION_EXHAUSTED' });
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('does not accept unstructured text as structured output under structured_required', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: {
          parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
          info: { structured_output: undefined },
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toBeNull();
  });

  it('accepts a host-validated StructuredOutput tool part', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: {
          parts: [
            {
              type: 'tool',
              tool: 'StructuredOutput',
              callID: 'call-1',
              state: {
                status: 'completed',
                input: validFindings({ overallVerdict: 'accept' }),
                metadata: { valid: true },
              },
            },
          ],
          info: {},
        },
        error: undefined,
      },
    });
    const success = expectReviewerSuccess(
      await invokeReviewer(client, PROMPT, 'parent-1', {
        reviewInvocationPolicy: 'sdk_allowed',
        _sleepFn: NO_SLEEP,
      }),
    );
    expect(success.reviewOutputMode).toBe('structured_output');
    expect(success.reviewAssuranceLevel).toBe('structured_high');
    expect(success.findings?.overallVerdict).toBe('accept');
  });

  it('rejects a StructuredOutput tool part that the host did not validate', async () => {
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: {
          parts: [
            {
              type: 'tool',
              tool: 'StructuredOutput',
              state: {
                status: 'completed',
                input: validFindings(),
                metadata: { valid: false },
              },
            },
          ],
          info: {},
        },
        error: undefined,
      },
    });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
    });
    expect(result).toBeNull();
  });

  it('does not rewrite reviewer-supplied provenance', async () => {
    const findings = validFindings({ reviewedBy: { sessionId: 'wrong' } });
    const client = makeClient({
      agents: [{ id: 'flowguard-reviewer' }],
      promptResult: {
        data: { parts: [], info: { structured: findings } },
        error: undefined,
      },
    });
    const success = expectReviewerSuccess(
      await invokeReviewer(client, PROMPT, 'parent-1', {
        reviewInvocationPolicy: 'sdk_allowed',
        _sleepFn: NO_SLEEP,
      }),
    );
    expect(success.findings?.reviewedBy).toEqual({ sessionId: 'wrong' });
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
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    const success = expectReviewerSuccess(
      await invokeReviewer(client, realPrompt, 'sess-e2e', {
        reviewInvocationPolicy: 'sdk_allowed',
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
