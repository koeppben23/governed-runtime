/** Current-generation evidence fixtures, never a production provenance source. */
import { buildInvocationEvidence } from './integration/review/obligations/assurance.js';
import type { ReviewMessageCapture } from './state/review-message-capture.js';
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

export function buildInvocationFixture(
  input: Omit<Parameters<typeof buildInvocationEvidence>[0], 'capture'> & {
    readonly capture?: ReviewMessageCapture;
  },
) {
  const { capture, ...rest } = input;
  return buildInvocationEvidence({
    ...rest,
    capture: capture ?? messageCaptureFixture({ ...rest, findings: rest.capturedRawFindings }),
  });
}
