import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD, TICKET } from '../../__fixtures__.js';
import { appendReviewObligation, createReviewObligation } from './assurance.js';
import { bindExternalReviewEvidence } from './transport-evidence.js';

function findingsFor(obligation: ReturnType<typeof createReviewObligation>) {
  return {
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    reviewMode: 'subagent' as const,
    overallVerdict: 'approve' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'claude-reviewer-session' },
    reviewedAt: '2026-01-01T00:00:01.000Z',
    attestation: {
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      toolObligationId: obligation.obligationId,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      reviewedBy: 'flowguard-reviewer' as const,
    },
  };
}

describe('external review transport evidence binding', () => {
  it('rejects file-exists-only invalid transport evidence', async () => {
    const sessDir = await mkdtemp(join(tmpdir(), 'fg-review-evidence-'));
    await mkdir(join(sessDir, 'review-evidence'));
    await writeFile(join(sessDir, 'review-evidence', 'bad.json'), '{"not":"findings"}', 'utf-8');
    const obligation = createReviewObligation({
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('PLAN', {
      ticket: TICKET,
      plan: PLAN_RECORD,
      reviewAssurance: appendReviewObligation(undefined, obligation),
    });

    const result = await bindExternalReviewEvidence(
      sessDir,
      state,
      'parent-session',
      '2026-01-01T00:00:02.000Z',
    );

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' ? result.code : '').toBe(
      'REVIEW_TRANSPORT_EVIDENCE_INVALID',
    );
  });

  it('binds valid attested transport evidence as manual_attested invocation', async () => {
    const sessDir = await mkdtemp(join(tmpdir(), 'fg-review-evidence-'));
    await mkdir(join(sessDir, 'review-evidence'));
    const obligation = createReviewObligation({
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(
      join(sessDir, 'review-evidence', 'ok.json'),
      JSON.stringify({ reviewFindings: findingsFor(obligation) }),
      'utf-8',
    );
    const state = makeState('PLAN', {
      ticket: TICKET,
      plan: PLAN_RECORD,
      reviewAssurance: appendReviewObligation(undefined, obligation),
    });

    const result = await bindExternalReviewEvidence(
      sessDir,
      state,
      'parent-session',
      '2026-01-01T00:00:02.000Z',
    );

    expect(result.status).toBe('bound');
    if (result.status !== 'bound') throw new Error('expected bound');
    expect(result.state.reviewAssurance?.invocations[0]?.invocationMode).toBe('manual_attested');
    expect(result.state.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
  });
});
