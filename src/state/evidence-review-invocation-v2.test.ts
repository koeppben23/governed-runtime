/** Current V2 evidence/provenance boundary, including independent field corruption. */
import { describe, expect, it } from 'vitest';
import { messageCaptureFixture } from '../review-invocation-test-helpers.js';
import { buildInvocationEvidence } from '../integration/review/obligations/invocation-evidence.js';
import {
  ReviewInvocationEvidence,
  isAcceptedReviewTransport,
  type NativeSubagentCaptureProvenance,
} from './evidence-review-invocation.js';

const capture = messageCaptureFixture({
  childSessionId: 'child',
  obligationId: '11111111-1111-4111-8111-111111111111',
  attemptId: '11111111-2222-4111-8111-111111111111',
});
const provenance: NativeSubagentCaptureProvenance = {
  schemaVersion: 1,
  nativeCallId: 'native-call',
  requestMessageId: capture.requestMessageId,
  responseMessageId: capture.responseMessageId,
  requestDigest: capture.requestDigest,
  payloadDigest: capture.payloadDigest,
  model: capture.model,
  assistantMessageIds: [capture.responseMessageId],
  terminal: { outcome: 'succeeded', finish: 'stop', completedAt: '2026-11-02T00:00:01.000Z' },
  modelRequest: { kind: 'primary', model: capture.model },
  historyDigest: 'b'.repeat(64),
  userMessageCount: 1,
  toolAttemptCount: 0,
};
const input = {
  obligationId: capture.obligationId,
  obligationType: 'plan' as const,
  mandateDigest: 'mandate',
  criteriaVersion: 'criteria',
  parentSessionId: 'parent',
  childSessionId: 'child',
  promptHash: 'a'.repeat(64),
  findingsHash: 'c'.repeat(64),
  invokedAt: '2026-11-02T00:00:00.000Z',
  fulfilledAt: '2026-11-02T00:00:02.000Z',
  capturedRawFindings: { overallVerdict: 'accept' },
  capture,
  nativeProvenance: provenance,
  attemptId: capture.attemptId,
};
function invocation() {
  return buildInvocationEvidence(input);
}

describe('V2 invocation evidence trust boundary', () => {
  it('constructs all canonical fields without changing the caller provenance or findings', () => {
    const value = invocation();
    expect(value).toEqual({
      ...input,
      invocationId: expect.any(String),
      agentType: 'flowguard-reviewer',
      invocationMode: 'native_subagent_message_json',
      transportVersion: 6,
      hostVisible: true,
      transcriptNavigable: true,
      consumedByObligationId: null,
      capturedVerdict: 'accept',
      source: 'host-orchestrated',
      reviewOutputMode: 'validated_json',
      reviewAssuranceLevel: 'host_message_validated',
      canonicalPromptDigest: undefined,
      modelPromptDigest: undefined,
      resolvedBranchSha: null,
      resolvedBaseSha: null,
      reviewedContentDigest: null,
    });
    expect(ReviewInvocationEvidence.parse(value)).toEqual(value);
    expect(isAcceptedReviewTransport(value)).toBe(true);
    const explicit = buildInvocationEvidence({
      ...input,
      canonicalPromptDigest: 'd'.repeat(64),
      modelPromptDigest: 'e'.repeat(64),
      resolvedBranchSha: '1'.repeat(40),
      resolvedBaseSha: '2'.repeat(40),
      reviewedContentDigest: 'f'.repeat(64),
    });
    expect(explicit).toMatchObject({
      canonicalPromptDigest: 'd'.repeat(64),
      modelPromptDigest: 'e'.repeat(64),
      resolvedBranchSha: '1'.repeat(40),
      resolvedBaseSha: '2'.repeat(40),
      reviewedContentDigest: 'f'.repeat(64),
    });
    const { fulfilledAt: _fulfilledAt, ...withoutFulfillment } = input;
    const absent = buildInvocationEvidence({
      ...withoutFulfillment,
      capturedRawFindings: { overallVerdict: 1 },
    });
    expect(absent.fulfilledAt).toBeNull();
    expect(absent).not.toHaveProperty('capturedVerdict');
  });

  it.each([
    { requestMessageId: 'msg_foreign' },
    { responseMessageId: 'msg_foreign' },
    { requestDigest: 'f'.repeat(64) },
    { payloadDigest: 'f'.repeat(64) },
    { assistantMessageIds: ['msg_foreign'] },
    { model: { ...capture.model, providerID: 'foreign' } },
    { model: { ...capture.model, modelID: 'foreign' } },
    { model: { ...capture.model, variant: 'foreign' } },
    { modelRequest: { kind: 'primary', model: { ...capture.model, providerID: 'foreign' } } },
    { modelRequest: { kind: 'primary', model: { ...capture.model, modelID: 'foreign' } } },
    { modelRequest: { kind: 'primary', model: { ...capture.model, variant: 'foreign' } } },
    { terminal: { ...provenance.terminal, outcome: 'interrupted' } },
    { terminal: { ...provenance.terminal, finish: 'length' } },
    { modelRequest: { ...provenance.modelRequest, kind: 'compaction' } },
    { schemaVersion: 0 },
    { userMessageCount: 2 },
    { toolAttemptCount: 1 },
    { extra: true },
    { nativeCallId: '' },
  ])('rejects independent provenance corruption %j', (patch) => {
    expect(
      ReviewInvocationEvidence.safeParse({
        ...invocation(),
        nativeProvenance: { ...provenance, ...patch },
      }).success,
    ).toBe(false);
  });

  it.each([
    { transportVersion: 5 },
    { invocationMode: 'native_task_message_json' },
    { transportVersion: 7 },
    { nativeProvenance: undefined },
    { hostVisible: false },
    { transcriptNavigable: false },
    { source: 'submitted' },
    { reviewOutputMode: 'text' },
    { reviewAssuranceLevel: 'unstructured' },
    { extra: true },
  ])('rejects weakened or mismatched transport shape %j', (patch) => {
    expect(ReviewInvocationEvidence.safeParse({ ...invocation(), ...patch }).success).toBe(false);
  });

  it.each([
    {},
    { invocationMode: 'native_subagent_message_json', transportVersion: 6 },
    {
      invocationMode: 'native_task_message_json',
      transportVersion: 6,
      nativeProvenance: provenance,
    },
    {
      invocationMode: 'native_subagent_message_json',
      transportVersion: 5,
      nativeProvenance: provenance,
    },
    {
      invocationMode: 'native_subagent_message_json',
      transportVersion: 7,
      nativeProvenance: provenance,
    },
    { invocationMode: 'manual_attested', transportVersion: 6, nativeProvenance: provenance },
  ])('never accepts a mismatched transport predicate %j', (value) => {
    expect(isAcceptedReviewTransport(value)).toBe(false);
  });
});
