/**
 * @module integration/governed-write-path-evidence
 * @description R5 persistence evidence: counted `SessionState.safeParse`
 * executions per concrete write scenario and a governed write-path performance
 * budget.
 *
 * The fifth forensic round claimed "5x safeParse per write". The count is real
 * on the full-prepare path, but it is not one uniform number: direct metadata
 * writes validate less, and two orchestration helpers deliberately re-read the
 * state under the lock. This suite is the executable trace; the disposition
 * (layered fail-closed boundaries, no consolidation) is recorded in ADR-007.
 *
 * The PERF block gates a state-changing full-prepare update against
 * `PERF_BUDGETS.stateGovernedWriteMs` with the shared benchmark methodology
 * (>=100 measured iterations after warm-up). Every iteration toggles the
 * persisted `error` authority and therefore creates one new `state_write`
 * audit operation; a separate test proves that state change and the operation
 * creation explicitly.
 *
 * @test-policy HAPPY, PERF
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProgressedState } from '../fixtures.js';
import { readState } from '../adapters/persistence.js';
import { SessionState } from '../state/schema.js';
import { benchmarkAsync, PERF_BUDGETS } from '../test-policy.js';
import { mutateStateWithAuditOperations, writeStateWithAuditOperations } from './audit-outbox.js';
import { PluginWorkspaceImpl } from './plugin-workspace.js';
import {
  writeStateWithArtifacts,
  writeStateWithArtifactsAndAuditOperations,
} from './tools/helpers.js';

let sessDir: string;

beforeEach(async () => {
  sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-governed-write-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sessDir, { recursive: true, force: true });
});

async function seedSession() {
  return writeStateWithArtifacts(sessDir, makeProgressedState('IMPLEMENTATION'));
}

/**
 * A comparable authority change for every iteration: toggle the persisted
 * `error` field, so each full-prepare write changes state authority and must
 * create one new `state_write` audit operation (never a no-op projection).
 */
function toggledState(seeded: SessionState, iteration: number): SessionState {
  return iteration % 2 === 0
    ? {
        ...seeded,
        error: {
          code: 'R5_PERF_PROBE',
          message: 'governed write evidence probe',
          recoveryHint: 'test-only probe error state',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      }
    : { ...seeded, error: null };
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

  it('changes authority and creates one state_write operation per iteration', async () => {
    const seeded = await seedSession();
    const operationIds = new Set<string>();

    for (let iteration = 0; iteration < 4; iteration++) {
      await writeStateWithArtifactsAndAuditOperations(sessDir, toggledState(seeded, iteration));

      const persisted = await readState(sessDir);
      expect(persisted).not.toBeNull();
      const lastOperation = persisted!.pendingAuditOperations.at(-1);
      expect(lastOperation?.kind, `iteration ${iteration}`).toBe('state_write');
      expect(operationIds.has(lastOperation!.operationId), `iteration ${iteration}`).toBe(false);
      operationIds.add(lastOperation!.operationId);
      expect(persisted!.error === null, `iteration ${iteration}`).toBe(iteration % 2 !== 0);
    }
  });
});

describe('PERF governed state write path', () => {
  it('keeps a state-changing full-prepare update inside the governed write budget', async () => {
    const seeded = await seedSession();
    let iteration = 0;

    const measurement = await benchmarkAsync(
      () => writeStateWithArtifactsAndAuditOperations(sessDir, toggledState(seeded, iteration++)),
      200,
      10,
    );

    const persisted = await readState(sessDir);
    expect(persisted?.pendingAuditOperations.at(-1)?.kind).toBe('state_write');

    expect(
      measurement.p99Ms,
      `p99 ${measurement.p99Ms.toFixed(2)}ms >= budget ${PERF_BUDGETS.stateGovernedWriteMs}ms`,
    ).toBeLessThan(PERF_BUDGETS.stateGovernedWriteMs);
  });
});
