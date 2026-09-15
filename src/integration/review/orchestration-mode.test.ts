import { describe, expect, it } from 'vitest';
import {
  resolveReviewOrchestrationMode,
  normalizeReviewHostPlatform,
} from './orchestration-mode.js';
import { buildChildSessionReviewInstruction } from './child-session-instruction.js';
import { artifactReviewSubjectScope, createReviewObligation } from './assurance.js';

describe('review orchestration mode projection', () => {
  it('keeps OpenCode on host_structured', () => {
    expect(resolveReviewOrchestrationMode({ platform: 'opencode' })).toBe('host_structured');
  });

  it('treats Claude and Codex as external instruction transport when native review is available', () => {
    expect(
      resolveReviewOrchestrationMode({
        platform: 'claude-code',
      }),
    ).toBe('external_instruction_pending');
    expect(
      resolveReviewOrchestrationMode({
        platform: 'codex',
      }),
    ).toBe('external_instruction_pending');
  });

  it('blocks Claude and Codex when native review is unavailable', () => {
    expect(
      resolveReviewOrchestrationMode({
        platform: 'claude-code',
        nativeReviewerAvailable: false,
      }),
    ).toBe('unsupported_blocked');
    expect(
      resolveReviewOrchestrationMode({
        platform: 'codex',
        nativeReviewerAvailable: false,
      }),
    ).toBe('unsupported_blocked');
  });

  it('fails closed for unknown platform', () => {
    expect(resolveReviewOrchestrationMode({ platform: 'unknown' })).toBe('unsupported_blocked');
  });

  it('normalizes unsupported platform labels to unknown', () => {
    expect(normalizeReviewHostPlatform('windsurf')).toBe('unknown');
  });
});

describe('child-session review instruction metadata', () => {
  it('includes the binding envelope without projecting a reviewer prompt', () => {
    const obligation = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'plan',
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
    });
    const instruction = buildChildSessionReviewInstruction({
      mode: 'external_instruction_pending',
      platform: 'claude-code',
      obligation,
      iteration: 0,
      planVersion: 1,
    });

    expect(instruction.mode).toBe('external_instruction_pending');
    expect(instruction.authority).toBe('review_obligation_evidence_binding');
    expect(instruction.requiredReviewAttestation?.toolObligationId).toBe(obligation.obligationId);
    expect(instruction).not.toHaveProperty('reviewerTaskPrompt');
  });
});
