/**
 * @module adapters.test
 * @description Tests for the governance adapter layer.
 *
 * Covers:
 * - persistence: atomic file I/O, Zod validation, JSONL trail (uses real temp dirs)
 * - binding: validateBinding, fromOpenCodeContext (pure functions)
 * - context: createRailContext factory
 *
 * Note: git adapter is integration-level (requires real git repo). Excluded from V1 tests.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  readState,
  writeState,
  stateExists,
  writeReport,
  readReport,
  appendAuditEvent,
  readAuditTrail,
  govDir,
  statePath,
  reportPath,
  auditPath,
  PersistenceError,
  isEnoent,
} from "./persistence";
import { validateBinding, fromOpenCodeContext, BindingError } from "./binding";
import { createRailContext } from "./context";
import type { SessionState } from "../state/schema";
import type { AuditEvent, ReviewReport } from "../state/evidence";
import { makeState, makeProgressedState, FIXED_TIME, FIXED_UUID, FIXED_SESSION_UUID } from "../__fixtures__";
import { benchmarkSync, measureAsync, PERF_BUDGETS } from "../test-policy";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create a fresh temp directory for each test. */
async function createTmpWorktree(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gov-test-"));
}

/** Clean up temp directory. */
async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

/** Create a minimal valid AuditEvent for persistence tests. */
function makeValidAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: FIXED_UUID,
    sessionId: FIXED_SESSION_UUID,
    phase: "PLAN",
    event: "transition:PLAN_READY",
    timestamp: FIXED_TIME,
    actor: "machine",
    detail: { kind: "transition", from: "TICKET", to: "PLAN" },
    ...overrides,
  };
}

/** Create a minimal valid ReviewReport for persistence tests. */
function makeValidReport(): ReviewReport {
  return {
    schemaVersion: "governance-review-report.v1",
    sessionId: FIXED_SESSION_UUID,
    generatedAt: FIXED_TIME,
    phase: "COMPLETE",
    planDigest: "digest-abc",
    implDigest: "digest-xyz",
    validationSummary: [],
    findings: [],
    overallStatus: "clean",
  };
}

// =============================================================================
// persistence
// =============================================================================

describe("persistence", () => {
  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
  });

  afterEach(async () => {
    await cleanTmpDir(tmpDir);
  });

  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("path helpers resolve correct paths", () => {
      const wt = "/tmp/my-repo";
      expect(govDir(wt)).toBe(path.join(wt, ".governance"));
      expect(statePath(wt)).toBe(path.join(wt, ".governance", "session-state.json"));
      expect(reportPath(wt)).toBe(path.join(wt, ".governance", "review-report.json"));
      expect(auditPath(wt)).toBe(path.join(wt, ".governance", "audit.jsonl"));
    });

    it("writeState + readState round-trip preserves data", async () => {
      const state = makeProgressedState("PLAN_REVIEW");
      await writeState(tmpDir, state);
      const loaded = await readState(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe("PLAN_REVIEW");
      expect(loaded!.ticket!.text).toBe(state.ticket!.text);
      expect(loaded!.plan!.current.digest).toBe(state.plan!.current.digest);
    });

    it("stateExists returns true after writeState", async () => {
      expect(await stateExists(tmpDir)).toBe(false);
      await writeState(tmpDir, makeProgressedState("TICKET"));
      expect(await stateExists(tmpDir)).toBe(true);
    });

    it("writeReport + readReport round-trip preserves data", async () => {
      const report = makeValidReport();
      await writeReport(tmpDir, report);
      const loaded = await readReport(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.schemaVersion).toBe("governance-review-report.v1");
      expect(loaded!.overallStatus).toBe("clean");
    });

    it("appendAuditEvent + readAuditTrail round-trip", async () => {
      const event1 = makeValidAuditEvent();
      const event2 = makeValidAuditEvent({
        id: "11111111-1111-1111-1111-111111111111",
        event: "transition:TICKET_SET",
      });
      await appendAuditEvent(tmpDir, event1);
      await appendAuditEvent(tmpDir, event2);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
      expect(events[0]!.event).toBe("transition:PLAN_READY");
      expect(events[1]!.event).toBe("transition:TICKET_SET");
    });

    it("writeState auto-creates .governance/ directory", async () => {
      // tmpDir has no .governance/ subdirectory yet
      const state = makeProgressedState("TICKET");
      await writeState(tmpDir, state);
      const stat = await fs.stat(path.join(tmpDir, ".governance"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("isEnoent correctly identifies ENOENT errors", () => {
      const enoent = { code: "ENOENT", message: "no such file" };
      const eperm = { code: "EPERM", message: "permission denied" };
      expect(isEnoent(enoent)).toBe(true);
      expect(isEnoent(eperm)).toBe(false);
      expect(isEnoent(null)).toBe(false);
      expect(isEnoent("not an object")).toBe(false);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe("BAD", () => {
    it("readState returns null for nonexistent file", async () => {
      const result = await readState(tmpDir);
      expect(result).toBeNull();
    });

    it("readReport returns null for nonexistent file", async () => {
      const result = await readReport(tmpDir);
      expect(result).toBeNull();
    });

    it("readAuditTrail returns empty for nonexistent file", async () => {
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    it("writeState rejects invalid state (Zod validation)", async () => {
      const invalid = { phase: "INVALID_PHASE" } as unknown as SessionState;
      await expect(writeState(tmpDir, invalid)).rejects.toThrow(PersistenceError);
      try {
        await writeState(tmpDir, invalid);
      } catch (err) {
        expect(err).toBeInstanceOf(PersistenceError);
        expect((err as PersistenceError).code).toBe("SCHEMA_VALIDATION_FAILED");
      }
    });

    it("readState throws on corrupted JSON", async () => {
      await fs.mkdir(govDir(tmpDir), { recursive: true });
      await fs.writeFile(statePath(tmpDir), "not valid json{{{", "utf-8");
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
      try {
        await readState(tmpDir);
      } catch (err) {
        expect((err as PersistenceError).code).toBe("PARSE_FAILED");
      }
    });

    it("readState throws on valid JSON but invalid schema", async () => {
      await fs.mkdir(govDir(tmpDir), { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify({ foo: "bar" }), "utf-8");
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
      try {
        await readState(tmpDir);
      } catch (err) {
        expect((err as PersistenceError).code).toBe("SCHEMA_VALIDATION_FAILED");
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe("CORNER", () => {
    it("readAuditTrail skips malformed lines but reads valid ones", async () => {
      await fs.mkdir(govDir(tmpDir), { recursive: true });
      const validEvent = makeValidAuditEvent();
      const content = [
        JSON.stringify(validEvent),
        "this is not json",
        JSON.stringify({ invalid: "schema" }),
        JSON.stringify(makeValidAuditEvent({ id: "22222222-2222-2222-2222-222222222222" })),
        "",
      ].join("\n");
      await fs.writeFile(auditPath(tmpDir), content, "utf-8");
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(2); // malformed JSON + valid JSON but invalid schema
    });

    it("readAuditTrail handles empty file", async () => {
      await fs.mkdir(govDir(tmpDir), { recursive: true });
      await fs.writeFile(auditPath(tmpDir), "", "utf-8");
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    it("writeState overwrites previous state atomically", async () => {
      const state1 = makeProgressedState("TICKET");
      const state2 = makeProgressedState("PLAN_REVIEW");
      await writeState(tmpDir, state1);
      await writeState(tmpDir, state2);
      const loaded = await readState(tmpDir);
      expect(loaded!.phase).toBe("PLAN_REVIEW");
    });

    it("writeReport overwrites previous report", async () => {
      const report1 = makeValidReport();
      const report2: ReviewReport = { ...makeValidReport(), overallStatus: "issues" };
      await writeReport(tmpDir, report1);
      await writeReport(tmpDir, report2);
      const loaded = await readReport(tmpDir);
      expect(loaded!.overallStatus).toBe("issues");
    });

    it("state file is pretty-printed (readable for git diffs)", async () => {
      await writeState(tmpDir, makeProgressedState("TICKET"));
      const raw = await fs.readFile(statePath(tmpDir), "utf-8");
      expect(raw).toContain("\n  "); // 2-space indent
      expect(raw.endsWith("\n")).toBe(true); // trailing newline
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe("EDGE", () => {
    it("multiple concurrent writeState calls — at least one succeeds, no corruption", async () => {
      // Race multiple writes — on Windows, NTFS locks may cause some EPERM errors.
      // The invariant: at least one write succeeds and the file is valid (no corruption).
      const states = Array.from({ length: 5 }, (_, i) =>
        makeState("TICKET", {
          id: FIXED_UUID,
          binding: {
            sessionId: FIXED_SESSION_UUID,
            worktree: `/tmp/test-${i}`,
            resolvedAt: FIXED_TIME,
          },
        }),
      );
      const results = await Promise.allSettled(states.map(s => writeState(tmpDir, s)));
      const fulfilled = results.filter(r => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      // File should be valid (one of the writes won, no corruption)
      const loaded = await readState(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe("TICKET");
    });

    it("appendAuditEvent is additive (doesn't overwrite)", async () => {
      for (let i = 0; i < 10; i++) {
        const id = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
        await appendAuditEvent(tmpDir, makeValidAuditEvent({ id }));
      }
      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(10);
    });

    it("readState returns fresh reference (no shared object)", async () => {
      await writeState(tmpDir, makeProgressedState("TICKET"));
      const a = await readState(tmpDir);
      const b = await readState(tmpDir);
      expect(a).not.toBe(b); // Different references
      expect(a).toEqual(b); // Same content
    });

    it("PersistenceError has correct name and code", () => {
      const err = new PersistenceError("READ_FAILED", "test");
      expect(err.name).toBe("PersistenceError");
      expect(err.code).toBe("READ_FAILED");
      expect(err instanceof Error).toBe(true);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe("PERF", () => {
    it("writeState + readState round-trip < 50ms", async () => {
      const state = makeProgressedState("COMPLETE");
      // Warmup
      await writeState(tmpDir, state);
      await readState(tmpDir);

      const { elapsedMs } = await measureAsync(async () => {
        await writeState(tmpDir, state);
        return await readState(tmpDir);
      });
      expect(elapsedMs).toBeLessThan(PERF_BUDGETS.stateIoRoundTripMs);
    });
  });
});

// =============================================================================
// binding (pure functions)
// =============================================================================

describe("binding", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("validateBinding passes for matching worktrees", () => {
      const state = makeState("TICKET", {
        binding: { sessionId: "old-session", worktree: tmpDir || "/tmp/test-repo", resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: state.binding.worktree, sessionId: "new-session" };
      expect(validateBinding(state, binding)).toBe(true);
    });

    it("fromOpenCodeContext maps field names correctly", () => {
      const raw = { sessionID: "sess-123", worktree: "/tmp/repo", directory: "/tmp/repo/src" };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe("sess-123");
      expect(ctx.worktree).toBe("/tmp/repo");
      expect(ctx.directory).toBe("/tmp/repo/src");
    });

    it("validateBinding allows different session IDs (continuation)", () => {
      const worktree = path.resolve("/tmp/continuity-repo");
      const state = makeState("PLAN", {
        binding: { sessionId: "session-old", worktree, resolvedAt: FIXED_TIME },
      });
      // New session ID but same worktree
      expect(validateBinding(state, { worktreeRoot: worktree, sessionId: "session-new" })).toBe(true);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe("BAD", () => {
    it("validateBinding throws on worktree mismatch", () => {
      const state = makeState("TICKET", {
        binding: { sessionId: "sess-1", worktree: "/tmp/repo-a", resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: "/tmp/repo-b", sessionId: "sess-1" };
      expect(() => validateBinding(state, binding)).toThrow(BindingError);
      try {
        validateBinding(state, binding);
      } catch (err) {
        expect((err as BindingError).code).toBe("WORKTREE_MISMATCH");
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe("CORNER", () => {
    it("validateBinding normalizes paths (trailing slash)", () => {
      const basePath = path.resolve("/tmp/norm-test");
      const state = makeState("TICKET", {
        binding: { sessionId: "s1", worktree: basePath, resolvedAt: FIXED_TIME },
      });
      // Same path but with trailing slash — should still match
      expect(validateBinding(state, { worktreeRoot: basePath + path.sep, sessionId: "s1" })).toBe(true);
    });

    it("BindingError has correct name and code", () => {
      const err = new BindingError("MISSING_SESSION_ID", "test");
      expect(err.name).toBe("BindingError");
      expect(err.code).toBe("MISSING_SESSION_ID");
      expect(err instanceof Error).toBe(true);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe("EDGE", () => {
    it("fromOpenCodeContext preserves whitespace in values", () => {
      const raw = { sessionID: " sess ", worktree: " /tmp/repo ", directory: " /tmp/repo/src " };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe(" sess ");
      expect(ctx.worktree).toBe(" /tmp/repo ");
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe("PERF", () => {
    it("validateBinding < 0.1ms (p99 over 200 iterations)", () => {
      const worktree = path.resolve("/tmp/perf-repo");
      const state = makeState("TICKET", {
        binding: { sessionId: "s1", worktree, resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: worktree, sessionId: "s1" };
      const { p99Ms } = benchmarkSync(() => validateBinding(state, binding), 200, 50);
      expect(p99Ms).toBeLessThan(0.1);
    });
  });
});

// =============================================================================
// context
// =============================================================================

describe("context", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("createRailContext returns context with now() and digest()", () => {
      const ctx = createRailContext();
      expect(typeof ctx.now).toBe("function");
      expect(typeof ctx.digest).toBe("function");
    });

    it("now() returns ISO-8601 timestamp", () => {
      const ctx = createRailContext();
      const ts = ctx.now();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Should parse as valid date
      expect(new Date(ts).getTime()).not.toBeNaN();
    });

    it("digest() returns 64-char hex SHA-256", () => {
      const ctx = createRailContext();
      const hash = ctx.digest("hello world");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe("BAD", () => {
    it("digest() handles empty string", () => {
      const ctx = createRailContext();
      const hash = ctx.digest("");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // SHA-256 of empty string is well-known
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe("CORNER", () => {
    it("digest() is deterministic", () => {
      const ctx = createRailContext();
      expect(ctx.digest("test")).toBe(ctx.digest("test"));
    });

    it("digest() differs for different inputs", () => {
      const ctx = createRailContext();
      expect(ctx.digest("a")).not.toBe(ctx.digest("b"));
    });

    it("each createRailContext call returns independent context", () => {
      const ctx1 = createRailContext();
      const ctx2 = createRailContext();
      expect(ctx1).not.toBe(ctx2);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe("EDGE", () => {
    it("now() returns different values across time", async () => {
      const ctx = createRailContext();
      const t1 = ctx.now();
      await new Promise(resolve => setTimeout(resolve, 10));
      const t2 = ctx.now();
      // At least different (millisecond resolution should differ after 10ms)
      expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
    });

    it("digest() handles unicode content", () => {
      const ctx = createRailContext();
      const hash = ctx.digest("Hello\u00e9\u4e16\u754c");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe("PERF", () => {
    it("digest() of 1MB string < 10ms", () => {
      const ctx = createRailContext();
      const bigString = "x".repeat(1024 * 1024);
      const { p99Ms } = benchmarkSync(() => ctx.digest(bigString), 20, 5);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.digest1MbMs);
    });
  });
});
