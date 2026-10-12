/**
 * @module integration/evidence-approval-persistence.test
 * @description The lowest persistence boundary: a newly entered EXPORT_READY
 * requires an authentic, single-use approval admission issued by the canonical
 * protected application for EXACTLY the written evidence basis. Evidence
 * sufficiency alone is never an authorization, and approval-relevant evidence
 * is immutable once approved.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import { applyEvidenceApprovalTransition } from '../rails/types.js';
import { FIXED_TIME, makeProgressedState, makeState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';

const CLAIM_ID = '00000000-0000-4000-8000-0000000000e1';

function criticalDeclarations(): PlanClaimDeclarations {
  return {
    flow: 'plan',
    version: 'v2',
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'the change preserves the intended behavior',
        critical: true,
        authoritySectionId: 's1',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
      },
    ],
  };
}

function enteringExportReady(state: SessionState): SessionState {
  return {
    ...state,
    phase: 'EXPORT_READY',
    transition: { from: 'EVIDENCE_REVIEW', to: 'EXPORT_READY', event: 'APPROVE', at: FIXED_TIME },
  };
}

/** Authorized human-gated evidence position: recorded approving decision. */
function authorizedEvidenceState(): SessionState {
  return makeProgressedState('EVIDENCE_REVIEW');
}

function approveOrThrow(state: SessionState) {
  const application = applyEvidenceApprovalTransition(state, FIXED_TIME);
  if (application.kind !== 'applied') {
    throw new Error(`expected an applied approval, got ${application.block.code}`);
  }
  return application;
}

describe('EXPORT_READY evidence-approval persistence boundary', () => {
  let sessDir: string;
  beforeEach(async () => {
    sessDir = await mkdtemp(join(tmpdir(), 'flowguard-approval-boundary-'));
  });
  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true });
  });

  it('refuses a directly written EXPORT_READY even when the evidence is sufficient', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    await expect(writeState(sessDir, enteringExportReady(previous))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
    expect((await readState(sessDir))?.phase).toBe('EVIDENCE_REVIEW');
  });

  it('refuses a human-gated approval without a recorded approving decision', async () => {
    const previous: SessionState = {
      ...makeProgressedState('EVIDENCE_REVIEW'),
      reviewDecision: null,
    };
    await writeState(sessDir, previous);
    const application = applyEvidenceApprovalTransition(previous, FIXED_TIME);
    expect(application.kind).toBe('blocked');
    if (application.kind === 'blocked') {
      expect(application.block.code).toBe('HUMAN_DECISION_REQUIRED');
    }
    await expect(writeState(sessDir, enteringExportReady(previous))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
  });

  it('persists only through the protected application and consumes the admission once', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    await writeState(sessDir, application.state, undefined, application.admission);
    expect((await readState(sessDir))?.phase).toBe('EXPORT_READY');

    // Replay against a fresh predecessor is refused: the admission was consumed.
    const replayDir = await mkdtemp(join(tmpdir(), 'flowguard-approval-replay-'));
    try {
      await writeState(replayDir, previous);
      await expect(
        writeState(replayDir, application.state, undefined, application.admission),
      ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
    } finally {
      await rm(replayDir, { recursive: true, force: true });
    }
  });

  it('refuses an approved entry whose predecessor is not EVIDENCE_REVIEW, admission or not', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    // The predecessor is replaced with a non-evidence phase before the commit.
    await writeState(sessDir, { ...previous, phase: 'IMPLEMENTATION' });
    await expect(
      writeState(sessDir, application.state, undefined, application.admission),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
  });

  it('refuses approval-relevant evidence changes while already EXPORT_READY', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    await writeState(sessDir, application.state, undefined, application.admission);

    const persisted = (await readState(sessDir))!;
    const changedEvidence: SessionState = {
      ...persisted,
      implementationRiskAssessment: {
        ...persisted.implementationRiskAssessment!,
        riskTriggers: ['state_integrity'],
      },
      plan: { ...persisted.plan!, claimDeclarations: criticalDeclarations() },
    };
    await expect(writeState(sessDir, changedEvidence)).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
  });

  it('still allows same-phase audit/metadata updates while already EXPORT_READY', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    await writeState(sessDir, application.state, undefined, application.admission);
    const persisted = (await readState(sessDir))!;
    await writeState(sessDir, {
      ...persisted,
      reviewCycles: { ...persisted.reviewCycles, plan: persisted.reviewCycles.plan + 1 },
    });
    expect((await readState(sessDir))?.phase).toBe('EXPORT_READY');
  });

  it('refuses the unapproved entry through the artifact/audit commit path', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    await expect(
      writeStateWithArtifactsAndAuditOperations(sessDir, enteringExportReady(previous)),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
    expect((await readState(sessDir))?.phase).toBe('EVIDENCE_REVIEW');
  });

  it('refuses bootstrapping a session directly into EXPORT_READY', async () => {
    await expect(writeState(sessDir, makeState('EXPORT_READY'))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
  });
});
