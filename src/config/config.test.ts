import { describe, it, expect } from "vitest";
import {
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  resolvePolicy,
  policyModes,
  createPolicySnapshot,
} from "../config/policy";
import {
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
} from "../config/profile";
import type { RepoSignals } from "../config/profile";
import {
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from "../config/reasons";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

describe("config/policy", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("resolvePolicy returns correct preset for each mode", () => {
      expect(resolvePolicy("solo")).toBe(SOLO_POLICY);
      expect(resolvePolicy("team")).toBe(TEAM_POLICY);
      expect(resolvePolicy("regulated")).toBe(REGULATED_POLICY);
    });

    it("SOLO has no human gates and 1 iteration", () => {
      expect(SOLO_POLICY.requireHumanGates).toBe(false);
      expect(SOLO_POLICY.maxSelfReviewIterations).toBe(1);
      expect(SOLO_POLICY.maxImplReviewIterations).toBe(1);
      expect(SOLO_POLICY.allowSelfApproval).toBe(true);
    });

    it("TEAM has human gates and 3 iterations", () => {
      expect(TEAM_POLICY.requireHumanGates).toBe(true);
      expect(TEAM_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_POLICY.allowSelfApproval).toBe(true);
    });

    it("REGULATED has four-eyes enforcement", () => {
      expect(REGULATED_POLICY.allowSelfApproval).toBe(false);
      expect(REGULATED_POLICY.requireHumanGates).toBe(true);
    });

    it("createPolicySnapshot produces deterministic hash", () => {
      const digest = (s: string) => `hash-of-${s.length}`;
      const snap1 = createPolicySnapshot(TEAM_POLICY, "2026-01-01T00:00:00.000Z", digest);
      const snap2 = createPolicySnapshot(TEAM_POLICY, "2026-01-01T00:00:00.000Z", digest);
      expect(snap1.hash).toBe(snap2.hash);
    });

    it("policyModes returns all 3 modes", () => {
      const modes = policyModes();
      expect(modes).toContain("solo");
      expect(modes).toContain("team");
      expect(modes).toContain("regulated");
      expect(modes.length).toBe(3);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("resolvePolicy returns TEAM for unknown mode", () => {
      expect(resolvePolicy("enterprise")).toBe(TEAM_POLICY);
    });

    it("resolvePolicy returns TEAM for undefined", () => {
      expect(resolvePolicy()).toBe(TEAM_POLICY);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("snapshot preserves all governance-critical fields", () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = createPolicySnapshot(REGULATED_POLICY, "2026-01-01T00:00:00.000Z", digest);
      expect(snap.mode).toBe("regulated");
      expect(snap.requireHumanGates).toBe(true);
      expect(snap.maxSelfReviewIterations).toBe(3);
      expect(snap.maxImplReviewIterations).toBe(3);
      expect(snap.allowSelfApproval).toBe(false);
      expect(snap.audit.enableChainHash).toBe(true);
    });

    it("different policies produce different hashes", () => {
      const digest = (s: string) => `hash-${s}`;
      const solo = createPolicySnapshot(SOLO_POLICY, "2026-01-01T00:00:00.000Z", digest);
      const team = createPolicySnapshot(TEAM_POLICY, "2026-01-01T00:00:00.000Z", digest);
      expect(solo.hash).not.toBe(team.hash);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("SOLO disables hash chain", () => {
      expect(SOLO_POLICY.audit.enableChainHash).toBe(false);
    });

    it("TEAM and REGULATED enable hash chain", () => {
      expect(TEAM_POLICY.audit.enableChainHash).toBe(true);
      expect(REGULATED_POLICY.audit.enableChainHash).toBe(true);
    });

    it("all policies emit transitions and tool calls", () => {
      for (const p of [SOLO_POLICY, TEAM_POLICY, REGULATED_POLICY]) {
        expect(p.audit.emitTransitions).toBe(true);
        expect(p.audit.emitToolCalls).toBe(true);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it(`resolvePolicy < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => resolvePolicy("team"));
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});

describe("config/profile", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("defaultProfileRegistry has 4 built-in profiles", () => {
      expect(defaultProfileRegistry.size).toBe(4);
    });

    it("baseline profile detected with lowest confidence", () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(baselineProfile.detect!(signals)).toBe(0.1);
    });

    it("java profile detected by pom.xml", () => {
      const signals: RepoSignals = { files: [], packageFiles: ["pom.xml"], configFiles: [] };
      expect(javaProfile.detect!(signals)).toBe(0.8);
    });

    it("angular profile detected by angular.json", () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ["angular.json"] };
      expect(angularProfile.detect!(signals)).toBe(0.85);
    });

    it("typescript profile detected by tsconfig.json", () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ["tsconfig.json"] };
      expect(typescriptProfile.detect!(signals)).toBe(0.7);
    });

    it("defaultProfileRegistry.detect picks highest confidence", () => {
      // Both angular.json and tsconfig.json present → angular wins (0.85 > 0.7)
      const signals: RepoSignals = {
        files: [],
        packageFiles: [],
        configFiles: ["angular.json", "tsconfig.json"],
      };
      const detected = defaultProfileRegistry.detect(signals);
      expect(detected?.id).toBe("frontend-angular");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("get returns undefined for unknown profile ID", () => {
      expect(defaultProfileRegistry.get("unknown-stack")).toBeUndefined();
    });

    it("detect returns undefined when no profile matches", () => {
      const registry = new ProfileRegistry();
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(registry.detect(signals)).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("java profile detects build.gradle.kts", () => {
      const signals: RepoSignals = { files: [], packageFiles: ["build.gradle.kts"], configFiles: [] };
      expect(javaProfile.detect!(signals)).toBe(0.8);
    });

    it("angular profile detects nx.json", () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ["nx.json"] };
      expect(angularProfile.detect!(signals)).toBe(0.85);
    });

    it("no matching signals → detect returns only baseline (via confidence > 0)", () => {
      const signals: RepoSignals = { files: ["readme.md"], packageFiles: [], configFiles: [] };
      const detected = defaultProfileRegistry.detect(signals);
      expect(detected?.id).toBe("baseline");
    });

    it("register overwrites existing profile", () => {
      const registry = new ProfileRegistry();
      registry.register({ id: "test", name: "Test 1", activeChecks: [], checks: new Map() });
      registry.register({ id: "test", name: "Test 2", activeChecks: [], checks: new Map() });
      expect(registry.get("test")?.name).toBe("Test 2");
      expect(registry.size).toBe(1);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("profile without detect function cannot be auto-detected", () => {
      const registry = new ProfileRegistry();
      registry.register({ id: "manual", name: "Manual", activeChecks: [], checks: new Map() });
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(registry.detect(signals)).toBeUndefined();
    });

    it("all built-in profiles have instructions", () => {
      expect(baselineProfile.instructions).toBeDefined();
      expect(baselineProfile.instructions!.length).toBeGreaterThan(0);
      expect(javaProfile.instructions).toBeDefined();
      expect(angularProfile.instructions).toBeDefined();
      expect(typescriptProfile.instructions).toBeDefined();
    });

    it.each([
      ["baseline", baselineProfile],
      ["java", javaProfile],
      ["angular", angularProfile],
      ["typescript", typescriptProfile],
    ] as const)("%s profile contains NOT_VERIFIED marker guidance", (_name, profile) => {
      expect(profile.instructions).toContain("NOT_VERIFIED");
    });

    it.each([
      ["baseline", baselineProfile],
      ["java", javaProfile],
      ["angular", angularProfile],
      ["typescript", typescriptProfile],
    ] as const)("%s profile contains ASSUMPTION marker guidance", (_name, profile) => {
      expect(profile.instructions).toContain("ASSUMPTION");
    });

    it("no built-in profile references AGENTS.md", () => {
      const allInstructions = [
        baselineProfile.instructions,
        javaProfile.instructions,
        angularProfile.instructions,
        typescriptProfile.instructions,
      ];
      for (const instr of allInstructions) {
        expect(instr).not.toContain("AGENTS.md");
      }
    });

    it("ids() returns all registered IDs", () => {
      const ids = defaultProfileRegistry.ids();
      expect(ids).toContain("baseline");
      expect(ids).toContain("backend-java");
      expect(ids).toContain("frontend-angular");
      expect(ids).toContain("typescript");
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("profile detection with 10k signals < 1ms (p99)", () => {
      const files = Array.from({ length: 10000 }, (_, i) => `src/file${i}.ts`);
      const signals: RepoSignals = { files, packageFiles: ["pom.xml"], configFiles: ["tsconfig.json"] };
      const result = benchmarkSync(() => {
        defaultProfileRegistry.detect(signals);
      }, 200, 50);
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.profileDetect10kMs);
    });
  });
});

describe("config/reasons", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("format produces structured result for known code", () => {
      const result = defaultReasonRegistry.format("COMMAND_NOT_ALLOWED", {
        command: "/plan",
        phase: "COMPLETE",
      });
      expect(result.code).toBe("COMMAND_NOT_ALLOWED");
      expect(result.reason).toContain("/plan");
      expect(result.reason).toContain("COMPLETE");
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it("blocked() helper returns correct RailBlocked structure", () => {
      const result = blocked("TICKET_REQUIRED", { action: "planning" });
      expect(result.kind).toBe("blocked");
      expect(result.code).toBe("TICKET_REQUIRED");
      expect(result.reason).toContain("planning");
      expect(result.quickFix).toBe("/ticket");
    });

    it("defaultReasonRegistry has 30+ codes", () => {
      expect(defaultReasonRegistry.size).toBeGreaterThanOrEqual(30);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("format returns generic message for unknown code", () => {
      const result = defaultReasonRegistry.format("TOTALLY_UNKNOWN");
      expect(result.code).toBe("TOTALLY_UNKNOWN");
      expect(result.reason).toContain("TOTALLY_UNKNOWN");
      expect(result.recovery).toEqual([]);
    });

    it("get returns undefined for unknown code", () => {
      expect(defaultReasonRegistry.get("NOPE")).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("format interpolates all {variables}", () => {
      const result = defaultReasonRegistry.format("COMMAND_NOT_ALLOWED", {
        command: "/implement",
        phase: "TICKET",
      });
      expect(result.reason).toBe("/implement is not allowed in phase TICKET");
    });

    it("format leaves unknown {variables} as-is", () => {
      const result = defaultReasonRegistry.format("COMMAND_NOT_ALLOWED", {});
      expect(result.reason).toContain("{command}");
      expect(result.reason).toContain("{phase}");
    });

    it("registerAll adds multiple reasons", () => {
      const registry = new BlockedReasonRegistry();
      registry.registerAll([
        { code: "A", category: "input", messageTemplate: "A", recoverySteps: [] },
        { code: "B", category: "input", messageTemplate: "B", recoverySteps: [] },
      ]);
      expect(registry.size).toBe(2);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("all seed codes have non-empty messageTemplate", () => {
      for (const code of defaultReasonRegistry.codes()) {
        const reason = defaultReasonRegistry.get(code);
        expect(reason?.messageTemplate.length).toBeGreaterThan(0);
      }
    });

    it("blocked() with unknown code and vars.message uses it", () => {
      const result = blocked("CUSTOM_CODE", { message: "Custom error" });
      expect(result.reason).toBe("Custom error");
    });

    it("codes() returns array of strings", () => {
      const codes = defaultReasonRegistry.codes();
      expect(Array.isArray(codes)).toBe(true);
      expect(codes.length).toBe(defaultReasonRegistry.size);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it(`reason lookup + format < ${PERF_BUDGETS.reasonLookupMs}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        defaultReasonRegistry.format("COMMAND_NOT_ALLOWED", {
          command: "/plan",
          phase: "TICKET",
        });
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.reasonLookupMs);
    });
  });
});
