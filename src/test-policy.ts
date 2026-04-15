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
 * - Profile detection: < 1ms for detect() with 10,000 file signals
 *
 * @version v1
 */

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
 * Performance budgets for PERF tests.
 * All values in milliseconds unless noted otherwise.
 *
 * These are measured as p99 over 100 iterations (warm).
 * Cold starts may exceed by up to 5x — measure warm only.
 */
export const PERF_BUDGETS = {
  /** Single evaluate(state, policy) call. */
  evaluateSingleMs: 1,

  /** Single guard predicate check. */
  guardPredicateMs: 0.5,

  /** Full hash chain verification for 1000 events. */
  auditChainVerify1000Ms: 100,

  /** Full SessionState JSON.stringify + Zod parse round-trip. */
  stateSerializeMs: 5,

  /** Profile detect() with 10,000 file signals. */
  profileDetect10kMs: 1,

  /** readState + writeState round-trip (filesystem I/O). */
  stateIoRoundTripMs: 50,

  /** Completeness matrix evaluation. */
  completenessEvalMs: 2,

  /** Compliance summary generation from 500 events. */
  complianceSummary500Ms: 50,

  /** Single SHA-256 digest of 1MB string. */
  digest1MbMs: 10,

  /** autoAdvance loop (max 10 transitions). */
  autoAdvanceMs: 5,

  /** validateBinding (2x path normalize + string compare). */
  validateBindingMs: 0.5,

  /** Reason registry lookup + format (map lookup + string interpolation). */
  reasonLookupMs: 5,
} as const;

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
): { p99Ms: number; medianMs: number; meanMs: number } {
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
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
  };
}
