/** Current reviewer transport proof. Historical invocation formats are not normalized. */
import { z } from 'zod';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { parseStrictJsonObject, JSON_OBJECT_BYTE_LIMIT } from '../shared/strict-json-object.js';
import { ReviewerFindingsInput } from './evidence-review-input.js';

const MessageId = z.string().regex(/^msg/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const ReviewerModelSelection = z
  .object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    /** null means the host proved that no named variant was selected. */
    variant: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();
export type ReviewerModelSelection = z.infer<typeof ReviewerModelSelection>;

export const ReviewMessageCapture = z
  .object({
    childSessionId: z.string().min(1),
    obligationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    requestMessageId: MessageId,
    responseMessageId: MessageId,
    requestDigest: Digest,
    payloadText: z.string().min(1).max(JSON_OBJECT_BYTE_LIMIT),
    payloadDigest: Digest,
    model: ReviewerModelSelection,
    /** Exactly one observed model step; no intervening tool or foreign request. */
    assistantMessageIds: z.tuple([MessageId]).readonly(),
  })
  .strict()
  .superRefine((capture, ctx) => {
    if (
      capture.requestMessageId === capture.responseMessageId ||
      capture.assistantMessageIds[0] !== capture.responseMessageId
    ) {
      ctx.addIssue({ code: 'custom', message: 'Capture request/response identity mismatch.' });
    }
    if (hashText(capture.payloadText) !== capture.payloadDigest) {
      ctx.addIssue({ code: 'custom', message: 'Capture payload digest mismatch.' });
    }
    const decoded = parseStrictJsonObject(capture.payloadText);
    const parsed = decoded.kind === 'ok' ? ReviewerFindingsInput.safeParse(decoded.value) : null;
    if (!parsed?.success || parsed.data.attestation.toolObligationId !== capture.obligationId) {
      ctx.addIssue({ code: 'custom', message: 'Capture payload violates ReviewerFindingsInput.' });
    }
  })
  .readonly();
export type ReviewMessageCapture = z.infer<typeof ReviewMessageCapture>;

export function hasCaptureLineage(invocation: {
  readonly childSessionId: string;
  readonly obligationId: string;
  readonly attemptId?: string | undefined;
  readonly capture?: ReviewMessageCapture | undefined;
}): boolean {
  const parsed = ReviewMessageCapture.safeParse(invocation.capture);
  return (
    parsed.success &&
    parsed.data.childSessionId === invocation.childSessionId &&
    parsed.data.obligationId === invocation.obligationId &&
    parsed.data.attemptId === invocation.attemptId
  );
}

/** Compare reviewer-owned semantics; host-stamped identities are never model authority. */
export function captureMatchesFindings(
  capture: ReviewMessageCapture,
  findings: Readonly<Record<string, unknown>>,
): boolean {
  if (!ReviewMessageCapture.safeParse(capture).success) return false;
  const decoded = parseStrictJsonObject(capture.payloadText);
  if (decoded.kind !== 'ok') return false;
  const original = ReviewerFindingsInput.safeParse(decoded.value);
  if (!original.success) return false;
  // The capture payload's reviewer attestation was already compared with the
  // bound obligation. Canonical findings carry a HOST-stamped attestation, so
  // only reviewer-owned semantic fields are compared here; obligation,
  // attempt, child and mandate identity are enforced by the surrounding gates.
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(ReviewerFindingsInput.unwrap().shape)) {
    if (key !== 'attestation') candidate[key] = findings[key];
  }
  candidate.attestation = original.data.attestation;
  if (Array.isArray(findings.challenges)) {
    candidate.challenges = findings.challenges.map((challenge: unknown) => {
      if (!challenge || typeof challenge !== 'object') return challenge;
      const result = { ...challenge } as Record<string, unknown>;
      delete result.challengeId;
      return result;
    });
  }
  const projected = ReviewerFindingsInput.safeParse(candidate);
  const withoutAttestation = ({ attestation: _attestation, ...rest }: Record<string, unknown>) =>
    rest;
  return (
    projected.success &&
    canonicalJsonStringify(withoutAttestation(original.data)) ===
      canonicalJsonStringify(withoutAttestation(projected.data))
  );
}
