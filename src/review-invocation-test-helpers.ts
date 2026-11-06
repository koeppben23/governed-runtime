/** Current-generation evidence fixtures, never a production provenance source. */
import { buildInvocationEvidence } from './integration/review/obligations/assurance.js';
import type { ReviewMessageCapture } from './state/review-message-capture.js';
import type { NativeSubagentCaptureProvenance } from './state/evidence-review-invocation.js';
import { ReviewerFindingsInput } from './state/evidence-review-input.js';
import { hashText } from './shared/hashing.js';

export function messageCaptureFixture(input: {
  childSessionId: string;
  obligationId: string;
  attemptId: string;
  findings?: Readonly<Record<string, unknown>>;
}): ReviewMessageCapture {
  const original = input.findings ?? {};
  const candidate: Record<string, unknown> = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
  };
  for (const key of Object.keys(ReviewerFindingsInput.unwrap().shape)) {
    if (original[key] !== undefined) candidate[key] = original[key];
  }
  candidate.attestation = { toolObligationId: input.obligationId };
  if (Array.isArray(candidate.challenges)) {
    candidate.challenges = candidate.challenges.map((entry: Record<string, unknown>) => {
      const copy = { ...entry };
      delete copy.challengeId;
      return copy;
    });
  }
  const payloadText = JSON.stringify(candidate);
  const suffix = hashText(input.attemptId + input.childSessionId).slice(0, 16);
  return {
    childSessionId: input.childSessionId,
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    requestMessageId: `msg_request_${suffix}`,
    responseMessageId: `msg_response_${suffix}`,
    requestDigest: hashText('fixture serialization'),
    payloadText,
    payloadDigest: hashText(payloadText),
    model: { providerID: 'fixture', modelID: 'agent', variant: null },
    assistantMessageIds: [`msg_response_${suffix}`],
  };
}

/**
 * Generation-6 terminal-capture provenance derived from a capture fixture. The
 * native call identity defaults to the child session, which is also the
 * dispatch host-call identity used by the shared ledger fixtures.
 */
export function nativeProvenanceFixture(
  capture: ReviewMessageCapture,
  nativeCallId: string = capture.childSessionId,
): NativeSubagentCaptureProvenance {
  return {
    schemaVersion: 1,
    nativeCallId,
    requestMessageId: capture.requestMessageId,
    responseMessageId: capture.responseMessageId,
    requestDigest: capture.requestDigest,
    payloadDigest: capture.payloadDigest,
    model: capture.model,
    assistantMessageIds: [capture.responseMessageId],
    terminal: { outcome: 'succeeded', finish: 'stop', completedAt: '2026-11-02T00:00:01.000Z' },
    modelRequest: { kind: 'primary', model: capture.model },
    historyDigest: hashText(`history:${capture.attemptId}`),
    userMessageCount: 1,
    toolAttemptCount: 0,
  };
}

/** Current-generation (6) invocation evidence; capture and provenance are derived when omitted. */
export function buildInvocationFixture(
  input: Omit<Parameters<typeof buildInvocationEvidence>[0], 'capture' | 'nativeProvenance'> & {
    readonly capture?: ReviewMessageCapture;
    readonly nativeProvenance?: NativeSubagentCaptureProvenance;
    readonly nativeCallId?: string;
  },
) {
  const { capture, nativeProvenance, nativeCallId, ...rest } = input;
  const resolved =
    capture ?? messageCaptureFixture({ ...rest, findings: rest.capturedRawFindings });
  return buildInvocationEvidence({
    ...rest,
    capture: resolved,
    nativeProvenance: nativeProvenance ?? nativeProvenanceFixture(resolved, nativeCallId),
  });
}
