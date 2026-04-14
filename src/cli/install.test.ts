/**
 * @module cli/install.test
 * @description Tests for the governance CLI installer (install, uninstall, doctor).
 *
 * Uses real temp directories to exercise filesystem operations end-to-end.
 * All five test categories are covered: HAPPY, BAD, CORNER, EDGE, PERF.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import {
  parseArgs,
  resolveTarget,
  install,
  uninstall,
  doctor,
  formatResult,
  formatDoctor,
  main,
  type CliArgs,
  type CliResult,
  type DoctorCheck,
} from "./install";
import { TOOL_WRAPPER, PLUGIN_WRAPPER, COMMANDS } from "./templates";
import { measureAsync } from "../test-policy";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let originalCwd: string;

/** Create a fresh temp directory for each test. */
async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gov-cli-test-"));
}

/** Clean up temp directory. */
async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

/** Default args for project-mode install targeting our tmp dir. */
function projectArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: "install",
    global: false,
    mode: "solo",
    force: false,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await createTmpDir();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanTmpDir(tmpDir);
});

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe("cli/parseArgs", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("parses 'install' with defaults", () => {
      const args = parseArgs(["install"]);
      expect(args).toEqual({
        action: "install",
        global: true,
        mode: "solo",
        force: false,
      });
    });

    it("parses 'install --project'", () => {
      const args = parseArgs(["install", "--project"]);
      expect(args).not.toBeNull();
      expect(args!.global).toBe(false);
    });

    it("parses 'install --mode team'", () => {
      const args = parseArgs(["install", "--mode", "team"]);
      expect(args).not.toBeNull();
      expect(args!.mode).toBe("team");
    });

    it("parses 'install --mode regulated --force'", () => {
      const args = parseArgs(["install", "--mode", "regulated", "--force"]);
      expect(args).not.toBeNull();
      expect(args!.mode).toBe("regulated");
      expect(args!.force).toBe(true);
    });

    it("parses 'uninstall --global'", () => {
      const args = parseArgs(["uninstall", "--global"]);
      expect(args).toEqual({
        action: "uninstall",
        global: true,
        mode: "solo",
        force: false,
      });
    });

    it("parses 'doctor'", () => {
      const args = parseArgs(["doctor"]);
      expect(args).not.toBeNull();
      expect(args!.action).toBe("doctor");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("returns null for empty argv", () => {
      expect(parseArgs([])).toBeNull();
    });

    it("returns null for unknown action", () => {
      expect(parseArgs(["deploy"])).toBeNull();
    });

    it("returns null for --mode without value", () => {
      expect(parseArgs(["install", "--mode"])).toBeNull();
    });

    it("returns null for --mode with invalid value", () => {
      expect(parseArgs(["install", "--mode", "enterprise"])).toBeNull();
    });

    it("returns null for unknown flag", () => {
      expect(parseArgs(["install", "--verbose"])).toBeNull();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("--global after --project: last one wins", () => {
      const args = parseArgs(["install", "--project", "--global"]);
      expect(args).not.toBeNull();
      expect(args!.global).toBe(true);
    });

    it("--project after --global: last one wins", () => {
      const args = parseArgs(["install", "--global", "--project"]);
      expect(args).not.toBeNull();
      expect(args!.global).toBe(false);
    });

    it("all three modes are accepted", () => {
      for (const mode of ["solo", "team", "regulated"] as const) {
        const args = parseArgs(["install", "--mode", mode]);
        expect(args).not.toBeNull();
        expect(args!.mode).toBe(mode);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("all three actions are accepted", () => {
      for (const action of ["install", "uninstall", "doctor"] as const) {
        const args = parseArgs([action]);
        expect(args).not.toBeNull();
        expect(args!.action).toBe(action);
      }
    });

    it("--force without --mode still defaults to solo", () => {
      const args = parseArgs(["install", "--force"]);
      expect(args).not.toBeNull();
      expect(args!.mode).toBe("solo");
      expect(args!.force).toBe(true);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("parseArgs is sub-millisecond for complex flags", () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        parseArgs(["install", "--project", "--mode", "regulated", "--force"]);
      }
      const elapsed = performance.now() - start;
      // 1000 calls in < 50ms => < 0.05ms per call
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe("cli/resolveTarget", () => {
  describe("HAPPY", () => {
    it("global resolves to ~/.config/opencode", () => {
      const target = resolveTarget(true);
      expect(target).toContain(path.join(".config", "opencode"));
      expect(path.isAbsolute(target)).toBe(true);
    });

    it("project resolves to .opencode in cwd", () => {
      const target = resolveTarget(false);
      expect(target).toContain(".opencode");
      expect(path.isAbsolute(target)).toBe(true);
    });
  });
});

// ─── install ──────────────────────────────────────────────────────────────────

describe("cli/install", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("creates all governance files in project mode", async () => {
      const result = await install(projectArgs());
      expect(result.errors).toEqual([]);

      const oc = path.join(tmpDir, ".opencode");
      // Tool wrapper
      expect(existsSync(path.join(oc, "tools", "governance.ts"))).toBe(true);
      // Plugin wrapper
      expect(existsSync(path.join(oc, "plugins", "governance-audit.ts"))).toBe(true);
      // Command files
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, "commands", name))).toBe(true);
      }
      // package.json
      expect(existsSync(path.join(oc, "package.json"))).toBe(true);
      // opencode.json in project root
      expect(existsSync(path.join(tmpDir, "opencode.json"))).toBe(true);
      // AGENTS.md in project root
      expect(existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
    });

    it("tool wrapper content matches template", async () => {
      await install(projectArgs());
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "tools", "governance.ts"),
        "utf-8",
      );
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it("plugin wrapper content matches template", async () => {
      await install(projectArgs());
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "plugins", "governance-audit.ts"),
        "utf-8",
      );
      expect(content.trim()).toBe(PLUGIN_WRAPPER.trim());
    });

    it("package.json contains @governance/core dependency", async () => {
      await install(projectArgs());
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@governance/core"]).toBeDefined();
      expect(parsed.dependencies["zod"]).toBeDefined();
      expect(parsed.dependencies["@opencode-ai/plugin"]).toBeDefined();
    });

    it("opencode.json includes AGENTS.md in instructions", async () => {
      await install(projectArgs());
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.instructions).toContain("AGENTS.md");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("returns error count of 0 even on fresh directory", async () => {
      // install on an empty directory should succeed, not error
      const result = await install(projectArgs());
      expect(result.errors.length).toBe(0);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("idempotent: second install skips existing files", async () => {
      await install(projectArgs());
      const result2 = await install(projectArgs());
      // Tool and plugin should be skipped (already exist, no --force)
      const skipped = result2.ops.filter((op) => op.action === "skipped");
      expect(skipped.length).toBeGreaterThan(0);
    });

    it("--force overwrites existing tool wrapper", async () => {
      await install(projectArgs());
      // Modify the tool wrapper
      const toolPath = path.join(tmpDir, ".opencode", "tools", "governance.ts");
      await fs.writeFile(toolPath, "// modified", "utf-8");

      // Re-install with --force
      const result = await install(projectArgs({ force: true }));
      const toolOp = result.ops.find((op) => op.path.includes("governance.ts") && op.path.includes("tools"));
      expect(toolOp?.action).toBe("written");

      // Content should be restored
      const content = await fs.readFile(toolPath, "utf-8");
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it("merges into existing package.json without removing other deps", async () => {
      // Create a package.json with an extra dependency
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } }, null, 2),
        "utf-8",
      );

      await install(projectArgs());
      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      // Original dep preserved
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
      // Governance dep added
      expect(parsed.dependencies["@governance/core"]).toBeDefined();
    });

    it("merges into existing opencode.json without removing other config", async () => {
      // Create an opencode.json with custom config
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify({ model: "claude-4-opus" }, null, 2),
        "utf-8",
      );

      await install(projectArgs());
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      // Original config preserved
      expect(parsed.model).toBe("claude-4-opus");
      // instructions added
      expect(parsed.instructions).toContain("AGENTS.md");
    });

    it("AGENTS.md is never overwritten even with --force", async () => {
      // Create a custom AGENTS.md
      const agentsPath = path.join(tmpDir, "AGENTS.md");
      await fs.writeFile(agentsPath, "# My Custom Rules\n", "utf-8");

      await install(projectArgs({ force: true }));
      const content = await fs.readFile(agentsPath, "utf-8");
      // Should still be the user's content (writeIfAbsent with force=false for AGENTS.md)
      expect(content).toBe("# My Custom Rules\n");
    });

    it("handles malformed package.json by overwriting", async () => {
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        "{ this is not valid json }}}",
        "utf-8",
      );

      const result = await install(projectArgs());
      const pkgOp = result.ops.find((op) => op.path.includes("package.json"));
      expect(pkgOp?.action).toBe("written");
      expect(pkgOp?.reason).toContain("malformed");
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("opencode.json does not duplicate AGENTS.md in instructions on re-install", async () => {
      await install(projectArgs());
      await install(projectArgs());

      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      const count = (parsed.instructions as string[]).filter(
        (i: string) => i === "AGENTS.md",
      ).length;
      expect(count).toBe(1);
    });

    it("result ops include every written file", async () => {
      const result = await install(projectArgs());
      // 1 tool + 1 plugin + 9 commands + 1 package.json + 1 opencode.json + 1 AGENTS.md = 14
      const commandCount = Object.keys(COMMANDS).length;
      const expectedOps = 1 + 1 + commandCount + 1 + 1 + 1;
      expect(result.ops.length).toBe(expectedOps);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("full install completes in < 500ms", async () => {
      const { elapsedMs } = await measureAsync(async () => {
        await install(projectArgs());
      });
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});

// ─── uninstall ────────────────────────────────────────────────────────────────

describe("cli/uninstall", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("removes governance files after install", async () => {
      await install(projectArgs());
      const result = await uninstall(projectArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);

      const oc = path.join(tmpDir, ".opencode");
      // Tool and plugin removed
      expect(existsSync(path.join(oc, "tools", "governance.ts"))).toBe(false);
      expect(existsSync(path.join(oc, "plugins", "governance-audit.ts"))).toBe(false);
      // Command files removed
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, "commands", name))).toBe(false);
      }
    });

    it("removes @governance/core from package.json", async () => {
      await install(projectArgs());
      await uninstall(projectArgs({ action: "uninstall" }));

      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@governance/core"]).toBeUndefined();
    });

    it("preserves AGENTS.md", async () => {
      await install(projectArgs());
      const agentsPath = path.join(tmpDir, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);

      await uninstall(projectArgs({ action: "uninstall" }));
      // AGENTS.md should still exist
      expect(existsSync(agentsPath)).toBe(true);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("uninstall on empty dir returns not_found ops, no errors", async () => {
      const result = await uninstall(projectArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);
      const notFound = result.ops.filter((op) => op.action === "not_found");
      expect(notFound.length).toBeGreaterThan(0);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("uninstall preserves other dependencies in package.json", async () => {
      // Install with extra dep
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } }, null, 2),
        "utf-8",
      );
      await install(projectArgs());
      await uninstall(projectArgs({ action: "uninstall" }));

      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
      expect(parsed.dependencies["@governance/core"]).toBeUndefined();
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("double uninstall is safe", async () => {
      await install(projectArgs());
      await uninstall(projectArgs({ action: "uninstall" }));
      const result = await uninstall(projectArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("uninstall completes in < 200ms", async () => {
      await install(projectArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await uninstall(projectArgs({ action: "uninstall" }));
      });
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});

// ─── doctor ───────────────────────────────────────────────────────────────────

describe("cli/doctor", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("all checks pass after fresh install", async () => {
      await install(projectArgs());
      const checks = await doctor(projectArgs({ action: "doctor" }));
      const allOk = checks.every((c) => c.status === "ok");
      expect(allOk).toBe(true);
    });

    it("returns correct check count", async () => {
      await install(projectArgs());
      const checks = await doctor(projectArgs({ action: "doctor" }));
      // 1 tool + 1 plugin + N commands + 1 package.json + 1 AGENTS.md
      const expectedChecks = 1 + 1 + Object.keys(COMMANDS).length + 1 + 1;
      expect(checks.length).toBe(expectedChecks);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("reports missing files on empty dir", async () => {
      const checks = await doctor(projectArgs({ action: "doctor" }));
      const missing = checks.filter((c) => c.status === "missing");
      expect(missing.length).toBeGreaterThan(0);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("detects modified tool wrapper", async () => {
      await install(projectArgs());
      const toolPath = path.join(tmpDir, ".opencode", "tools", "governance.ts");
      await fs.writeFile(toolPath, "// tampered content", "utf-8");

      const checks = await doctor(projectArgs({ action: "doctor" }));
      const toolCheck = checks.find((c) => c.file.includes("governance.ts") && c.file.includes("tools"));
      expect(toolCheck?.status).toBe("modified");
    });

    it("detects missing @governance/core in package.json", async () => {
      await install(projectArgs());
      // Remove the dependency
      const pkgPath = path.join(tmpDir, ".opencode", "package.json");
      const content = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      delete content.dependencies["@governance/core"];
      await fs.writeFile(pkgPath, JSON.stringify(content, null, 2), "utf-8");

      const checks = await doctor(projectArgs({ action: "doctor" }));
      const pkgCheck = checks.find((c) => c.file.includes("package.json"));
      expect(pkgCheck?.status).toBe("error");
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("doctor after uninstall reports all missing", async () => {
      await install(projectArgs());
      await uninstall(projectArgs({ action: "uninstall" }));
      const checks = await doctor(projectArgs({ action: "doctor" }));
      // Tool, plugin, commands should be missing (package.json still exists but modified)
      const missing = checks.filter((c) => c.status === "missing");
      expect(missing.length).toBeGreaterThanOrEqual(Object.keys(COMMANDS).length + 2);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("doctor completes in < 200ms", async () => {
      await install(projectArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await doctor(projectArgs({ action: "doctor" }));
      });
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});

// ─── formatResult / formatDoctor ──────────────────────────────────────────────

describe("cli/formatResult", () => {
  describe("HAPPY", () => {
    it("formats install result with summary lines", () => {
      const result: CliResult = {
        target: "/tmp/test",
        ops: [
          { path: "/tmp/test/a", action: "written" },
          { path: "/tmp/test/b", action: "merged" },
          { path: "/tmp/test/c", action: "skipped", reason: "already exists" },
        ],
        errors: [],
      };
      const output = formatResult(result);
      expect(output).toContain("Written: 1 files");
      expect(output).toContain("Merged:  1 files");
      expect(output).toContain("Skipped: 1 files");
      expect(output).toContain("already exists");
    });
  });

  describe("BAD", () => {
    it("formats errors when present", () => {
      const result: CliResult = {
        target: "/tmp/test",
        ops: [],
        errors: ["something broke"],
      };
      const output = formatResult(result);
      expect(output).toContain("[error]");
      expect(output).toContain("something broke");
    });
  });

  describe("CORNER", () => {
    it("handles empty ops and errors gracefully", () => {
      const result: CliResult = { target: "/tmp/test", ops: [], errors: [] };
      const output = formatResult(result);
      expect(typeof output).toBe("string");
    });
  });

  describe("EDGE", () => {
    it("formatDoctor shows ok/total counts", () => {
      const checks: DoctorCheck[] = [
        { file: "a.ts", status: "ok" },
        { file: "b.ts", status: "missing" },
        { file: "c.ts", status: "ok" },
      ];
      const output = formatDoctor(checks);
      expect(output).toContain("2/3 checks passed");
    });
  });

  describe("PERF", () => {
    it("formatting 100 ops is sub-millisecond", () => {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        path: `/tmp/file-${i}.ts`,
        action: "written" as const,
      }));
      const result: CliResult = { target: "/tmp", ops, errors: [] };
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        formatResult(result);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── main ─────────────────────────────────────────────────────────────────────

describe("cli/main", () => {
  describe("HAPPY", () => {
    it("returns 0 for successful install", async () => {
      const code = await main(["install", "--project"]);
      expect(code).toBe(0);
    });

    it("returns 0 for doctor after install", async () => {
      await main(["install", "--project"]);
      const code = await main(["doctor", "--project"]);
      expect(code).toBe(0);
    });
  });

  describe("BAD", () => {
    it("returns 1 for invalid args", async () => {
      const code = await main([]);
      expect(code).toBe(1);
    });

    it("returns 1 for unknown command", async () => {
      const code = await main(["deploy"]);
      expect(code).toBe(1);
    });
  });

  describe("CORNER", () => {
    it("returns 1 for doctor on empty directory", async () => {
      const code = await main(["doctor", "--project"]);
      expect(code).toBe(1);
    });
  });

  describe("EDGE", () => {
    it("uninstall returns 0 even if nothing was installed", async () => {
      const code = await main(["uninstall", "--project"]);
      expect(code).toBe(0);
    });
  });

  describe("PERF", () => {
    it("main dispatch overhead is negligible", async () => {
      const start = performance.now();
      await main(["install", "--project"]);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
