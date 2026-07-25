/**
 * @module integration/review/__tests__/parallel-host-probe-harness
 * @description Reusable bounded-parallel reviewer-spawn measurement harness.
 *
 * NOT shipped: lives under __tests__/ which the production tsconfig build
 * excludes from dist/. This is the instrument that Strang 2 runs against a REAL
 * OpenCode client to produce host-capability evidence; here (Strang 3) it runs
 * against the deterministic fake for self-consistency checks only.
 *
 * Concurrency model (Weg B): a small, self-contained Promise pool. We do NOT
 * reuse McpExecutionLimiter — that is a synchronous *reject* limiter for MCP
 * tool throughput (different responsibility), whereas this harness needs a
 * *wait* pool that runs every requested probe under a bound. Reusing it would
 * be forced reuse of a semantically different primitive, not deduplication.
 */

import type { OrchestratorClient } from '../types.js';

export interface ProbeRequest {
  /** Prompt text for this reviewer child session. */
  readonly prompt: string;
}

export interface ProbeResult {
  readonly index: number;
  readonly parentSessionId: string;
  readonly childSessionId: string | null;
  readonly durationMs: number;
  readonly outcome: 'completed' | 'create_failed' | 'prompt_failed' | 'aborted';
  /** Structured code for the outcome (diagnostic only). */
  readonly code: string;
  /**
   * 1-based settle order across the whole batch: the Nth probe to reach a
   * terminal outcome (completed/failed/aborted) carries completionSequence N.
   * This is real completion-ordering evidence for the Gap 8 (#732) live run —
   * unlike request `index`, it reflects the order in which the host actually
   * finished child sessions, independent of dispatch order.
   */
  readonly completionSequence: number;
}

export interface ProbeRunOptions {
  readonly client: OrchestratorClient;
  readonly parentSessionId: string;
  readonly requests: readonly ProbeRequest[];
  /** Maximum number of child sessions in-flight at once (must be >= 1). */
  readonly maxConcurrency: number;
  /** Monotonic clock; injectable for deterministic timing in tests. */
  readonly now?: () => number;
}

export interface ProbeReport {
  readonly results: readonly ProbeResult[];
  readonly peakObservedConcurrency: number;
}

/**
 * Run all requests through a bounded Promise pool. Each unit creates a child
 * session, prompts it, and records correlation + timing. Failures are recorded
 * as typed outcomes (fail-closed); a single failure never aborts the batch.
 */
export async function runParallelProbe(options: ProbeRunOptions): Promise<ProbeReport> {
  const { client, parentSessionId, requests, maxConcurrency } = options;
  if (maxConcurrency < 1) {
    throw new RangeError('maxConcurrency must be >= 1');
  }
  const now = options.now ?? (() => performance.now());

  const results = new Array<ProbeResult>(requests.length);
  let nextIndex = 0;
  let inFlight = 0;
  let peak = 0;
  // Monotonic batch-wide settle counter: each terminal outcome claims the next
  // sequence number, capturing real host completion ordering.
  let settleCount = 0;
  const nextSequence = (): number => (settleCount += 1);

  async function runOne(index: number): Promise<void> {
    const startedAt = now();
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      const created = await client.session.create({
        body: { parentID: parentSessionId, title: 'FlowGuard Host Probe' },
      });
      if (created.error || !created.data?.id) {
        results[index] = {
          index,
          parentSessionId,
          childSessionId: null,
          durationMs: now() - startedAt,
          outcome: 'create_failed',
          code: 'PROBE_CREATE_FAILED',
          completionSequence: nextSequence(),
        };
        return;
      }
      const childSessionId = created.data.id;
      const prompted = await client.session.prompt({
        path: { id: childSessionId },
        body: { parts: [{ type: 'text', text: requests[index]!.prompt }] },
      });
      if (prompted.error || !prompted.data) {
        const aborted = prompted.error instanceof Error && prompted.error.message === 'aborted';
        results[index] = {
          index,
          parentSessionId,
          childSessionId,
          durationMs: now() - startedAt,
          outcome: aborted ? 'aborted' : 'prompt_failed',
          code: aborted ? 'PROBE_ABORTED' : 'PROBE_PROMPT_FAILED',
          completionSequence: nextSequence(),
        };
        return;
      }
      results[index] = {
        index,
        parentSessionId,
        childSessionId,
        durationMs: now() - startedAt,
        outcome: 'completed',
        code: 'PROBE_COMPLETED',
        completionSequence: nextSequence(),
      };
    } finally {
      inFlight -= 1;
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      if (index >= requests.length) return;
      nextIndex += 1;
      await runOne(index);
    }
  }

  const workerCount = Math.min(maxConcurrency, requests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { results, peakObservedConcurrency: peak };
}

/**
 * Abort every currently in-flight child session on the client, if the host
 * supports it. Returns the child ids for which an abort was attempted. Callers
 * treat a missing abort capability as a typed, fail-closed limitation.
 */
export async function abortInFlight(
  client: OrchestratorClient,
  childSessionIds: readonly string[],
): Promise<{ attempted: string[]; supported: boolean }> {
  if (!client.session.abort) {
    return { attempted: [], supported: false };
  }
  const attempted: string[] = [];
  for (const id of childSessionIds) {
    await client.session.abort({ path: { id } });
    attempted.push(id);
  }
  return { attempted, supported: true };
}
