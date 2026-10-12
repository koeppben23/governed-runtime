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
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, writeStateAlreadyLocked } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import { applyEvidenceApprovalTransition, autoAdvance } from '../rails/types.js';
import { evaluate } from '../machine/evaluate.js';
import { TEAM_POLICY } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import { getPolicyPreset } from '../config/policy.js';
import { hashText } from '../shared/hashing.js';
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

  it('refuses a mutated approval decision after the admission was issued, without burning the admission', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);

    const tampered: SessionState = { ...application.state, reviewDecision: null };
    await expect(
      writeState(sessDir, tampered, undefined, application.admission),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });

    // The refused attempt did not consume the admission: the untampered commit
    // still succeeds with the same handle.
    await writeState(sessDir, application.state, undefined, application.admission);
    expect((await readState(sessDir))?.phase).toBe('EXPORT_READY');
  });

  it('refuses mutated review evidence after the admission was issued', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    expect(application.state.implReview).not.toBeNull();

    const tampered: SessionState = {
      ...application.state,
      implReview: { ...application.state.implReview!, iteration: 99 },
    };
    await expect(
      writeState(sessDir, tampered, undefined, application.admission),
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

  it('refuses review-evidence changes while already EXPORT_READY', async () => {
    const previous = authorizedEvidenceState();
    await writeState(sessDir, previous);
    const application = approveOrThrow(previous);
    await writeState(sessDir, application.state, undefined, application.admission);

    const persisted = (await readState(sessDir))!;
    expect(persisted.implReview).not.toBeNull();
    await expect(
      writeState(sessDir, {
        ...persisted,
        implReview: { ...persisted.implReview!, iteration: 99 },
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
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

  it('persists the autoAdvance approval only when its carried admission is passed', async () => {
    const previous: SessionState = {
      ...makeProgressedState('EVIDENCE_REVIEW'),
      policySnapshot: createPolicySnapshot(getPolicyPreset('solo'), FIXED_TIME, hashText),
      reviewDecision: null,
    };
    await writeState(sessDir, previous);
    const autoPolicy = { ...TEAM_POLICY, requireHumanGates: false };
    const advanced = autoAdvance(previous, (s) => evaluate(s, autoPolicy), {
      now: () => FIXED_TIME,
      digest: hashText,
      policy: autoPolicy,
    });
    expect(advanced.kind).toBe('advanced');
    if (advanced.kind !== 'advanced') return;
    expect(advanced.state.phase).toBe('EXPORT_READY');
    await expect(writeState(sessDir, advanced.state)).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
    // The carried admission is not consumed by the refused attempt: the very
    // same commit succeeds when it is passed through.
    await writeState(sessDir, advanced.state, undefined, advanced.approvalAdmission);
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

  it.skipIf(process.platform === 'win32')(
    'consumes the admission before durability: a failed write needs a fresh canonical approval',
    async () => {
      const previous = authorizedEvidenceState();
      await writeState(sessDir, previous);
      const application = approveOrThrow(previous);

      // Inject the fault under the already-held session lock: the guard reads
      // the predecessor and consumes the admission, then the durable write
      // fails on the read-only session directory.
      await withSessionWriteLock(sessDir, async () => {
        await chmod(sessDir, 0o500);
        try {
          await writeStateAlreadyLocked(sessDir, application.state, application.admission);
          throw new Error('expected the durable write to fail');
        } catch (error) {
          expect(String(error)).not.toContain('expected the durable write to fail');
        } finally {
          await chmod(sessDir, 0o700);
        }
      });

      // Nothing was committed and the burned admission cannot be replayed.
      expect((await readState(sessDir))?.phase).toBe('EVIDENCE_REVIEW');
      await expect(
        writeState(sessDir, application.state, undefined, application.admission),
      ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });

      // Recovery: a fresh canonical approval commits exactly one operation.
      const fresh = approveOrThrow(previous);
      await writeStateWithArtifactsAndAuditOperations(
        sessDir,
        fresh.state,
        undefined,
        [],
        fresh.admission,
      );
      const persisted = (await readState(sessDir))!;
      expect(persisted.phase).toBe('EXPORT_READY');
      expect(
        persisted.pendingAuditOperations.filter(
          (operation) =>
            operation.kind === 'transition' &&
            operation.transition.from === 'EVIDENCE_REVIEW' &&
            operation.transition.to === 'EXPORT_READY',
        ),
      ).toHaveLength(1);
    },
  );

  it('refuses bootstrapping a session directly into EXPORT_READY', async () => {
    await expect(writeState(sessDir, makeState('EXPORT_READY'))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
  });
});
