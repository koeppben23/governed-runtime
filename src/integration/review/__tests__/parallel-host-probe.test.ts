/**
 * @module integration/review/__tests__/parallel-host-probe.test
 * @description Strang 3 (#732) — lean checks for the parallel host-probe harness.
 *
 * HONESTY CONTRACT (see also parallel-host-probe-fake-client.ts):
 * Only ONE assertion here is non-tautological host-relevant evidence — the
 * bounded-concurrency bound, because that bound lives in FlowGuard harness code
 * and is independent of how the fake models the SDK. Every other test is an
 * explicitly-labelled SELF-CONSISTENCY check: it documents how the harness
 * interprets the documented SDK session semantics against our own fake. It is
 * NOT evidence of real OpenCode host behavior. Real GO/NO-GO for parallel
 * reviewer capability comes only from Strang 2 (live run, real instance).
 * Until then, real host parallelism/cancellation is NOT_VERIFIED.
 */

import { describe, it, expect } from 'vitest';

import { DeterministicFakeClient } from './parallel-host-probe-fake-client.js';
import {
  runParallelProbe,
  abortInFlight,
  type ProbeRequest,
  type ProbeReport,
} from './parallel-host-probe-harness.js';

function requests(n: number): ProbeRequest[] {
  return Array.from({ length: n }, (_, i) => ({ prompt: `review request ${i}` }));
}

/** A deterministic monotonic clock: each read advances by a fixed step. */
function fakeClock(stepMs = 1): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

/** Run a probe to completion, driving the fake to complete every prompt. */
async function runToCompletion(
  fake: DeterministicFakeClient,
  args: Omit<Parameters<typeof runParallelProbe>[0], 'client' | 'now'>,
): Promise<ProbeReport> {
  const client = fake.asClient();
  let done = false;
  const run = runParallelProbe({ client, now: fakeClock(), ...args }).finally(() => {
    done = true;
  });
  await fake.completeUntil(() => done);
  return run;
}

describe('parallel host-probe harness', () => {
  // ── The one genuine, non-tautological guarantee ─────────────────────────────
  describe('REAL GUARANTEE: bounded concurrency (FlowGuard-owned bound)', () => {
    it('never exceeds maxConcurrency in-flight regardless of completion timing', async () => {
      const fake = new DeterministicFakeClient();
      const client = fake.asClient();

      let done = false;
      const run = runParallelProbe({
        client,
        parentSessionId: 'parent-1',
        requests: requests(6),
        maxConcurrency: 2,
        now: fakeClock(),
      }).finally(() => {
        done = true;
      });

      // Drain one at a time, asserting the bound holds at every observation.
      let guard = 0;
      while (!done && guard < 200) {
        expect(fake.inFlightChildIds().length).toBeLessThanOrEqual(2);
        const inflight = fake.inFlightChildIds();
        if (inflight.length > 0) fake.complete(inflight[0]!);
        await Promise.resolve();
        guard += 1;
      }

      const report = await run;
      expect(report.peakObservedConcurrency).toBeLessThanOrEqual(2);
      expect(fake.observedPeakConcurrency).toBeLessThanOrEqual(2);
      expect(report.results).toHaveLength(6);
      expect(report.results.every((r) => r.outcome === 'completed')).toBe(true);
    });

    it('with maxConcurrency=1 runs strictly serially (peak of 1)', async () => {
      const fake = new DeterministicFakeClient();
      const report = await runToCompletion(fake, {
        parentSessionId: 'parent-1',
        requests: requests(3),
        maxConcurrency: 1,
      });
      expect(report.peakObservedConcurrency).toBe(1);
      expect(fake.observedPeakConcurrency).toBe(1);
    });

    it('rejects a non-positive concurrency bound (fail-closed)', async () => {
      const fake = new DeterministicFakeClient();
      await expect(
        runParallelProbe({
          client: fake.asClient(),
          parentSessionId: 'p',
          requests: requests(1),
          maxConcurrency: 0,
          now: fakeClock(),
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  // ── Self-consistency checks (NOT host evidence) ─────────────────────────────
  describe('SELF-CONSISTENCY (harness↔fake interpretation, NOT host proof)', () => {
    it('assigns a unique child session id per request', async () => {
      const fake = new DeterministicFakeClient();
      const report = await runToCompletion(fake, {
        parentSessionId: 'parent-1',
        requests: requests(4),
        maxConcurrency: 4,
      });
      const ids = report.results.map((r) => r.childSessionId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('records completion order as driven by the fake', async () => {
      const fake = new DeterministicFakeClient();
      const client = fake.asClient();
      let done = false;
      const run = runParallelProbe({
        client,
        parentSessionId: 'parent-1',
        requests: requests(3),
        maxConcurrency: 3,
        now: fakeClock(),
      }).finally(() => {
        done = true;
      });

      await fake.waitForInFlight(3);
      const inflight = fake.inFlightChildIds();
      const reverse = [...inflight].reverse();
      for (const id of reverse) {
        fake.complete(id);
        await Promise.resolve();
      }
      const report = await run;
      expect(done).toBe(true);
      expect(fake.observedCompletionOrder).toEqual(reverse);

      // completionSequence must reflect the real settle order (reverse of
      // dispatch here), not the request index. The children completed in
      // `reverse` order, so their sequences are 1,2,3 in that same order.
      const sequenceByChild = new Map(
        report.results.map((r) => [r.childSessionId, r.completionSequence]),
      );
      expect(reverse.map((id) => sequenceByChild.get(id))).toEqual([1, 2, 3]);
      const allSequences = report.results.map((r) => r.completionSequence).sort((a, b) => a - b);
      expect(allSequences).toEqual([1, 2, 3]);
    });

    it('reports a typed create failure without aborting the batch', async () => {
      const fake = new DeterministicFakeClient({ createErrorsOnOrder: new Set([2]) });
      const report = await runToCompletion(fake, {
        parentSessionId: 'parent-1',
        requests: requests(3),
        maxConcurrency: 3,
      });
      const failed = report.results.filter((r) => r.outcome === 'create_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.code).toBe('PROBE_CREATE_FAILED');
      expect(report.results.filter((r) => r.outcome === 'completed')).toHaveLength(2);
    });

    it('models in-flight abort as a typed aborted outcome when supported', async () => {
      const fake = new DeterministicFakeClient({ abortSupported: true });
      const client = fake.asClient();
      let done = false;
      const run = runParallelProbe({
        client,
        parentSessionId: 'parent-1',
        requests: requests(2),
        maxConcurrency: 2,
        now: fakeClock(),
      }).finally(() => {
        done = true;
      });

      await fake.waitForInFlight(2);
      const inflight = fake.inFlightChildIds();
      const abortResult = await abortInFlight(client, inflight);
      expect(abortResult.supported).toBe(true);
      expect(abortResult.attempted).toEqual(inflight);

      const report = await run;
      expect(done).toBe(true);
      expect(report.results.every((r) => r.outcome === 'aborted')).toBe(true);
      expect(fake.observedAbortCalls).toEqual(inflight);
    });

    it('reports abort as unsupported (fail-closed) when the host lacks it', async () => {
      const fake = new DeterministicFakeClient({ abortSupported: false });
      const client = fake.asClient();
      const result = await abortInFlight(client, ['child-1']);
      expect(result.supported).toBe(false);
      expect(result.attempted).toEqual([]);
    });

    it('populates parent/child correlation and non-negative timing', async () => {
      const fake = new DeterministicFakeClient();
      const report = await runToCompletion(fake, {
        parentSessionId: 'parent-xyz',
        requests: requests(2),
        maxConcurrency: 2,
      });
      for (const r of report.results) {
        expect(r.parentSessionId).toBe('parent-xyz');
        expect(r.childSessionId).toMatch(/^child-\d+$/);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
