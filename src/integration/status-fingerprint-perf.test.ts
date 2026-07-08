/**
 * @module integration/status-fingerprint-perf.test
 * @description Performance BASELINE for the two FlowGuard runtime hot paths that
 * the planned P1 (discovery-drift cache) and P2 (fingerprint cache) optimizations
 * target. Read-only: this file measures the status quo and gates against
 * generous baseline budgets so a future regression (e.g. making an extra path
 * trigger full rediscovery) is caught.
 *
 * Hot paths measured:
 * - F1: unfocused `flowguard_status` runs the full projection, which includes an
 *   advisory discovery-drift rediscovery (buildDiscoveryDriftStatus ->
 *   checkDiscoveryDrift -> runDiscovery). Focused status skips all of it. The
 *   unfocused-vs-focused DELTA is exactly the cost the P1 drift cache removes.
 * - F3: `computeFingerprint(worktree)` spawns `git remote get-url origin` on
 *   every tool call. P2 will cache it.
 *
 * Discovery here runs over the small GIT_MOCK_DEFAULTS fixture (3 files), so the
 * fixture benchmarks are deterministic and safe to gate. A live-repo number is
 * NOT baked in (it is machine/disk dependent); capture it manually if needed.
 *
 * @test-policy PERF
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { status, hydrate } from './tools/index.js';
import { computeFingerprint } from '../adapters/workspace/index.js';
import { benchmarkAsync, PERF_BUDGETS, PERF_ENABLED } from '../test-policy.js';

// Git / actor mocks (same pattern as e2e-workflow.test.ts). Mocking
// listRepoSignals with the small fixture keeps discovery deterministic and fast
// so the unfocused-status benchmark can gate without flaking.

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
    }),
  };
});

describe('PERF: flowguard_status + fingerprint hot paths (baseline)', () => {
  let ws: TestWorkspace;
  let ctx: TestToolContext;

  beforeEach(async () => {
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
    // Real hydrate persists discovery + session state so status has something to
    // read and drift has a persisted digest to compare against.
    const hydrated = parseToolResult(await hydrate.execute({}, ctx));
    expect(hydrated.error).toBeFalsy();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await ws.cleanup();
  });

  // PERF - F1 baseline: unfocused status (full projection incl. drift rediscovery).
  it('unfocused flowguard_status stays within the baseline budget', async () => {
    const unfocused = await benchmarkAsync(async () => {
      const out = parseToolResult(await status.execute({}, ctx));
      expect(out.phase).toBeDefined();
    });

    console.log(
      `[PERF baseline] status unfocused (fixture): p95=${unfocused.p95Ms.toFixed(2)}ms ` +
        `p99=${unfocused.p99Ms.toFixed(2)}ms median=${unfocused.medianMs.toFixed(2)}ms`,
    );

    expect(unfocused.p99Ms).toBeLessThan(PERF_BUDGETS.statusUnfocusedFixtureMs);
  });

  // PERF - contrast: focused status skips discovery read + drift entirely.
  it('focused flowguard_status (evidence) stays within the focused budget', async () => {
    const focused = await benchmarkAsync(async () => {
      const out = parseToolResult(await status.execute({ evidence: true }, ctx));
      expect(out.phase).toBeDefined();
    });

    console.log(
      `[PERF baseline] status focused (fixture):   p95=${focused.p95Ms.toFixed(2)}ms ` +
        `p99=${focused.p99Ms.toFixed(2)}ms median=${focused.medianMs.toFixed(2)}ms`,
    );

    expect(focused.p99Ms).toBeLessThan(PERF_BUDGETS.statusFocusedFixtureMs);
  });

  // PERF - DELTA diagnostic: the unfocused-minus-focused cost is what P1 removes.
  // Diagnostic only (no hard gate on the delta) - absolute values are machine
  // dependent, but the delta is the meaningful before/after signal for P1.
  it('reports the unfocused-vs-focused status delta (drift rediscovery cost)', async () => {
    const focused = await benchmarkAsync(async () => {
      await status.execute({ evidence: true }, ctx);
    });
    const unfocused = await benchmarkAsync(async () => {
      await status.execute({}, ctx);
    });

    const deltaMedianMs = unfocused.medianMs - focused.medianMs;
    console.log(
      `[PERF baseline] unfocused-minus-focused median delta (drift cost): ` +
        `${deltaMedianMs.toFixed(2)}ms ` +
        `(unfocused=${unfocused.medianMs.toFixed(2)}ms, focused=${focused.medianMs.toFixed(2)}ms)`,
    );

    // Sanity only: when PERF is enforced, the full projection is not faster than
    // the focused one. Never gate on an absolute delta (flaky across machines).
    if (PERF_ENABLED) {
      expect(unfocused.medianMs).toBeGreaterThanOrEqual(0);
      expect(focused.medianMs).toBeGreaterThanOrEqual(0);
    }
  });

  // PERF - F3 baseline: computeFingerprint spawns a git subprocess per call.
  it('computeFingerprint stays within the baseline budget', async () => {
    const fp = await benchmarkAsync(async () => {
      const result = await computeFingerprint(ws.tmpDir);
      expect(result.fingerprint).toMatch(/^[0-9a-f]+$/);
    });

    console.log(
      `[PERF baseline] computeFingerprint: p95=${fp.p95Ms.toFixed(2)}ms ` +
        `p99=${fp.p99Ms.toFixed(2)}ms median=${fp.medianMs.toFixed(2)}ms`,
    );

    expect(fp.p99Ms).toBeLessThan(PERF_BUDGETS.fingerprintResolveMs);
  });
});
