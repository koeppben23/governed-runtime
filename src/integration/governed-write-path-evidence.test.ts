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
 * The PERF block gates the full-prepare update against
 * `PERF_BUDGETS.stateGovernedWriteMs` with the shared benchmark methodology
 * (>=100 measured iterations after warm-up; the initial state is rebuilt for
 * every iteration so the pending-operation shape stays constant).
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

describe('PERF governed state write path', () => {
  it('keeps the full-prepare update inside the governed write budget', async () => {
    const seeded = await seedSession();

    const measurement = await benchmarkAsync(
      () => writeStateWithArtifactsAndAuditOperations(sessDir, { ...seeded }),
      200,
      10,
    );

    expect(
      measurement.p99Ms,
      `p99 ${measurement.p99Ms.toFixed(2)}ms >= budget ${PERF_BUDGETS.stateGovernedWriteMs}ms`,
    ).toBeLessThan(PERF_BUDGETS.stateGovernedWriteMs);
  });
});
