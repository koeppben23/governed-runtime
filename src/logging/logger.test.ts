/**
 * @module logging/logger.test
 * @description Tests for FlowGuard structured logger.
 *
 * Covers:
 * - createLogger: level filtering, sink delegation, structured entry shape
 * - createNoopLogger: all methods are noops
 * - Edge cases: no sink, silent level, extra passthrough
 * - SDK conformance: entries match OpenCode client.app.log() body shape
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from "vitest";
import { createLogger, createNoopLogger, type FlowGuardLogger, type LogEntry } from "./logger";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Capture all structured entries sent to a sink. */
function captureSink(): { entries: LogEntry[]; sink: (entry: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry: LogEntry) => entries.push(entry) };
}

// =============================================================================
// createLogger
// =============================================================================

describe("createLogger", () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  it("emits messages at or above the minimum level", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("info", sink);

    log.info("test", "hello");
    log.warn("test", "warning");
    log.error("test", "error");

    expect(entries).toHaveLength(3);
  });

  it("passes correct service and message to sink", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("plugin", "started");

    expect(entries[0]!.service).toBe("plugin");
    expect(entries[0]!.message).toBe("started");
  });

  it("passes correct level to sink (not hardcoded)", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.debug("s", "d");
    log.info("s", "i");
    log.warn("s", "w");
    log.error("s", "e");

    expect(entries[0]!.level).toBe("debug");
    expect(entries[1]!.level).toBe("info");
    expect(entries[2]!.level).toBe("warn");
    expect(entries[3]!.level).toBe("error");
  });

  it("includes structured extra data when provided", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("audit", "event", { tool: "hydrate", count: 3 });

    expect(entries[0]!.extra).toEqual({ tool: "hydrate", count: 3 });
  });

  it("omits extra when not provided", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("audit", "event");

    expect(entries[0]!.extra).toBeUndefined();
  });

  // ── BAD ────────────────────────────────────────────────────────────────

  it("suppresses messages below the minimum level", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("warn", sink);

    log.debug("test", "debug msg");
    log.info("test", "info msg");
    log.warn("test", "warn msg");
    log.error("test", "error msg");

    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe("warn msg");
    expect(entries[1]!.message).toBe("error msg");
  });

  it("suppresses all messages at silent level", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("silent", sink);

    log.debug("test", "debug");
    log.info("test", "info");
    log.warn("test", "warn");
    log.error("test", "error");

    expect(entries).toHaveLength(0);
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it("does not throw when sink is undefined", () => {
    const log = createLogger("debug");
    expect(() => log.info("test", "hello")).not.toThrow();
    expect(() => log.error("test", "oops")).not.toThrow();
  });

  it("debug level emits all messages", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.debug("a", "1");
    log.info("a", "2");
    log.warn("a", "3");
    log.error("a", "4");

    expect(entries).toHaveLength(4);
  });

  it("error level only emits error", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("error", sink);

    log.debug("a", "1");
    log.info("a", "2");
    log.warn("a", "3");
    log.error("a", "4");

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.message).toBe("4");
  });

  // ── EDGE ───────────────────────────────────────────────────────────────

  it("handles empty service and message", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("", "");

    expect(entries[0]!.service).toBe("");
    expect(entries[0]!.message).toBe("");
  });

  it("passes extra with nested objects unchanged", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("test", "nested", { a: { b: { c: 1 } } });

    expect(entries[0]!.extra).toEqual({ a: { b: { c: 1 } } });
  });

  it("passes extra with empty object", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.info("test", "empty extra", {});

    expect(entries[0]!.extra).toEqual({});
  });

  // ── SDK CONFORMANCE ────────────────────────────────────────────────────

  it("LogEntry shape matches OpenCode client.app.log() body contract", () => {
    const { entries, sink } = captureSink();
    const log = createLogger("debug", sink);

    log.warn("audit", "policy resolved", { mode: "regulated" });

    const entry = entries[0]!;
    // OpenCode SDK: { service: string, level: string, message: string, extra?: Record }
    expect(typeof entry.service).toBe("string");
    expect(typeof entry.level).toBe("string");
    expect(typeof entry.message).toBe("string");
    expect(["debug", "info", "warn", "error"]).toContain(entry.level);
    expect(entry.extra).toBeDefined();
  });
});

// =============================================================================
// createNoopLogger
// =============================================================================

describe("createNoopLogger", () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  it("returns an object with all four log methods", () => {
    const log = createNoopLogger();
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("all methods are noops (do not throw)", () => {
    const log = createNoopLogger();
    expect(() => log.debug("s", "m")).not.toThrow();
    expect(() => log.info("s", "m")).not.toThrow();
    expect(() => log.warn("s", "m")).not.toThrow();
    expect(() => log.error("s", "m", { key: "val" })).not.toThrow();
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it("satisfies the FlowGuardLogger interface", () => {
    const log: FlowGuardLogger = createNoopLogger();
    // Type check is the assertion — if this compiles, the interface is satisfied
    expect(log).toBeDefined();
  });
});

// =============================================================================
// Performance
// =============================================================================

describe("Performance", () => {
  // ── PERF ───────────────────────────────────────────────────────────────

  it("filtered-out log calls are fast (10000 iterations)", () => {
    const log = createLogger("error"); // no sink, filters below error
    const result = benchmarkSync(() => {
      log.debug("test", "should be filtered");
    }, 10000);
    // Filtered log calls should be nearly free — under 0.1ms p99
    expect(result.p99Ms).toBeLessThan(0.1);
  });

  it("noop logger calls are fast (10000 iterations)", () => {
    const log = createNoopLogger();
    const result = benchmarkSync(() => {
      log.info("test", "noop");
    }, 10000);
    expect(result.p99Ms).toBeLessThan(0.1);
  });
});
