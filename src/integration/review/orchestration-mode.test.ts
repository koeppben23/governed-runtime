import { describe, expect, it } from 'vitest';
import {
  resolveReviewOrchestrationMode,
  normalizeReviewHostPlatform,
} from './orchestration-mode.js';
import { buildPendingReviewInstruction } from './pending-instruction.js';
import { createReviewObligation } from './assurance.js';

describe('review orchestration mode projection', () => {
  it('keeps OpenCode on host_task_sync', () => {
    expect(resolveReviewOrchestrationMode({ platform: 'opencode' })).toBe('host_task_sync');
  });

  it('treats Claude and Codex as external instruction transport when policy allows', () => {
    expect(
      resolveReviewOrchestrationMode({
        platform: 'claude-code',
        reviewInvocationPolicy: 'sdk_allowed',
      }),
    ).toBe('external_instruction_pending');
    expect(
      resolveReviewOrchestrationMode({
        platform: 'codex',
        reviewInvocationPolicy: 'host_task_preferred',
      }),
    ).toBe('external_instruction_pending');
  });

  it('blocks Claude and Codex when reviewInvocationPolicy is host_task_required', () => {
    expect(
      resolveReviewOrchestrationMode({
        platform: 'claude-code',
        reviewInvocationPolicy: 'host_task_required',
      }),
    ).toBe('unsupported_blocked');
    expect(
      resolveReviewOrchestrationMode({
        platform: 'codex',
        reviewInvocationPolicy: 'host_task_required',
      }),
    ).toBe('unsupported_blocked');
  });

  it('returns manual_attested_required for Claude/Codex host_task_required when manual allowed', () => {
    expect(
      resolveReviewOrchestrationMode({
        platform: 'claude-code',
        reviewInvocationPolicy: 'host_task_required',
        manualAttestedAllowed: true,
      }),
    ).toBe('manual_attested_required');
  });

  it('fails closed for unknown platform unless manual attested is explicitly allowed', () => {
    expect(resolveReviewOrchestrationMode({ platform: 'unknown' })).toBe('unsupported_blocked');
    expect(
      resolveReviewOrchestrationMode({ platform: 'unknown', manualAttestedAllowed: true }),
    ).toBe('manual_attested_required');
  });

  it('normalizes unsupported platform labels to unknown', () => {
    expect(normalizeReviewHostPlatform('windsurf')).toBe('unknown');
  });
});

describe('pending review instruction renderer', () => {
  it('states external agents are transport only and includes binding envelope', () => {
    const obligation = createReviewObligation({
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
    });
    const instruction = buildPendingReviewInstruction({
      mode: 'external_instruction_pending',
      platform: 'claude-code',
      reviewKind: 'plan',
      obligation,
      iteration: 0,
      planVersion: 1,
      subjectLabel: 'plan',
    });

    expect(instruction.reviewInvocation.mode).toBe('external_instruction_pending');
    expect(instruction.reviewInvocation.authority).toBe('review_obligation_evidence_binding');
    expect(instruction.reviewInvocation.requiredReviewAttestation?.toolObligationId).toBe(
      obligation.obligationId,
    );
    expect(instruction.next).toContain('transport/isolation artifacts only');
    expect(instruction.next).toContain('validated, obligation-bound ReviewFindings');
    expect(instruction.next).toContain('flowguard_decision');
  });
});
