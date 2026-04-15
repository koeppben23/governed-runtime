/**
 * @module cli/install.test
 * @description Tests for the FlowGuard CLI installer (install, uninstall, doctor).
 *
 * Uses real temp directories to exercise filesystem operations end-to-end.
 * All five test categories are covered: HAPPY, BAD, CORNER, EDGE, PERF.
 *
 * Architecture under test (v2):
 * - flowguard-mandates.md is a managed artifact (always replaced, digest-tracked).
 * - AGENTS.md is NEVER touched — it belongs to the user/project.
 * - opencode.json instructions reference flowguard-mandates.md (scope-dependent path).
 * - Legacy "AGENTS.md" instruction entries are migrated (removed) on install.
 * - parseArgs returns { args, deprecations } | null.
 * - CliResult includes warnings: string[].
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  resolveTarget,
  install,
  uninstall,
  doctor,
  sha256,
  computeMandatesDigest,
  formatResult,
  formatDoctor,
  main,
  type CliArgs,
  type CliResult,
  type DoctorCheck,
  type InstallScope,
} from "./install";
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  MANDATES_FILENAME,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  extractManagedBody,
  isManagedArtifact,
} from "./templates";
import { measureAsync } from "../test-policy";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Repo root derived from this test file's location (src/cli/install.test.ts).
 * Used by DEV_REPO_INVARIANTS tests to read the real repo filesystem,
 * independent of any cwd changes made by the installer test harness.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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

/** Default args for repo-scope install targeting the cwd-relative .opencode/. */
function repoArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: "install",
    installScope: "repo",
    policyMode: "solo",
    force: false,
    coreTarball: undefined,
    vendorDir: undefined,
    ...overrides,
  };
}

/** Default args for global-scope install (not used in FS tests due to homedir). */
function globalArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: "install",
    installScope: "global",
    policyMode: "solo",
    force: false,
    coreTarball: undefined,
    vendorDir: undefined,
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
      const result = parseArgs(["install"]);
      expect(result).not.toBeNull();
      expect(result!.args).toEqual({
        action: "install",
        installScope: "global",
        policyMode: "solo",
        force: false,
        coreTarball: undefined,
        vendorDir: undefined,
      });
      expect(result!.deprecations).toEqual([]);
    });

    it("parses 'install --install-scope repo'", () => {
      const result = parseArgs(["install", "--install-scope", "repo"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("repo");
      expect(result!.deprecations).toEqual([]);
    });

    it("parses 'install --policy-mode team'", () => {
      const result = parseArgs(["install", "--policy-mode", "team"]);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe("team");
    });

    it("parses 'install --policy-mode regulated --force'", () => {
      const result = parseArgs(["install", "--policy-mode", "regulated", "--force"]);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe("regulated");
      expect(result!.args.force).toBe(true);
    });

    it("parses 'install --core-tarball <path>'", () => {
      const result = parseArgs(["install", "--core-tarball", "/path/to/flowguard-core-1.3.0.tgz"]);
      expect(result).not.toBeNull();
      expect(result!.args.coreTarball).toBe("/path/to/flowguard-core-1.3.0.tgz");
    });

    it("parses 'install --core-tarball with all options'", () => {
      const result = parseArgs([
        "install",
        "--core-tarball", "./flowguard-core-1.3.0.tgz",
        "--install-scope", "repo",
        "--policy-mode", "regulated",
        "--vendor-dir", "./vendor",
        "--force",
      ]);
      expect(result).not.toBeNull();
      expect(result!.args.coreTarball).toBe("./flowguard-core-1.3.0.tgz");
      expect(result!.args.installScope).toBe("repo");
      expect(result!.args.policyMode).toBe("regulated");
      expect(result!.args.vendorDir).toBe("./vendor");
      expect(result!.args.force).toBe(true);
    });

    it("parses 'uninstall --install-scope global'", () => {
      const result = parseArgs(["uninstall", "--install-scope", "global"]);
      expect(result).not.toBeNull();
      expect(result!.args.action).toBe("uninstall");
      expect(result!.args.installScope).toBe("global");
    });

    it("parses 'doctor'", () => {
      const result = parseArgs(["doctor"]);
      expect(result).not.toBeNull();
      expect(result!.args.action).toBe("doctor");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("returns null for unknown action", () => {
      expect(parseArgs(["deploy"])).toBeNull();
    });

    it("returns null for --policy-mode without value", () => {
      expect(parseArgs(["install", "--policy-mode"])).toBeNull();
    });

    it("returns null for --policy-mode with invalid value", () => {
      expect(parseArgs(["install", "--policy-mode", "enterprise"])).toBeNull();
    });

    it("returns null for --install-scope without value", () => {
      expect(parseArgs(["install", "--install-scope"])).toBeNull();
    });

    it("returns null for --install-scope with invalid value", () => {
      expect(parseArgs(["install", "--install-scope", "cloud"])).toBeNull();
    });

    it("returns null for unknown flag", () => {
      expect(parseArgs(["install", "--verbose"])).toBeNull();
    });

    it("returns null for --mode without value (deprecated alias)", () => {
      expect(parseArgs(["install", "--mode"])).toBeNull();
    });

    it("returns null for --mode with invalid value (deprecated alias)", () => {
      expect(parseArgs(["install", "--mode", "enterprise"])).toBeNull();
    });

    it("returns null for --core-tarball without value", () => {
      expect(parseArgs(["install", "--core-tarball"])).toBeNull();
    });

    it("returns null for --vendor-dir without value", () => {
      expect(parseArgs(["install", "--vendor-dir"])).toBeNull();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("deprecated --global sets installScope to global with deprecation warning", () => {
      const result = parseArgs(["install", "--global"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("global");
      expect(result!.deprecations).toContain("--global is deprecated, use --install-scope global");
    });

    it("deprecated --project sets installScope to repo with deprecation warning", () => {
      const result = parseArgs(["install", "--project"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("repo");
      expect(result!.deprecations).toContain("--project is deprecated, use --install-scope repo");
    });

    it("deprecated --mode sets policyMode with deprecation warning", () => {
      const result = parseArgs(["install", "--mode", "team"]);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe("team");
      expect(result!.deprecations).toContain("--mode is deprecated, use --policy-mode");
    });

    it("--project then --global: last one wins (both deprecated)", () => {
      const result = parseArgs(["install", "--project", "--global"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("global");
      expect(result!.deprecations.length).toBe(2);
    });

    it("--global then --project: last one wins (both deprecated)", () => {
      const result = parseArgs(["install", "--global", "--project"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("repo");
    });

    it("all three policy modes are accepted via --policy-mode", () => {
      for (const mode of ["solo", "team", "regulated"] as const) {
        const result = parseArgs(["install", "--policy-mode", mode]);
        expect(result).not.toBeNull();
        expect(result!.args.policyMode).toBe(mode);
      }
    });

    it("both install scopes are accepted via --install-scope", () => {
      for (const scope of ["global", "repo"] as const) {
        const result = parseArgs(["install", "--install-scope", scope]);
        expect(result).not.toBeNull();
        expect(result!.args.installScope).toBe(scope);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("all three actions are accepted", () => {
      for (const action of ["install", "uninstall", "doctor"] as const) {
        const result = parseArgs([action]);
        expect(result).not.toBeNull();
        expect(result!.args.action).toBe(action);
      }
    });

    it("--force without --policy-mode still defaults to solo", () => {
      const result = parseArgs(["install", "--force"]);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe("solo");
      expect(result!.args.force).toBe(true);
    });

    it("mixing new and deprecated flags works", () => {
      const result = parseArgs(["install", "--install-scope", "repo", "--mode", "regulated", "--force"]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe("repo");
      expect(result!.args.policyMode).toBe("regulated");
      expect(result!.args.force).toBe(true);
      expect(result!.deprecations).toContain("--mode is deprecated, use --policy-mode");
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("parseArgs is sub-millisecond for complex flags", () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        parseArgs(["install", "--install-scope", "repo", "--policy-mode", "regulated", "--force"]);
      }
      const elapsed = performance.now() - start;
      // 1000 calls in < 50ms => < 0.05ms per call
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── DEV_REPO_INVARIANTS ──────────────────────────────────────────────────────
//
// These tests verify that the Core Library repo itself does NOT ship an
// active .opencode/ directory. The separation is:
//   - This repo: AGENTS.md as dev ruleset (OpenCode auto-loads from repo root)
//   - Installed product: flowguard-mandates.md + tools/plugins/commands
//     generated by the installer from templates.ts into the target directory
//
// .opencode/ is .gitignore'd so a local `npx flowguard install --install-scope repo`
// does not pollute the repo. All product artifacts are SSOT in templates.ts.
//
// These tests read the REAL repo filesystem via REPO_ROOT, not tmpDir.
// They are deliberately outside the beforeEach/afterEach scope that
// changes cwd to a temp directory.
// ──────────────────────────────────────────────────────────────────────────────

describe("DEV_REPO_INVARIANTS", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("AGENTS.md exists in repo root (dev ruleset)", () => {
      expect(existsSync(path.join(REPO_ROOT, "AGENTS.md"))).toBe(true);
    });

    it("opencode.json exists in repo root", () => {
      expect(existsSync(path.join(REPO_ROOT, "opencode.json"))).toBe(true);
    });

    it(".opencode/ is NOT tracked in git (install artifacts are not committed)", () => {
      // .opencode/ may exist locally (after `npx flowguard install --install-scope repo`)
      // but must never be committed. The .gitignore entry prevents this.
      const gitignorePath = path.join(REPO_ROOT, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);
      const gitignore = readFileSync(gitignorePath, "utf-8");
      expect(gitignore).toContain(".opencode/");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("opencode.json has empty instructions array (dev repo uses AGENTS.md, not installer path)", async () => {
      const content = await fs.readFile(
        path.join(REPO_ROOT, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.instructions).toEqual([]);
    });

    it("COMMANDS template covers all 10 slash commands", () => {
      const commandNames = Object.keys(COMMANDS);
      expect(commandNames).toHaveLength(10);
      // Verify all expected commands are present
      for (const expected of [
        "hydrate.md", "ticket.md", "plan.md", "continue.md", "implement.md",
        "validate.md", "review-decision.md", "review.md", "abort.md", "archive.md",
      ]) {
        expect(commandNames).toContain(expected);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("REPO_ROOT resolves to a directory containing package.json with name @flowguard/core", async () => {
      const content = await fs.readFile(
        path.join(REPO_ROOT, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe("@flowguard/core");
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("REPO_ROOT resolution is sub-millisecond", () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe("cli/resolveTarget", () => {
  describe("HAPPY", () => {
    it("global resolves to ~/.config/opencode", () => {
      const target = resolveTarget("global");
      expect(target).toContain(path.join(".config", "opencode"));
      expect(path.isAbsolute(target)).toBe(true);
    });

    it("repo resolves to .opencode in cwd", () => {
      const target = resolveTarget("repo");
      expect(target).toContain(".opencode");
      expect(path.isAbsolute(target)).toBe(true);
    });
  });

  describe("BAD", () => {
    it("global target starts with homedir", () => {
      const target = resolveTarget("global");
      expect(target.startsWith(os.homedir())).toBe(true);
    });
  });

  describe("CORNER", () => {
    it("repo target uses the current working directory", () => {
      const target = resolveTarget("repo");
      expect(target).toBe(path.resolve(".opencode"));
    });
  });

  describe("EDGE", () => {
    it("both scopes return absolute paths", () => {
      for (const scope of ["global", "repo"] as const) {
        expect(path.isAbsolute(resolveTarget(scope))).toBe(true);
      }
    });
  });

  describe("PERF", () => {
    it("resolveTarget is sub-millisecond", () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        resolveTarget("global");
        resolveTarget("repo");
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── crypto helpers ───────────────────────────────────────────────────────────

describe("cli/crypto", () => {
  describe("HAPPY", () => {
    it("sha256 returns 64-char hex string", () => {
      const digest = sha256("hello");
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("computeMandatesDigest returns consistent digest", () => {
      const d1 = computeMandatesDigest();
      const d2 = computeMandatesDigest();
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("BAD", () => {
    it("sha256 of empty string is valid", () => {
      const digest = sha256("");
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      // Known SHA-256 of empty string
      expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  describe("CORNER", () => {
    it("computeMandatesDigest matches sha256 of FLOWGUARD_MANDATES_BODY", () => {
      expect(computeMandatesDigest()).toBe(sha256(FLOWGUARD_MANDATES_BODY));
    });
  });

  describe("EDGE", () => {
    it("different inputs produce different digests", () => {
      expect(sha256("a")).not.toBe(sha256("b"));
    });
  });

  describe("PERF", () => {
    it("sha256 of mandates body completes in < 5ms", () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        sha256(FLOWGUARD_MANDATES_BODY);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500); // 100 iterations
    });
  });
});

// ─── templates helpers ────────────────────────────────────────────────────────

describe("cli/templates", () => {
  describe("HAPPY", () => {
    it("mandatesInstructionEntry returns bare filename for global", () => {
      expect(mandatesInstructionEntry("global")).toBe(MANDATES_FILENAME);
    });

    it("mandatesInstructionEntry returns .opencode/ prefixed for repo", () => {
      expect(mandatesInstructionEntry("repo")).toBe(`.opencode/${MANDATES_FILENAME}`);
    });

    it("buildMandatesContent includes version and digest in header", () => {
      const content = buildMandatesContent("2.0.0", "abcd1234".repeat(8));
      expect(content).toContain("@flowguard/core v2.0.0");
      expect(content).toContain("content-digest: sha256:");
      expect(content).toContain("# FlowGuard Mandates");
    });

    it("isManagedArtifact returns true for valid managed content", () => {
      const content = buildMandatesContent("2.0.0", computeMandatesDigest());
      expect(isManagedArtifact(content)).toBe(true);
    });

    it("extractManagedDigest returns correct digest", () => {
      const digest = computeMandatesDigest();
      const content = buildMandatesContent("2.0.0", digest);
      expect(extractManagedDigest(content)).toBe(digest);
    });

    it("extractManagedVersion returns correct version", () => {
      const content = buildMandatesContent("2.0.0", computeMandatesDigest());
      expect(extractManagedVersion(content)).toBe("2.0.0");
    });

    it("extractManagedBody returns the body without header", () => {
      const digest = computeMandatesDigest();
      const content = buildMandatesContent("2.0.0", digest);
      const body = extractManagedBody(content);
      expect(body).toBe(FLOWGUARD_MANDATES_BODY);
    });
  });

  describe("BAD", () => {
    it("isManagedArtifact returns false for plain markdown", () => {
      expect(isManagedArtifact("# Just a file\n")).toBe(false);
    });

    it("extractManagedDigest returns null for content without header", () => {
      expect(extractManagedDigest("# No header")).toBeNull();
    });

    it("extractManagedVersion returns null for content without header", () => {
      expect(extractManagedVersion("# No header")).toBeNull();
    });

    it("extractManagedBody returns null for content without header", () => {
      expect(extractManagedBody("# No header")).toBeNull();
    });
  });

  describe("CORNER", () => {
    it("LEGACY_INSTRUCTION_ENTRY is 'AGENTS.md'", () => {
      expect(LEGACY_INSTRUCTION_ENTRY).toBe("AGENTS.md");
    });

    it("MANDATES_FILENAME is 'flowguard-mandates.md'", () => {
      expect(MANDATES_FILENAME).toBe("flowguard-mandates.md");
    });
  });

  describe("EDGE", () => {
    it("buildMandatesContent body starts with # FlowGuard Mandates", () => {
      const content = buildMandatesContent("1.0.0", "a".repeat(64));
      // After the two header lines and a blank line, body starts
      const lines = content.split("\n");
      // Line 0: <!-- @flowguard/core ... -->
      // Line 1: <!-- content-digest: sha256:... -->
      // Line 2: (blank)
      // Line 3: # FlowGuard Mandates
      expect(lines[3]).toBe("# FlowGuard Mandates");
    });

    it("FLOWGUARD_MANDATES_BODY contains Hard Rules section with all 5 operative parts", () => {
      expect(FLOWGUARD_MANDATES_BODY).toContain("## 0. Hard Rules");
      expect(FLOWGUARD_MANDATES_BODY).toContain("### Top Priorities");
      expect(FLOWGUARD_MANDATES_BODY).toContain("### Stop Conditions");
      expect(FLOWGUARD_MANDATES_BODY).toContain("### Evidence Requirements");
      expect(FLOWGUARD_MANDATES_BODY).toContain("### Approval Blockers");
      expect(FLOWGUARD_MANDATES_BODY).toContain("### Ambiguity Protocol");
    });

    it("Hard Rules section appears before Developer Mandate", () => {
      const hardRulesIdx = FLOWGUARD_MANDATES_BODY.indexOf("## 0. Hard Rules");
      const devMandateIdx = FLOWGUARD_MANDATES_BODY.indexOf("## 1. Developer Mandate");
      expect(hardRulesIdx).toBeGreaterThan(-1);
      expect(devMandateIdx).toBeGreaterThan(-1);
      expect(hardRulesIdx).toBeLessThan(devMandateIdx);
    });

    it("FLOWGUARD_MANDATES_BODY does not reference AGENTS.md", () => {
      expect(FLOWGUARD_MANDATES_BODY).not.toContain("AGENTS.md");
    });
  });

  describe("PERF", () => {
    it("buildMandatesContent completes in < 5ms per call", () => {
      const digest = computeMandatesDigest();
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        buildMandatesContent("2.0.0", digest);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});

// ─── install ──────────────────────────────────────────────────────────────────

describe("cli/install", () => {
  // Helper: create a mock tarball for testing
  async function createMockTarball(version = "1.3.0"): Promise<string> {
    const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
    await fs.writeFile(tarballPath, "mock tarball content");
    return tarballPath;
  }

  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("creates all FlowGuard files in repo scope with --core-tarball", async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);

      const oc = path.join(tmpDir, ".opencode");
      // flowguard-mandates.md
      expect(existsSync(path.join(oc, MANDATES_FILENAME))).toBe(true);
      // Tool wrapper
      expect(existsSync(path.join(oc, "tools", "flowguard.ts"))).toBe(true);
      // Plugin wrapper
      expect(existsSync(path.join(oc, "plugins", "flowguard-audit.ts"))).toBe(true);
      // Command files
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, "commands", name))).toBe(true);
      }
      // package.json
      expect(existsSync(path.join(oc, "package.json"))).toBe(true);
      // opencode.json in project root
      expect(existsSync(path.join(tmpDir, "opencode.json"))).toBe(true);
      // vendor directory with tarball
      expect(existsSync(path.join(oc, "vendor", "flowguard-core-1.3.0.tgz"))).toBe(true);
    });

    it("copies tarball to vendor directory", async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);

      const vendorPath = path.join(tmpDir, ".opencode", "vendor", "flowguard-core-1.3.0.tgz");
      expect(existsSync(vendorPath)).toBe(true);
      const content = await fs.readFile(vendorPath, "utf-8");
      expect(content).toBe("mock tarball content");
    });

    it("package.json uses @flowguard/opencode-runtime with file:-dependency", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe("@flowguard/opencode-runtime");
      expect(parsed.private).toBe(true);
      expect(parsed.dependencies["@flowguard/core"]).toBe("file:./vendor/flowguard-core-1.3.0.tgz");
      expect(parsed.dependencies["zod"]).toBeDefined();
    });

    it("flowguard-mandates.md is a valid managed artifact", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", MANDATES_FILENAME),
        "utf-8",
      );
      expect(isManagedArtifact(content)).toBe(true);
      expect(extractManagedDigest(content)).toBe(computeMandatesDigest());
      expect(extractManagedVersion(content)).toBeDefined();
    });

    it("tool wrapper content matches template", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "tools", "flowguard.ts"),
        "utf-8",
      );
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it("plugin wrapper content matches template", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "plugins", "flowguard-audit.ts"),
        "utf-8",
      );
      expect(content.trim()).toBe(PLUGIN_WRAPPER.trim());
    });

    it("package.json contains @flowguard/core and zod but NOT @opencode-ai/plugin", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@flowguard/core"]).toBeDefined();
      expect(parsed.dependencies["zod"]).toBeDefined();
      expect(parsed.dependencies["@opencode-ai/plugin"]).toBeUndefined();
    });

    it("opencode.json includes flowguard-mandates.md instruction (repo scope)", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.instructions).toContain(mandatesInstructionEntry("repo"));
    });

    it("AGENTS.md is NOT created by install", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      expect(existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(false);
    });

    it("opencode.json does NOT contain legacy AGENTS.md entry", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.instructions).not.toContain(LEGACY_INSTRUCTION_ENTRY);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("install without --core-tarball returns error", async () => {
      const result = await install(repoArgs());
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("--core-tarball is required");
    });

    it("install with non-existent tarball returns error", async () => {
      const result = await install(repoArgs({
        coreTarball: "/nonexistent/flowguard-core-1.3.0.tgz",
      }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("not found");
    });

    it("install with invalid tarball filename returns error", async () => {
      const invalidTarball = path.join(tmpDir, "invalid-name.tgz");
      await fs.writeFile(invalidTarball, "content");
      const result = await install(repoArgs({ coreTarball: invalidTarball }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("must match flowguard-core-");
    });

    it("install with version mismatch returns error", async () => {
      const tarball = await createMockTarball("2.0.0");
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Version mismatch");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("idempotent: second install skips existing wrappers (no --force)", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const result2 = await install(repoArgs({ coreTarball: tarball }));
      // Tool and plugin should be skipped (already exist, no --force)
      const skipped = result2.ops.filter((op) => op.action === "skipped");
      expect(skipped.length).toBeGreaterThan(0);
    });

    it("flowguard-mandates.md is ALWAYS replaced even without --force", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, ".opencode", MANDATES_FILENAME);
      // Tamper with the file
      await fs.writeFile(mandatesPath, "# Tampered", "utf-8");

      // Re-install without --force
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(mandatesPath, "utf-8");
      expect(isManagedArtifact(content)).toBe(true);
      expect(content).toContain("# FlowGuard Mandates");
    });

    it("--force overwrites existing tool wrapper", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Modify the tool wrapper
      const toolPath = path.join(tmpDir, ".opencode", "tools", "flowguard.ts");
      await fs.writeFile(toolPath, "// modified", "utf-8");

      // Re-install with --force
      const result = await install(repoArgs({ coreTarball: tarball, force: true }));
      const toolOp = result.ops.find((op) => op.path.includes("flowguard.ts") && op.path.includes("tools"));
      expect(toolOp?.action).toBe("written");

      // Content should be restored
      const content = await fs.readFile(toolPath, "utf-8");
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it("merges into existing package.json without removing other deps", async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } }, null, 2),
        "utf-8",
      );

      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      // Original dep preserved
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
      // FlowGuard dep added
      expect(parsed.dependencies["@flowguard/core"]).toBeDefined();
    });

    it("merges into existing opencode.json without removing other config", async () => {
      const tarball = await createMockTarball();
      // Create an opencode.json with custom config
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify({ model: "claude-4-opus" }, null, 2),
        "utf-8",
      );

      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      // Original config preserved
      expect(parsed.model).toBe("claude-4-opus");
      // instructions added with correct entry
      expect(parsed.instructions).toContain(mandatesInstructionEntry("repo"));
    });

    it("AGENTS.md in project root is never touched even with --force", async () => {
      const tarball = await createMockTarball();
      // Create a custom AGENTS.md
      const agentsPath = path.join(tmpDir, "AGENTS.md");
      await fs.writeFile(agentsPath, "# My Custom Rules\n", "utf-8");

      await install(repoArgs({ coreTarball: tarball, force: true }));
      const content = await fs.readFile(agentsPath, "utf-8");
      // Should still be the user's content — install never touches AGENTS.md
      expect(content).toBe("# My Custom Rules\n");
    });

    it("custom --vendor-dir places tarball in specified location", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball, vendorDir: "custom-vendor" }));

      expect(existsSync(path.join(tmpDir, ".opencode", "custom-vendor", "flowguard-core-1.3.0.tgz"))).toBe(true);
    });

    it("supports relative tarball path", async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: "./flowguard-core-1.3.0.tgz" }));
      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, ".opencode", "vendor", "flowguard-core-1.3.0.tgz"))).toBe(true);
    });

    it("handles malformed package.json by overwriting", async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        "{ this is not valid json }}}",
        "utf-8",
      );

      const result = await install(repoArgs({ coreTarball: tarball }));
      const pkgOp = result.ops.find((op) => op.path.includes("package.json"));
      expect(pkgOp?.action).toBe("written");
      expect(pkgOp?.reason).toContain("malformed");
    });

    it("handles malformed opencode.json by overwriting", async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        "not json at all{{{",
        "utf-8",
      );

      const result = await install(repoArgs({ coreTarball: tarball }));
      const ocOp = result.ops.find((op) => op.path.includes("opencode.json"));
      expect(ocOp?.action).toBe("written");
      expect(ocOp?.reason).toContain("malformed");
    });

    it("legacy migration: removes AGENTS.md from opencode.json instructions", async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify({
          instructions: ["AGENTS.md", "other-instructions.md"],
        }, null, 2),
        "utf-8",
      );

      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.instructions).not.toContain("AGENTS.md");
      expect(parsed.instructions).toContain("other-instructions.md");
      expect(parsed.instructions).toContain(mandatesInstructionEntry("repo"));
    });

    it("removes legacy @opencode-ai/plugin from existing package.json", async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          dependencies: { "@opencode-ai/plugin": "^1.0.0", lodash: "^4.0.0" },
        }, null, 2),
        "utf-8",
      );

      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@opencode-ai/plugin"]).toBeUndefined();
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
      expect(parsed.dependencies["@flowguard/core"]).toBeDefined();
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("opencode.json does not duplicate instruction entry on re-install", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await install(repoArgs({ coreTarball: tarball }));

      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      const entry = mandatesInstructionEntry("repo");
      const count = (parsed.instructions as string[]).filter(
        (i: string) => i === entry,
      ).length;
      expect(count).toBe(1);
    });

    it("result ops include every written/merged file", async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      const commandCount = Object.keys(COMMANDS).length;
      // 1 tarball + 1 mandates + 1 tool + 1 plugin + N commands + 1 package.json + 1 opencode.json
      const expectedOps = 1 + 1 + 1 + 1 + commandCount + 1 + 1;
      expect(result.ops.length).toBe(expectedOps);
    });

    it("user entries in opencode.json instructions are preserved in order", async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify({
          instructions: ["first.md", "second.md", "third.md"],
        }, null, 2),
        "utf-8",
      );

      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      const instructions = parsed.instructions as string[];
      const firstIdx = instructions.indexOf("first.md");
      const secondIdx = instructions.indexOf("second.md");
      const thirdIdx = instructions.indexOf("third.md");
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
      expect(instructions).toContain(mandatesInstructionEntry("repo"));
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("full install completes in < 500ms", async () => {
      const tarball = await createMockTarball();
      const { elapsedMs } = await measureAsync(async () => {
        await install(repoArgs({ coreTarball: tarball }));
      });
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});

// ─── uninstall ────────────────────────────────────────────────────────────────

describe("cli/uninstall", () => {
  // Helper: create a mock tarball for uninstall tests
  async function createMockTarball(version = "1.3.0"): Promise<string> {
    const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
    await fs.writeFile(tarballPath, "mock tarball content");
    return tarballPath;
  }

  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("removes FlowGuard files after install", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const result = await uninstall(repoArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);

      const oc = path.join(tmpDir, ".opencode");
      // flowguard-mandates.md removed
      expect(existsSync(path.join(oc, MANDATES_FILENAME))).toBe(false);
      // Tool and plugin removed
      expect(existsSync(path.join(oc, "tools", "flowguard.ts"))).toBe(false);
      expect(existsSync(path.join(oc, "plugins", "flowguard-audit.ts"))).toBe(false);
      // Command files removed
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, "commands", name))).toBe(false);
      }
      // Vendor directory removed
      expect(existsSync(path.join(oc, "vendor"))).toBe(false);
    });

    it("removes @flowguard/core from package.json", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: "uninstall" }));

      const content = await fs.readFile(
        path.join(tmpDir, ".opencode", "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@flowguard/core"]).toBeUndefined();
    });

    it("removes FlowGuard instruction from opencode.json", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: "uninstall" }));

      const content = await fs.readFile(
        path.join(tmpDir, "opencode.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      const entry = mandatesInstructionEntry("repo");
      expect(parsed.instructions).not.toContain(entry);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("uninstall on empty dir returns not_found ops, no errors", async () => {
      const result = await uninstall(repoArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);
      const notFound = result.ops.filter((op) => op.action === "not_found");
      expect(notFound.length).toBeGreaterThan(0);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("uninstall preserves other dependencies in package.json", async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } }, null, 2),
        "utf-8",
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: "uninstall" }));

      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
      expect(parsed.dependencies["@flowguard/core"]).toBeUndefined();
    });

    it("AGENTS.md in project root is never touched by uninstall", async () => {
      const tarball = await createMockTarball();
      // Create a user AGENTS.md
      const agentsPath = path.join(tmpDir, "AGENTS.md");
      await fs.writeFile(agentsPath, "# User rules\n", "utf-8");

      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: "uninstall" }));

      // AGENTS.md should still exist and be unmodified
      expect(existsSync(agentsPath)).toBe(true);
      const content = await fs.readFile(agentsPath, "utf-8");
      expect(content).toBe("# User rules\n");
    });

    it("warns when flowguard-mandates.md was locally modified", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Tamper with mandates but keep the managed header
      const mandatesPath = path.join(tmpDir, ".opencode", MANDATES_FILENAME);
      const original = await fs.readFile(mandatesPath, "utf-8");
      await fs.writeFile(mandatesPath, original + "\n# Extra stuff\n", "utf-8");

      const result = await uninstall(repoArgs({ action: "uninstall" }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("modified");
    });

    it("warns when flowguard-mandates.md has no managed header", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, ".opencode", MANDATES_FILENAME);
      await fs.writeFile(mandatesPath, "# Just a plain file\n", "utf-8");

      const result = await uninstall(repoArgs({ action: "uninstall" }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("no managed header");
    });

    it("uninstall removes legacy @opencode-ai/plugin from package.json", async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, ".opencode");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          dependencies: {
            "@flowguard/core": "^2.0.0",
            "@opencode-ai/plugin": "^1.0.0",
            lodash: "^4.0.0",
          },
        }, null, 2),
        "utf-8",
      );

      await uninstall(repoArgs({ action: "uninstall" }));
      const content = await fs.readFile(
        path.join(pkgDir, "package.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.dependencies["@flowguard/core"]).toBeUndefined();
      expect(parsed.dependencies["@opencode-ai/plugin"]).toBeUndefined();
      expect(parsed.dependencies.lodash).toBe("^4.0.0");
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("double uninstall is safe", async () => {
      await install(repoArgs());
      await uninstall(repoArgs({ action: "uninstall" }));
      const result = await uninstall(repoArgs({ action: "uninstall" }));
      expect(result.errors).toEqual([]);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("uninstall completes in < 200ms", async () => {
      await install(repoArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await uninstall(repoArgs({ action: "uninstall" }));
      });
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});

// ─── doctor ───────────────────────────────────────────────────────────────────

describe("cli/doctor", () => {
  // Helper: create a mock tarball for testing
  async function createMockTarball(version = "1.3.0"): Promise<string> {
    const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
    await fs.writeFile(tarballPath, "mock tarball content");
    return tarballPath;
  }

  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("all checks pass after fresh install", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const checks = await doctor(repoArgs({ action: "doctor" }));
      const allOk = checks.every((c) => c.status === "ok");
      expect(allOk).toBe(true);
    });

    it("returns correct check count", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const checks = await doctor(repoArgs({ action: "doctor" }));
      // 1 mandates + 1 tool + 1 plugin + N commands + 1 package.json + 1 opencode.json + 1 config
      const expectedChecks = 1 + 1 + 1 + Object.keys(COMMANDS).length + 1 + 1 + 1;
      expect(checks.length).toBe(expectedChecks);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("reports missing files on empty dir", async () => {
      const checks = await doctor(repoArgs({ action: "doctor" }));
      const missing = checks.filter((c) => c.status === "missing");
      expect(missing.length).toBeGreaterThan(0);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("detects modified tool wrapper", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const toolPath = path.join(tmpDir, ".opencode", "tools", "flowguard.ts");
      await fs.writeFile(toolPath, "// tampered content", "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const toolCheck = checks.find((c) => c.file.includes("flowguard.ts") && c.file.includes("tools"));
      expect(toolCheck?.status).toBe("modified");
    });

    it("detects modified flowguard-mandates.md (digest mismatch)", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, ".opencode", MANDATES_FILENAME);
      const original = await fs.readFile(mandatesPath, "utf-8");
      // Tamper with body but keep header intact
      await fs.writeFile(mandatesPath, original + "\n# Extra section\n", "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const mandatesCheck = checks.find((c) => c.file.includes(MANDATES_FILENAME));
      expect(mandatesCheck?.status).toBe("modified");
      expect(mandatesCheck?.detail).toContain("digest mismatch");
    });

    it("detects unmanaged flowguard-mandates.md (no header)", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, ".opencode", MANDATES_FILENAME);
      await fs.writeFile(mandatesPath, "# Just a plain file\n", "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const mandatesCheck = checks.find((c) => c.file.includes(MANDATES_FILENAME));
      expect(mandatesCheck?.status).toBe("unmanaged");
    });

    it("detects missing @flowguard/core in package.json", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const pkgPath = path.join(tmpDir, ".opencode", "package.json");
      const content = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      delete content.dependencies["@flowguard/core"];
      await fs.writeFile(pkgPath, JSON.stringify(content, null, 2), "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const pkgCheck = checks.find((c) => c.file.includes("package.json"));
      expect(pkgCheck?.status).toBe("error");
    });

    it("detects instruction_missing in opencode.json", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Remove FlowGuard entry from instructions
      const ocPath = path.join(tmpDir, "opencode.json");
      const content = JSON.parse(await fs.readFile(ocPath, "utf-8"));
      content.instructions = ["other-stuff.md"];
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const ocCheck = checks.find((c) =>
        c.file.includes("opencode.json") && c.status === "instruction_missing",
      );
      expect(ocCheck).toBeDefined();
      expect(ocCheck?.detail).toContain(mandatesInstructionEntry("repo"));
    });

    it("detects instruction_stale (legacy AGENTS.md entry)", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Add legacy entry to instructions
      const ocPath = path.join(tmpDir, "opencode.json");
      const content = JSON.parse(await fs.readFile(ocPath, "utf-8"));
      content.instructions.push(LEGACY_INSTRUCTION_ENTRY);
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), "utf-8");

      const checks = await doctor(repoArgs({ action: "doctor" }));
      const staleCheck = checks.find((c) =>
        c.file.includes("opencode.json") && c.status === "instruction_stale",
      );
      expect(staleCheck).toBeDefined();
      expect(staleCheck?.detail).toContain("AGENTS.md");
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe("EDGE", () => {
    it("doctor after uninstall reports all missing", async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: "uninstall" }));
      const checks = await doctor(repoArgs({ action: "doctor" }));
      // mandates, tool, plugin, commands should be missing
      const missing = checks.filter((c) => c.status === "missing");
      expect(missing.length).toBeGreaterThanOrEqual(Object.keys(COMMANDS).length + 3);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("doctor completes in < 200ms", async () => {
      await install(repoArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await doctor(repoArgs({ action: "doctor" }));
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
        warnings: [],
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
        warnings: [],
      };
      const output = formatResult(result);
      expect(output).toContain("[error]");
      expect(output).toContain("something broke");
    });
  });

  describe("CORNER", () => {
    it("handles empty ops, errors, and warnings gracefully", () => {
      const result: CliResult = { target: "/tmp/test", ops: [], errors: [], warnings: [] };
      const output = formatResult(result);
      expect(typeof output).toBe("string");
    });

    it("formats warnings when present", () => {
      const result: CliResult = {
        target: "/tmp/test",
        ops: [],
        errors: [],
        warnings: ["something was modified"],
      };
      const output = formatResult(result);
      expect(output).toContain("[warn]");
      expect(output).toContain("something was modified");
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

    it("formatDoctor shows status labels for all statuses", () => {
      const checks: DoctorCheck[] = [
        { file: "a", status: "ok" },
        { file: "b", status: "missing" },
        { file: "c", status: "modified", detail: "digest mismatch" },
        { file: "d", status: "unmanaged" },
        { file: "e", status: "version_mismatch", detail: "v1 != v2" },
        { file: "f", status: "instruction_missing" },
        { file: "g", status: "instruction_stale" },
        { file: "h", status: "error", detail: "malformed" },
      ];
      const output = formatDoctor(checks);
      expect(output).toContain("[ok]");
      expect(output).toContain("[MISSING]");
      expect(output).toContain("[MODIFIED]");
      expect(output).toContain("[UNMANAGED]");
      expect(output).toContain("[VERSION]");
      expect(output).toContain("[INSTR_MISSING]");
      expect(output).toContain("[INSTR_STALE]");
      expect(output).toContain("[ERROR]");
    });
  });

  describe("PERF", () => {
    it("formatting 100 ops is sub-millisecond", () => {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        path: `/tmp/file-${i}.ts`,
        action: "written" as const,
      }));
      const result: CliResult = { target: "/tmp", ops, errors: [], warnings: [] };
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
  // Helper: create a mock tarball for testing
  async function createMockTarball(version = "1.3.0"): Promise<string> {
    const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
    await fs.writeFile(tarballPath, "mock tarball content");
    return tarballPath;
  }

  describe("HAPPY", () => {
    it("returns 0 for successful install (repo scope)", async () => {
      const tarball = await createMockTarball();
      const code = await main(["install", "--install-scope", "repo", "--core-tarball", tarball]);
      expect(code).toBe(0);
    });

    it("returns 0 for doctor after install (repo scope)", async () => {
      const tarball = await createMockTarball();
      await main(["install", "--install-scope", "repo", "--core-tarball", tarball]);
      const code = await main(["doctor", "--install-scope", "repo"]);
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

    it("returns 1 when install is called without --core-tarball", async () => {
      const code = await main(["install", "--install-scope", "repo"]);
      expect(code).toBe(1);
    });
  });

  describe("CORNER", () => {
    it("returns 1 for doctor on empty directory (repo scope)", async () => {
      const code = await main(["doctor", "--install-scope", "repo"]);
      expect(code).toBe(1);
    });

    it("deprecated --project still works via main() but requires --core-tarball", async () => {
      const tarball = await createMockTarball();
      const code = await main(["install", "--project", "--core-tarball", tarball]);
      expect(code).toBe(0);
    });
  });

  describe("EDGE", () => {
    it("uninstall returns 0 even if nothing was installed (repo scope)", async () => {
      const code = await main(["uninstall", "--install-scope", "repo"]);
      expect(code).toBe(0);
    });
  });

  describe("PERF", () => {
    it("main dispatch overhead is negligible", async () => {
      const tarball = await createMockTarball();
      const start = performance.now();
      await main(["install", "--install-scope", "repo", "--core-tarball", tarball]);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
