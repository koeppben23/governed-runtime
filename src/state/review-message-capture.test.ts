import { describe, expect, it } from 'vitest';
import { messageCaptureFixture } from '../review-invocation-test-helpers.js';
import {
  ReviewMessageCapture,
  captureMatchesFindings,
  hasCaptureLineage,
} from './review-message-capture.js';
import { hashText } from '../shared/hashing.js';

function fixture() {
  const lineage = {
    childSessionId: 'child',
    obligationId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
  };
  const capture = messageCaptureFixture(lineage);
  const findings = JSON.parse(capture.payloadText) as Record<string, unknown>;
  return { lineage, capture, findings };
}

describe('current reviewer message proof boundary', () => {
  it('accepts a valid payload and independently matches its exact invocation lineage', () => {
    const { lineage, capture, findings } = fixture();
    expect(ReviewMessageCapture.safeParse(capture).success).toBe(true);
    expect(hasCaptureLineage({ ...lineage, capture })).toBe(true);
    expect(captureMatchesFindings(capture, findings)).toBe(true);
    expect(
      captureMatchesFindings(capture, {
        ...findings,
        reviewedAt: '2026-10-30T00:00:00Z',
        reviewedBy: { sessionId: 'host-stamped' },
      }),
    ).toBe(true);
  });

  it.each(['childSessionId', 'attemptId', 'obligationId'] as const)(
    'rejects a different %s at consumption',
    (field) => {
      const { lineage, capture } = fixture();
      expect(hasCaptureLineage({ ...lineage, [field]: 'another', capture })).toBe(false);
    },
  );

  it.each(['overallVerdict', 'iteration', 'planVersion', 'missingVerification', 'challenges'])(
    'rejects changed reviewer-owned %s without treating it as host stamping',
    (field) => {
      const { capture, findings } = fixture();
      const changed = {
        ...findings,
        [field]:
          field === 'overallVerdict'
            ? 'unable_to_review'
            : field === 'iteration' || field === 'planVersion'
              ? 9
              : ['changed'],
      };
      expect(captureMatchesFindings(capture, changed)).toBe(false);
    },
  );

  it('excludes only host-minted challenge identity while preserving all challenge semantics', () => {
    const { lineage } = fixture();
    const input = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      attestation: { toolObligationId: lineage.obligationId },
      challenges: [
        {
          obligationId: lineage.obligationId,
          clientReference: 'c1',
          kind: 'design_challenge',
          scenario: 'Remove the guard.',
          claim: 'The explicit check detects the failure.',
          locations: ['Plan'],
          outcome: 'supported',
          evidenceRefs: [
            {
              kind: 'plan_adr_section',
              artifactKind: 'plan',
              artifactDigest: 'a'.repeat(64),
              sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
              excerptDigest: 'b'.repeat(64),
            },
          ],
        },
      ],
    };
    const capture = messageCaptureFixture({ ...lineage, findings: input });
    const canonical = {
      ...input,
      challenges: input.challenges.map((entry) => ({ ...entry, challengeId: 'host-id' })),
    };
    expect(captureMatchesFindings(capture, canonical)).toBe(true);
    expect(
      captureMatchesFindings(capture, {
        ...canonical,
        challenges: canonical.challenges.map((entry) => ({
          ...entry,
          claim: 'A different conclusion',
        })),
      }),
    ).toBe(false);
  });

  it.each([
    'same-id',
    'wrong-step',
    'extra-step',
    'digest',
    'invalid-json',
    'wrong-obligation',
    'old-assurance',
  ])('rejects %s capture proof and never recovers it from the canonical findings', (failure) => {
    const { capture, findings, lineage } = fixture();
    let bad: unknown = capture;
    if (failure === 'same-id')
      bad = {
        ...capture,
        responseMessageId: capture.requestMessageId,
        assistantMessageIds: [capture.requestMessageId],
      };
    if (failure === 'wrong-step') bad = { ...capture, assistantMessageIds: ['msg_other'] };
    if (failure === 'extra-step')
      bad = { ...capture, assistantMessageIds: [capture.responseMessageId, 'msg_extra'] };
    if (failure === 'digest') bad = { ...capture, payloadDigest: '0'.repeat(64) };
    if (failure === 'invalid-json')
      bad = { ...capture, payloadText: '{} {}', payloadDigest: hashText('{} {}') };
    if (failure === 'wrong-obligation')
      bad = { ...capture, obligationId: '33333333-3333-4333-8333-333333333333' };
    if (failure === 'old-assurance')
      bad = { ...capture, structuredOutputUsed: true, reviewAssuranceLevel: 'structured_high' };
    expect(ReviewMessageCapture.safeParse(bad).success).toBe(false);
    expect(hasCaptureLineage({ ...lineage, capture: bad as ReviewMessageCapture })).toBe(false);
    expect(captureMatchesFindings(bad as ReviewMessageCapture, findings)).toBe(false);
  });
});
