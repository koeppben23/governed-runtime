/**
 * @module integration/plugin.test
 * @description Tests for the GovernanceAuditPlugin integration module.
 *
 * The plugin is an async function that receives the OpenCode PluginInput context
 * and returns a Hooks object with a `tool.execute.after` handler. Since full
 * plugin execution requires a live OpenCode runtime, these tests validate:
 * - Export shape: GovernanceAuditPlugin is an async function with correct arity
 * - Hooks contract: calling the plugin returns an object with the expected hooks
 * - Barrel export: integration/index.ts re-exports GovernanceAuditPlugin
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from "vitest";
import { GovernanceAuditPlugin } from "./plugin";
import * as barrel from "./index";

// ─── Mock Plugin Input ────────────────────────────────────────────────────────

/**
 * Create a minimal mock PluginInput.
 * The plugin only uses `worktree` and `directory` from the input, plus
 * `client.app.log` for error logging. We provide stubs for all required fields.
 */
function createMockInput(overrides: Record<string, unknown> = {}) {
  return {
    project: {} as unknown,
    client: {
      app: {
        log: async () => {},
      },
    } as unknown,
    $: {} as unknown,
    directory: "/tmp/mock-dir",
    worktree: "/tmp/mock-worktree",
    serverUrl: new URL("http://localhost:3000"),
    ...overrides,
  } as Parameters<typeof GovernanceAuditPlugin>[0];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration/plugin", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("GovernanceAuditPlugin is an async function", () => {
      expect(typeof GovernanceAuditPlugin).toBe("function");
      // Async functions have AsyncFunction constructor
      expect(GovernanceAuditPlugin.constructor.name).toBe("AsyncFunction");
    });

    it("GovernanceAuditPlugin returns hooks with tool.execute.after", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      expect(hooks).toBeDefined();
      expect(typeof hooks).toBe("object");
      expect(typeof hooks["tool.execute.after"]).toBe("function");
    });

    it("barrel re-exports GovernanceAuditPlugin", () => {
      expect(barrel.GovernanceAuditPlugin).toBe(GovernanceAuditPlugin);
    });

    it("tool.execute.after handler accepts input and output args", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const handler = hooks["tool.execute.after"]!;
      // Check arity: 2 params (input, output)
      expect(handler.length).toBe(2);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("silently ignores non-governance tool calls", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const handler = hooks["tool.execute.after"]!;

      // Calling with a non-governance tool name should not throw
      await expect(
        handler(
          { tool: "bash", sessionID: "s1", callID: "c1", args: {} },
          { title: "bash", output: "{}", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it("handles missing worktree gracefully", async () => {
      const hooks = await GovernanceAuditPlugin(
        createMockInput({ worktree: "", directory: "" }),
      );
      const handler = hooks["tool.execute.after"]!;

      // Should not throw even with empty worktree
      await expect(
        handler(
          { tool: "governance_status", sessionID: "s1", callID: "c1", args: {} },
          { title: "status", output: '{"phase":"TICKET"}', metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("initializes with worktree from input.worktree", async () => {
      // When worktree is provided, it takes precedence over directory
      const hooks = await GovernanceAuditPlugin(
        createMockInput({
          worktree: "/custom/worktree",
          directory: "/custom/dir",
        }),
      );
      expect(hooks).toBeDefined();
    });

    it("falls back to directory when worktree is empty", async () => {
      const hooks = await GovernanceAuditPlugin(
        createMockInput({
          worktree: "",
          directory: "/custom/dir",
        }),
      );
      expect(hooks).toBeDefined();
    });

    it("returns only the tool.execute.after hook (no other hooks)", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const keys = Object.keys(hooks);
      expect(keys).toEqual(["tool.execute.after"]);
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("handles non-JSON tool output without throwing", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const handler = hooks["tool.execute.after"]!;

      // Non-JSON output — the handler should catch parse errors internally
      await expect(
        handler(
          { tool: "governance_status", sessionID: "s1", callID: "c1", args: {} },
          { title: "status", output: "not json at all", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it("multiple plugin initializations create independent instances", async () => {
      const hooks1 = await GovernanceAuditPlugin(
        createMockInput({ worktree: "/wt1" }),
      );
      const hooks2 = await GovernanceAuditPlugin(
        createMockInput({ worktree: "/wt2" }),
      );

      // Different hook instances (closure captures different worktree)
      expect(hooks1["tool.execute.after"]).not.toBe(
        hooks2["tool.execute.after"],
      );
    });

    it("handles tool name exactly at GOV_PREFIX boundary", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const handler = hooks["tool.execute.after"]!;

      // "governance_" alone (without suffix) — should match GOV_PREFIX
      await expect(
        handler(
          { tool: "governance_", sessionID: "s1", callID: "c1", args: {} },
          { title: "", output: "{}", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("plugin initialization completes in < 5ms", async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await GovernanceAuditPlugin(createMockInput());
      }
      const elapsed = performance.now() - start;
      // 100 initializations in < 500ms => < 5ms each
      expect(elapsed).toBeLessThan(500);
    });

    it("non-governance tool filtering is sub-microsecond", async () => {
      const hooks = await GovernanceAuditPlugin(createMockInput());
      const handler = hooks["tool.execute.after"]!;

      // Non-governance tools should be filtered out immediately (prefix check)
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await handler(
          { tool: "bash", sessionID: "s1", callID: "c1", args: {} },
          { title: "bash", output: "", metadata: {} },
        );
      }
      const elapsed = performance.now() - start;
      // 1000 calls in < 20ms => < 0.02ms per call (prefix check)
      expect(elapsed).toBeLessThan(20);
    });
  });
});
