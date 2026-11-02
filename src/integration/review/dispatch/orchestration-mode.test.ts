import { describe, expect, it } from 'vitest';
import { resolveReviewOrchestrationMode } from './orchestration-mode.js';
import { buildChildSessionReviewInstruction } from './child-session-instruction.js';
import {
  artifactReviewSubjectScope,
  createObligationAndAttempt,
} from '../obligations/assurance.js';
import type { ReviewDispatchAuthority } from './dispatch-authority.js';

describe('review orchestration mode projection', () => {
  it('selects host_structured when native structured review is available', () => {
    expect(resolveReviewOrchestrationMode({ nativeStructuredReview: true })).toBe(
      'host_structured',
    );
  });

  it('selects external instructions only when that transport is actually available', () => {
    expect(
      resolveReviewOrchestrationMode({
        nativeStructuredReview: false,
        externalInstructionTransport: true,
      }),
    ).toBe('external_instruction_pending');
  });

  it('fails closed without a structured or external transport', () => {
    expect(resolveReviewOrchestrationMode({ nativeStructuredReview: false })).toBe(
      'unsupported_blocked',
    );
    expect(
      resolveReviewOrchestrationMode({
        nativeStructuredReview: false,
        externalInstructionTransport: false,
      }),
    ).toBe('unsupported_blocked');
  });
});

describe('child-session review instruction metadata', () => {
  it('projects a native subagent only for host_structured review', () => {
    const minted = createObligationAndAttempt(
      undefined,
      {
        policySnapshot: {
          challengePolicy: {
            version: 'challenge-policy.v1',
            counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
          },
          maxReviewerAttempts: 1,
        },
        obligationType: 'plan',
        reviewCycle: 1,
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: '2026-01-01T00:00:00.000Z',
        subjectDigest: 'test',
        reviewMaterial: {
          content: 'frozen review material',
          materialDigest: 'a'.repeat(64),
          subjectDigest: 'test',
        },
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
      },
      '2026-01-01T00:00:00.000Z',
    );
    const authority: ReviewDispatchAuthority = {
      obligation: minted.obligation,
      attempt: minted.attempt,
    };
    const structured = buildChildSessionReviewInstruction({
      mode: 'host_structured',
      authority,
      iteration: 0,
      planVersion: 1,
    });
    expect(structured).toMatchObject({
      mode: 'host_structured',
      transport: 'native_subagent',
    });
    expect(structured).not.toHaveProperty('platform');

    const external = buildChildSessionReviewInstruction({
      mode: 'external_instruction_pending',
      authority,
      iteration: 0,
      planVersion: 1,
    });
    expect(external.mode).toBe('external_instruction_pending');
    expect(external).not.toHaveProperty('transport');
    expect(external.authority).toBe('review_obligation_evidence_binding');
    expect(external.requiredReviewAttestation?.toolObligationId).toBe(
      minted.obligation.obligationId,
    );
    expect(external).not.toHaveProperty('reviewerTaskPrompt');
  });
});
