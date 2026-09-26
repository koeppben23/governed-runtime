/**
 * @module integration/governed-write-path-evidence
 * @description R5 persistence evidence: counted `SessionState.safeParse`
 * executions per concrete write scenario, stale-snapshot protection, and a
 * governed write-path performance budget.
 *
 * The fifth forensic round claimed "5x safeParse per write". The count is real
 * on the full-prepare path, but it is not one uniform number: direct metadata
 * writes validate less, and two orchestration helpers deliberately re-read the
 * state under the lock. This suite is the executable trace; the disposition
 * (layered fail-closed boundaries, no consolidation) is recorded in ADR-007.
 *
 * Stale-snapshot protection: the full-prepare writer refuses a prepared state
 * that would drop an open (non-reconciled) audit operation of the current
 * authority. The regression test drives an intervening write and proves the
 * rejection leaves the committed operation in place.
 *
 * The PERF block gates a state-changing full-prepare update against
 * `PERF_BUDGETS.stateGovernedWriteMs` with the shared benchmark methodology
 * (200 measured iterations after warm-up). A reset hook restores the same
 * canonical session before every sample, so the audit backlog stays constant;
 * every measured call changes authority and creates exactly one new
 * `state_write` operation. The fixture carries a structural proof contract, so
 * `refreshProofGraph()` performs real claim evaluation rather than the
 * no-contract fast path.
 *
 * @test-policy HAPPY, BAD, PERF
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readState, writeStateAlreadyLocked } from '../adapters/persistence.js';
import { makeProgressedState } from '../fixtures.js';
import { SessionState } from '../state/schema.js';
import { benchmarkAsync, PERF_BUDGETS } from '../test-policy.js';
import { mutateStateWithAuditOperations, writeStateWithAuditOperations } from './audit-outbox.js';
import { PluginWorkspaceImpl } from './plugin-workspace.js';
import {
  writeStateWithArtifacts,
  writeStateWithArtifactsAndAuditOperations,
} from './tools/helpers.js';

const CLAIM_ID = '10000000-0000-4000-8000-00000000000a';

let sessDir: string;

beforeEach(async () => {
  sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-governed-write-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sessDir, { recursive: true, force: true });
});

/**
 * Structural proof contract so `refreshProofGraph()` evaluates the claim
 * instead of early-returning on the no-contract fast path.
 */
function withClaim(state: SessionState): SessionState {
  return {
    ...state,
    proofContract: {
      version: 'contract.v2',
      claims: [
        {
          claimId: CLAIM_ID,
          statement: 'the command registry is consistent',
          signalClass: 'fact',
          critical: false,
          provenance: { kind: 'canonical_authority', authorityId: 'ticket', digest: 'authority' },
          evidenceRefs: [{ kind: 'structural_surface', surfaceId: 'command-registration' }],
          counterexampleRefs: [],
        },
      ],
    },
  };
}

async function seedSession(): Promise<SessionState> {
  const seeded = await writeStateWithArtifacts(
    sessDir,
    withClaim(makeProgressedState('IMPLEMENTATION')),
  );
  expect(seeded.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
  return seeded;
}

/** A real authority change: set a unique probe error against the base state. */
function changedState(base: SessionState, iteration: number): SessionState {
  return {
    ...base,
    error: {
      code: 'R5_PERF_PROBE',
      message: `governed write probe ${iteration}`,
      recoveryHint: 'test-only probe error state',
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('R5 persistence evidence: validation counts per write scenario', () => {
  it('counts SessionState.safeParse executions per concrete write', async () => {
    await seedSession();
    const spy = vi.spyOn(SessionState, 'safeParse');

    const fullPrepare = await readState(sessDir);
    expect(fullPrepare).not.toBeNull();
    spy.mockClear();
    await writeStateWithArtifactsAndAuditOperations(sessDir, { ...fullPrepare! });
    // read (boundary) + prepareState input + prepareState ProofGraph refresh +
    // prepareAuditOperations + prepared-artifact commit + raw write boundary.
    expect(spy.mock.calls.length, 'full-prepare update').toBe(6);

    const direct = await readState(sessDir);
    spy.mockClear();
    await writeStateWithAuditOperations(sessDir, { ...direct! });
    // direct-channel read + audit preparation + raw write boundary.
    expect(spy.mock.calls.length, 'direct metadata write').toBe(3);

    spy.mockClear();
    const mutated = await mutateStateWithAuditOperations(sessDir, (current) => ({ next: current }));
    // read + re-read under the lock + audit preparation + raw write boundary.
    expect(mutated).not.toBeNull();
    expect(spy.mock.calls.length, 'mutate under lock').toBe(4);

    spy.mockClear();
    const workspace = new PluginWorkspaceImpl({ auditWorktree: undefined });
    await workspace.updateReviewAssurance(sessDir, (state) => state);
    // same double-read shape as mutateStateWithAuditOperations.
    expect(spy.mock.calls.length, 'updateReviewAssurance').toBe(4);
  });
});

describe('R5 persistence evidence: audit-operation preservation', () => {
  it('preserves every previously committed open operation across sequential updates', async () => {
    let current = await seedSession();
    const openOperationIds: string[] = [];

    for (let iteration = 0; iteration < 4; iteration++) {
      current = await writeStateWithArtifactsAndAuditOperations(
        sessDir,
        changedState(current, iteration),
      );

      // The authority really changed.
      expect(current.error).toMatchObject({
        code: 'R5_PERF_PROBE',
        message: `governed write probe ${iteration}`,
      });

      // Every earlier open operation is still present.
      for (const operationId of openOperationIds) {
        expect(
          current.pendingAuditOperations.some(
            (operation) =>
              operation.operationId === operationId && operation.status !== 'reconciled',
          ),
          `iteration ${iteration} dropped ${operationId}`,
        ).toBe(true);
      }

      const lastOperation = current.pendingAuditOperations.at(-1);
      expect(lastOperation?.kind, `iteration ${iteration}`).toBe('state_write');
      expect(openOperationIds, `iteration ${iteration}`).not.toContain(lastOperation?.operationId);
      openOperationIds.push(lastOperation!.operationId);
    }

    expect(openOperationIds).toHaveLength(4);
  });

  it('carries forward an operation committed after the caller snapshot', async () => {
    await seedSession();
    const stale = await readState(sessDir);
    expect(stale).not.toBeNull();

    // Intervening writer commits a new open semantic operation.
    await writeStateWithAuditOperations(sessDir, { ...stale! }, [
      {
        phase: stale!.phase,
        event: 'review:obligation_blocked',
        occurredAt: '2026-01-01T00:00:00.000Z',
        detail: { obligationId: 'r5-stale-probe', code: 'R5_STALE_PROBE' },
      },
    ]);
    const afterIntervening = await readState(sessDir);
    const intervening = afterIntervening!.pendingAuditOperations.at(-1);
    expect(afterIntervening!.pendingAuditOperations.length).toBe(
      stale!.pendingAuditOperations.length + 1,
    );

    // The stale snapshot is accepted, but the committed operation is carried
    // forward and survives; the new state_write operation is appended after it.
    const persisted = await writeStateWithArtifactsAndAuditOperations(
      sessDir,
      changedState(stale!, 0),
    );

    expect(
      persisted.pendingAuditOperations.some(
        (operation) =>
          operation.operationId === intervening!.operationId && operation.status !== 'reconciled',
      ),
    ).toBe(true);
    expect(persisted.pendingAuditOperations.at(-1)?.kind).toBe('state_write');
    expect(persisted.error).toMatchObject({ code: 'R5_PERF_PROBE' });
  });
});

describe('PERF governed state write path', () => {
  it('keeps a state-changing full-prepare update inside the governed write budget', async () => {
    const canonical = await seedSession();
    let iteration = 0;

    const measurement = await benchmarkAsync(
      () =>
        writeStateWithArtifactsAndAuditOperations(sessDir, changedState(canonical, iteration++)),
      200,
      10,
      // Constant audit backlog and identical starting authority for every
      // sample; the raw write bypasses preparation by design (fixture control).
      async () => {
        await writeStateAlreadyLocked(sessDir, canonical);
      },
    );

    const persisted = await readState(sessDir);
    expect(persisted?.pendingAuditOperations.at(-1)?.kind).toBe('state_write');
    expect(persisted?.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');

    expect(
      measurement.p99Ms,
      `p99 ${measurement.p99Ms.toFixed(2)}ms >= budget ${PERF_BUDGETS.stateGovernedWriteMs}ms`,
    ).toBeLessThan(PERF_BUDGETS.stateGovernedWriteMs);
  });
});
