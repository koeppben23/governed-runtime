/**
 * @module artifact-host-task-integrity.test
 * @description Product-path regression for artifact-scoped obligations on the
 *              initial host-task prompt path:
 *
 *              - a material generation bound to a DIFFERENT artifact digest
 *                fails closed BEFORE the reviewer Task is dispatched and no
 *                reviewerTaskPrompt is emitted (same authority as the
 *                output-repair path)
 *              - a valid artifact obligation emits a reviewerTaskPrompt that
 *                carries the exact host-enforced anchor contract (digest,
 *                section paths, artifact_section, evidenceLocations-only)
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it, vi } from 'vitest';
import { handleHostTaskPolicy } from './host-task-policy.js';
import { extractReviewContext } from './orchestrator-detection.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './assurance.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewObligation } from '../../state/evidence.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SESSION_ID = 'ses-parent-integrity';
const ADR_TEXT = '## Context\nC\n## Decision\nD\n## Consequences\nE';
const ADR_DIGEST = 'adr-digest-D2';

function architectureObligation(materialSubjectDigest: string): ReviewObligation {
  return createReviewObligation({
    obligationType: 'architecture',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: ADR_DIGEST,
    reviewMaterial: freezeReviewMaterial(
      `## Ticket Under Review (originating request)\n\nnull\n\n## Architecture Decision Artifact\n\n${ADR_TEXT}\n`,
      materialSubjectDigest,
    ),
    reviewSubjectScope: artifactReviewSubjectScope('adr', ADR_TEXT, ADR_DIGEST),
    changedFiles: ['src/foo.ts'],
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerOutputRepairAttempts: 1,
    },
  });
}

function sessionWith(obligation: ReviewObligation): SessionState {
  const withAttempt = appendObligationWithAttempt(undefined, obligation, NOW);
  return makeState('ARCHITECTURE', {
    architecture: {
      id: 'ADR-001',
      title: 'ADR',
      adrText: ADR_TEXT,
      digest: ADR_DIGEST,
      status: 'proposed',
      reviewCompletion: 'pending',
      createdAt: NOW,
    },
    reviewAssurance: withAttempt.assurance,
    policySnapshot: {
      ...makeState('ARCHITECTURE').policySnapshot,
      reviewInvocationPolicy: 'host_task_required',
    },
  });
}

function architectureOutput(obligation: ReviewObligation): string {
  return JSON.stringify({
    phase: 'ARCHITECTURE',
    status: 'ADR ADR-001 submitted',
    adrId: 'ADR-001',
    adrDigest: ADR_DIGEST,
    selfReviewIteration: 0,
    reviewMode: 'subagent',
    reviewAttemptId: `att-${obligation.obligationId}`,
    reviewObligationId: obligation.obligationId,
    reviewObligationIteration: 0,
    reviewObligationPlanVersion: 1,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    next: 'INDEPENDENT_REVIEW_REQUIRED: Policy requires a host-visible flowguard-reviewer invocation via the OpenCode Task tool. Context: iteration=0, planVersion=1.',
  });
}

function mockDeps() {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fp-integrity'),
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess-integrity'),
    updateReviewAssurance: vi.fn().mockResolvedValue(undefined),
    blockReviewOutcome: vi.fn().mockResolvedValue(undefined),
    getEnforcementState: vi
      .fn()
      .mockReturnValue({ sessionId: SESSION_ID, pendingReviews: new Map() }),
    log: { info: vi.fn(), warn: vi.fn() },
    client: {} as never,
    adapter: {} as never,
  };
}

describe('artifact-scoped initial host-task integrity', () => {
  it('BAD: material bound to a different artifact digest fails closed before dispatch (no reviewerTaskPrompt)', async () => {
    const obligation = architectureObligation('adr-digest-D1');
    const state = sessionWith(obligation);
    const output = { output: architectureOutput(obligation) };
    const reviewCtx = extractReviewContext('flowguard_architecture', JSON.parse(output.output))!;

    const handled = await handleHostTaskPolicy(
      mockDeps(),
      state,
      '/tmp/sess-integrity',
      reviewCtx,
      output,
      SESSION_ID,
    );

    expect(handled).toBe(true);
    expect(output.output).toContain('REVIEW_MATERIAL_INTEGRITY_FAILED');
    expect(output.output).not.toContain('reviewerTaskPrompt');
  });

  it('BAD: a scope tampered to another artifact digest fails closed before dispatch (no reviewerTaskPrompt)', async () => {
    const obligation = architectureObligation(ADR_DIGEST);
    const tampered: ReviewObligation = {
      ...obligation,
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          ...(
            obligation.reviewSubjectScope as Extract<
              ReviewObligation['reviewSubjectScope'],
              { kind: 'artifact' }
            >
          ).artifact,
          digest: 'adr-digest-D1',
        },
      },
    };
    const state = sessionWith(tampered);
    const output = { output: architectureOutput(tampered) };
    const reviewCtx = extractReviewContext('flowguard_architecture', JSON.parse(output.output))!;

    await handleHostTaskPolicy(
      mockDeps(),
      state,
      '/tmp/sess-integrity',
      reviewCtx,
      output,
      SESSION_ID,
    );

    expect(output.output).toContain('REVIEW_MATERIAL_INTEGRITY_FAILED');
    expect(output.output).not.toContain('reviewerTaskPrompt');
  });

  it('BAD: a scope kind tampered to repository_change fails closed before dispatch (no reviewerTaskPrompt)', async () => {
    // The required scope class follows the OBLIGATION TYPE, never the
    // persisted scope kind: swapping the scope class must not route the
    // obligation around the artifact verification.
    const obligation = architectureObligation(ADR_DIGEST);
    const tampered: ReviewObligation = {
      ...obligation,
      reviewSubjectScope: {
        kind: 'repository_change',
        paths: ['src/foo.ts'],
        revisions: ['base', 'head'],
      },
    };
    const state = sessionWith(tampered);
    const output = { output: architectureOutput(tampered) };
    const reviewCtx = extractReviewContext('flowguard_architecture', JSON.parse(output.output))!;

    await handleHostTaskPolicy(
      mockDeps(),
      state,
      '/tmp/sess-integrity',
      reviewCtx,
      output,
      SESSION_ID,
    );

    expect(output.output).toContain('REVIEW_MATERIAL_INTEGRITY_FAILED');
    expect(output.output).not.toContain('reviewerTaskPrompt');
  });

  it('HAPPY: a valid artifact obligation emits the exact host-enforced anchor contract', async () => {
    const obligation = architectureObligation(ADR_DIGEST);
    const state = sessionWith(obligation);
    const output = { output: architectureOutput(obligation) };
    const reviewCtx = extractReviewContext('flowguard_architecture', JSON.parse(output.output))!;

    await handleHostTaskPolicy(
      mockDeps(),
      state,
      '/tmp/sess-integrity',
      reviewCtx,
      output,
      SESSION_ID,
    );

    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    const prompt = parsed.reviewerTaskPrompt;
    expect(typeof prompt).toBe('string');
    const text = prompt as string;
    expect(text).toContain('subjectAnchors MUST use kind "artifact_section"');
    expect(text).toContain('artifactKind MUST be "adr"');
    expect(text).toContain(`artifactDigest MUST be "${ADR_DIGEST}"`);
    expect(text).toContain(
      JSON.stringify([
        [{ headingDepth: 2, siblingIndex: 1, headingText: 'Context' }],
        [{ headingDepth: 2, siblingIndex: 2, headingText: 'Decision' }],
        [{ headingDepth: 2, siblingIndex: 3, headingText: 'Consequences' }],
      ]),
    );
    expect(text).toContain('evidenceLocations only');
  });
});
