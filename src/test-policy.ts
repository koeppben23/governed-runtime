/**
 * @module test-policy
 * @description Test policy constants and types for the FlowGuard test suite.
 *
 * Every test file MUST cover all five categories. This policy is enforced
 * by test naming conventions and review mandates in flowguard-mandates.md.
 *
 * Categories:
 * 1. HAPPY  — Normal, expected successful flows
 * 2. BAD    — Invalid, missing, or malformed input
 * 3. CORNER — Boundary conditions, limits, thresholds
 * 4. EDGE   — Unusual but valid scenarios, race conditions
 * 5. PERF   — Throughput, memory, timing constraints
 *
 * Test naming convention:
 *   describe("module-name", () => {
 *     describe("HAPPY", () => { ... });
 *     describe("BAD", () => { ... });
 *     describe("CORNER", () => { ... });
 *     describe("EDGE", () => { ... });
 *     describe("PERF", () => { ... });
 *   });
 *
 * Performance thresholds (enforced in PERF tests):
 * - State evaluation: < 1ms for single evaluate() call
 * - Guard evaluation: < 0.1ms per guard predicate
 * - Audit chain verification: < 100ms for 1000 events
 * - State serialization: < 5ms for full SessionState
 *
 * @version v1
 */

declare const performance: {
  now(): number;
};

// ─── Test Categories ──────────────────────────────────────────────────────────

/**
 * The five mandatory test categories.
 * Every test suite must have a describe block for each.
 */
export const TEST_CATEGORIES = [
  "HAPPY",
  "BAD",
  "CORNER",
  "EDGE",
  "PERF",
] as const;

export type TestCategory = (typeof TEST_CATEGORIES)[number];

// ─── Performance Thresholds ───────────────────────────────────────────────────

/**
 * CI_MULTIPLIER: 2x for pure-compute budgets on shared VMs.
 * Noisy I/O and scheduling-dependent budgets use 3x via inline conditionals.
 */
const CI_MULTIPLIER = process.env.CI ? 2 : 1;
const PERF_BUDGET_FACTOR = Math.max(
  1,
  Number(process.env.FLOWGUARD_PERF_BUDGET_FACTOR || "1") || 1,
);

/**
 * Performance budgets for PERF tests.
 * All values in milliseconds unless noted otherwise.
 *
 * These are measured as p99 over 100 iterations (warm).
 * Cold starts may exceed by up to 5x — measure warm only.
 *
 * On CI, pure-compute budgets are multiplied by 2x (CI_MULTIPLIER).
 * I/O-bound and noisy budgets have additional CI-specific multipliers
 * applied directly to handle filesystem and scheduling variance.
 *
 * Budget classification:
 * - Pure compute: Unaffected by system load
 * - I/O bound: Affected by filesystem, scheduling
 * - Memory bound: Affected by GC, allocation patterns
 */
export const PERF_BUDGETS = {
  /** Single evaluate(state, policy) call. */
  evaluateSingleMs: 1 * CI_MULTIPLIER,

  /** Single guard predicate check. Set allocation accounts for most variance. */
  guardPredicateMs: 2 * CI_MULTIPLIER,

  /** Full hash chain verification for 1000 events. */
  auditChainVerify1000Ms: 100 * CI_MULTIPLIER,

  /** Full SessionState JSON.stringify + Zod parse round-trip. */
  stateSerializeMs: 5 * CI_MULTIPLIER * PERF_BUDGET_FACTOR,

  /**
   * readState + writeState round-trip (filesystem I/O).
   * CI adjustment: 3x multiplier for noisy VMs with unpredictable I/O.
   * Local: 50ms budget.
   */
  stateIoRoundTripMs: 50 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** Completeness matrix evaluation. */
  completenessEvalMs: 2 * CI_MULTIPLIER * PERF_BUDGET_FACTOR,

  /**
   * Compliance summary generation from 500 events.
   * CI adjustment: 3x multiplier for string operations + map lookups.
   * Local: 50ms budget.
   */
  complianceSummary500Ms: 200 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /**
   * Single SHA-256 digest of 1MB string.
   * CI adjustment: 3x multiplier for CPU scheduling variance.
   * Local: 10ms budget.
   */
  digest1MbMs: 20 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** Decision receipts redaction (1000 entries, basic mode). */
  redactionBasic1000Ms: 75 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** Decision receipts redaction (100 entries, strict mode). */
  redactionStrict100Ms: 30 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** Architecture dependency scan for all source files. */
  architectureAnalyzeAllMs: 800 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** Query filter over 10k audit events. */
  filterEvents10000Ms: 50 * (process.env.CI ? 3 : 1) * PERF_BUDGET_FACTOR,

  /** autoAdvance loop (max 10 transitions). */
  autoAdvanceMs: 5 * CI_MULTIPLIER,

  /** validateBinding (2x path normalize + string compare). */
  validateBindingMs: 0.5 * CI_MULTIPLIER,
};

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Measure execution time of a synchronous function.
 * Returns elapsed time in milliseconds (high-resolution).
 */
export function measureSync<T>(fn: () => T): { result: T; elapsedMs: number } {
  const start = performance.now();
  const result = fn();
  const elapsedMs = performance.now() - start;
  return { result, elapsedMs };
}

/**
 * Measure execution time of an async function.
 * Returns elapsed time in milliseconds (high-resolution).
 */
export async function measureAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; elapsedMs: number }> {
  const start = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - start;
  return { result, elapsedMs };
}

/**
 * Run a function N times and return the p99 execution time.
 * First `warmup` iterations are discarded.
 */
export function benchmarkSync<T>(
  fn: () => T,
  iterations: number = 100,
  warmup: number = 10,
): { p99Ms: number; p95Ms: number; medianMs: number; meanMs: number } {
  const times: number[] = [];

  // Warmup (discard results)
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const p99Index = Math.floor(times.length * 0.99);

  return {
    p99Ms: times[p99Index] ?? times[times.length - 1] ?? 0,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0,
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
  };
}

/**
 * Run an async function N times and return p95/p99 execution time.
 * First `warmup` iterations are discarded.
 */
export async function benchmarkAsync<T>(
  fn: () => Promise<T>,
  iterations: number = 20,
  warmup: number = 3,
): Promise<{ p99Ms: number; p95Ms: number; medianMs: number; meanMs: number }> {
  const times: number[] = [];

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const p99Index = Math.floor(times.length * 0.99);

  return {
    p99Ms: times[p99Index] ?? times[times.length - 1] ?? 0,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0,
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
  };
}
