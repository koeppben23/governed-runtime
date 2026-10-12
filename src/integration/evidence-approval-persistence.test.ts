/**
 * @module integration/evidence-approval-persistence.test
 * @description The lowest persistence boundary: a newly entered EXPORT_READY
 * must clear the canonical evidence preflight on exactly the state being
 * written, through EVERY writer (`writeState`, the artifact/audit commit
 * path), not only the prepared full-prepare path.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
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

describe('EXPORT_READY evidence-approval persistence boundary', () => {
  let sessDir: string;
  beforeEach(async () => {
    sessDir = await mkdtemp(join(tmpdir(), 'flowguard-approval-boundary-'));
  });
  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true });
  });

  it('persists a claimless, trigger-less approval that clears the preflight', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    await writeState(sessDir, previous);
    await writeState(sessDir, enteringExportReady({ ...previous, plan: null }));
    expect((await readState(sessDir))?.phase).toBe('EXPORT_READY');
  });

  it('refuses a newly entered EXPORT_READY whose evidence does not clear the preflight', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    await writeState(sessDir, previous);
    const withClaims: SessionState = {
      ...previous,
      plan: { ...previous.plan!, claimDeclarations: criticalDeclarations() },
    };
    await expect(writeState(sessDir, enteringExportReady(withClaims))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
    expect((await readState(sessDir))?.phase).toBe('EVIDENCE_REVIEW');
  });

  it('refuses the same unapproved entry through the artifact/audit commit path', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    await writeState(sessDir, previous);
    const withClaims: SessionState = {
      ...previous,
      plan: { ...previous.plan!, claimDeclarations: criticalDeclarations() },
    };
    await expect(
      writeStateWithArtifactsAndAuditOperations(sessDir, enteringExportReady(withClaims)),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
    expect((await readState(sessDir))?.phase).toBe('EVIDENCE_REVIEW');
  });

  it('refuses bootstrapping a session directly into EXPORT_READY', async () => {
    await expect(writeState(sessDir, makeState('EXPORT_READY'))).rejects.toMatchObject({
      code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    });
  });

  it('does not treat same-phase metadata updates in EXPORT_READY as a new approval', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    await writeState(sessDir, previous);
    await writeState(sessDir, enteringExportReady({ ...previous, plan: null }));
    const persisted = (await readState(sessDir))!;
    await writeState(sessDir, {
      ...persisted,
      reviewCycles: { ...persisted.reviewCycles, plan: persisted.reviewCycles.plan + 1 },
    });
    expect((await readState(sessDir))?.phase).toBe('EXPORT_READY');
  });
});
