/**
 * @module integration/review/__tests__/parallel-host-probe-fake-client
 * @description Deterministic fake OpenCode client for the parallel host-probe
 * harness. NOT shipped: this lives under __tests__/ which the production
 * tsconfig build excludes, so it never reaches dist/ (the only packaged output).
 *
 * IMPORTANT (honesty contract): this fake encodes *our interpretation* of the
 * documented OpenCode SDK session semantics. Tests that run the harness against
 * this fake are self-consistency checks and an executable specification of that
 * interpretation — they are NOT evidence of real host behavior. Real GO/NO-GO
 * for parallel reviewer capability comes only from a live run against a real
 * OpenCode instance (Strang 2).
 */

import type { OrchestratorClient } from '../types.js';

/** A pending prompt whose completion the test drives explicitly. */
interface PendingPrompt {
  readonly childSessionId: string;
  resolve(): void;
  reject(reason: unknown): void;
  settled: boolean;
  aborted: boolean;
}

export interface FakeClientOptions {
  /**
   * Per-child structured findings to return on prompt completion. Keyed by the
   * 1-based creation order. Defaults to a minimal accept verdict.
   */
  readonly findingsByOrder?: Record<number, Record<string, unknown>>;
  /** Child creation orders (1-based) that should fail session.create. */
  readonly createErrorsOnOrder?: ReadonlySet<number>;
  /** Whether session.abort is available (simulates hosts without cancellation). */
  readonly abortSupported?: boolean;
}

function defaultFindings(childSessionId: string): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: childSessionId },
    reviewedAt: '2026-05-07T12:00:00.000Z',
  };
}

/**
 * A deterministic fake client plus a controller that lets a test drive
 * completion order, observe peak concurrency, and inspect abort calls without
 * any real timers or network.
 */
export class DeterministicFakeClient {
  private createCount = 0;
  private activePrompts = 0;
  private peakConcurrency = 0;
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly completionOrder: string[] = [];
  private readonly abortCalls: string[] = [];

  constructor(private readonly options: FakeClientOptions = {}) {}

  /** Highest number of prompts that were in-flight simultaneously. */
  get observedPeakConcurrency(): number {
    return this.peakConcurrency;
  }

  /** Child session ids in the order their prompts resolved. */
  get observedCompletionOrder(): readonly string[] {
    return this.completionOrder;
  }

  /** Child session ids for which session.abort was invoked. */
  get observedAbortCalls(): readonly string[] {
    return this.abortCalls;
  }

  /** Child session ids with an in-flight (unsettled) prompt. */
  inFlightChildIds(): string[] {
    return [...this.pending.values()].filter((p) => !p.settled).map((p) => p.childSessionId);
  }

  /**
   * Resolve once at least `count` prompts are simultaneously in-flight, or
   * throw after a bounded number of microtask turns. Lets tests synchronize on
   * pool saturation without real timers or fragile manual microtask flushing.
   */
  async waitForInFlight(count: number, maxTurns = 1000): Promise<void> {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.inFlightChildIds().length >= count) return;
      await Promise.resolve();
    }
    throw new Error(
      `waitForInFlight(${count}) not reached; observed ${this.inFlightChildIds().length}`,
    );
  }

  /**
   * Continuously complete in-flight prompts until `isDone()` returns true.
   * Used by tests to drive a run to completion without real timers: pass a flag
   * that the run's `.then()` sets. Bounded to avoid infinite loops on a bug.
   */
  async completeUntil(isDone: () => boolean, maxRounds = 5000): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      if (isDone()) return;
      for (const id of this.inFlightChildIds()) this.complete(id);
      await Promise.resolve();
    }
    throw new Error('completeUntil did not converge');
  }

  /** Resolve a specific in-flight prompt (drives completion ordering). */
  complete(childSessionId: string): void {
    this.pending.get(childSessionId)?.resolve();
  }

  /** Fail a specific in-flight prompt. */
  fail(childSessionId: string, reason: unknown = new Error('prompt failed')): void {
    this.pending.get(childSessionId)?.reject(reason);
  }

  asClient(): OrchestratorClient {
    const client: OrchestratorClient = {
      app: {
        agents: async () => ({
          data: [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }],
        }),
      },
      session: {
        create: async () => {
          this.createCount += 1;
          const order = this.createCount;
          if (this.options.createErrorsOnOrder?.has(order)) {
            return { data: undefined, error: { message: `create failed (order ${order})` } };
          }
          return { data: { id: `child-${order}` }, error: undefined };
        },
        prompt: (opts) => {
          const childSessionId = opts.path.id;
          const order = Number(childSessionId.replace('child-', ''));
          this.activePrompts += 1;
          this.peakConcurrency = Math.max(this.peakConcurrency, this.activePrompts);

          return new Promise((resolvePromise) => {
            const entry: PendingPrompt = {
              childSessionId,
              settled: false,
              aborted: false,
              resolve: () => {
                if (entry.settled) return;
                entry.settled = true;
                this.activePrompts -= 1;
                this.completionOrder.push(childSessionId);
                const findings =
                  this.options.findingsByOrder?.[order] ?? defaultFindings(childSessionId);
                resolvePromise({
                  data: {
                    parts: [{ type: 'text', text: JSON.stringify(findings) }],
                    info: { structured_output: findings },
                  },
                  error: undefined,
                });
              },
              reject: (reason) => {
                if (entry.settled) return;
                entry.settled = true;
                this.activePrompts -= 1;
                this.completionOrder.push(childSessionId);
                resolvePromise({ data: undefined, error: reason });
              },
            };
            this.pending.set(childSessionId, entry);
          });
        },
      },
    };

    if (this.options.abortSupported !== false) {
      client.session.abort = async (opts) => {
        const childSessionId = opts.path.id;
        this.abortCalls.push(childSessionId);
        const entry = this.pending.get(childSessionId);
        if (entry && !entry.settled) {
          entry.aborted = true;
          entry.reject(new Error('aborted'));
        }
        return { data: true, error: undefined };
      };
    }

    return client;
  }
}
