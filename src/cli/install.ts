#!/usr/bin/env node
/**
 * @module cli/install
 * @description CLI for installing/uninstalling governance into an OpenCode environment.
 *
 * Usage:
 *   npx @governance/core install  [--global|--project] [--mode solo|team|regulated] [--force]
 *   npx @governance/core uninstall [--global|--project]
 *   npx @governance/core doctor   [--global|--project]
 *
 * Targets:
 *   --global  (default)  ~/.config/opencode/
 *   --project            ./.opencode/ + ./opencode.json + ./AGENTS.md
 *
 * The installer writes thin wrappers that import from @governance/core.
 * All business logic lives in the npm package — wrappers are stable across
 * upgrades. `npm update @governance/core` is all that's needed to get new
 * features and fixes.
 *
 * Design:
 * - Idempotent: running install twice without --force skips existing files.
 * - Non-destructive: AGENTS.md is never overwritten (may contain user rules).
 * - Merge-aware: package.json and opencode.json are merged, not replaced.
 * - Uninstall removes only governance-owned files, never user content.
 *
 * @version v1
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  AGENTS_MD,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from "./templates";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Supported governance policy modes. */
export type PolicyMode = "solo" | "team" | "regulated";

/** CLI action. */
export type CliAction = "install" | "uninstall" | "doctor";

/** Parsed CLI arguments. */
export interface CliArgs {
  action: CliAction;
  global: boolean;
  mode: PolicyMode;
  force: boolean;
}

/** Result of a single file operation. */
export interface FileOp {
  path: string;
  action: "written" | "skipped" | "merged" | "removed" | "not_found";
  reason?: string;
}

/** Result of an install/uninstall/doctor run. */
export interface CliResult {
  target: string;
  ops: FileOp[];
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Current package version — injected at build time or read from package.json. */
const PACKAGE_VERSION = "1.1.0";

/** Files owned by governance that uninstall may remove. */
const GOVERNANCE_FILES = [
  "tools/governance.ts",
  "plugins/governance-audit.ts",
  ...Object.keys(COMMANDS).map((name) => `commands/${name}`),
] as const;

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the target directory for install/uninstall.
 *
 * @param global - If true, resolves to ~/.config/opencode/. Otherwise ./.opencode/.
 * @returns Absolute path to the target directory.
 */
export function resolveTarget(global: boolean): string {
  if (global) {
    return join(homedir(), ".config", "opencode");
  }
  return resolve(".opencode");
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

/**
 * Ensure a directory exists (recursive mkdir).
 * No-op if already present.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Safely read a file. Returns null if the file doesn't exist.
 */
async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Safely delete a file. Returns true if deleted, false if not found.
 */
async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file only if it doesn't exist or --force is set.
 */
async function writeIfAbsent(
  filePath: string,
  content: string,
  force: boolean,
): Promise<FileOp> {
  if (!force && existsSync(filePath)) {
    return { path: filePath, action: "skipped", reason: "already exists" };
  }
  const dir = dirname(filePath);
  if (dir) await ensureDir(dir);
  await writeFile(filePath, content, "utf-8");
  return { path: filePath, action: "written" };
}

// ─── JSON Merge Helpers ───────────────────────────────────────────────────────

/**
 * Merge governance dependencies into an existing or new package.json.
 *
 * Strategy:
 * - If file exists, parse it and add/update the @governance/core dependency.
 * - If file doesn't exist, write the template.
 * - Never removes existing dependencies.
 */
async function mergePackageJson(
  filePath: string,
  version: string,
): Promise<FileOp> {
  const existing = await safeRead(filePath);

  if (!existing) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), "utf-8");
    return { path: filePath, action: "written" };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    const deps = (parsed["dependencies"] ?? {}) as Record<string, string>;
    deps["@governance/core"] = `^${version}`;
    if (!deps["zod"]) deps["zod"] = "^3.23.0";
    if (!deps["@opencode-ai/plugin"]) deps["@opencode-ai/plugin"] = "latest";
    parsed["dependencies"] = deps;
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { path: filePath, action: "merged" };
  } catch {
    // Malformed JSON — overwrite with template
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), "utf-8");
    return { path: filePath, action: "written", reason: "existing file was malformed JSON" };
  }
}

/**
 * Merge governance config into an existing or new opencode.json.
 *
 * Strategy:
 * - If file exists, ensure "instructions" array includes "AGENTS.md".
 * - If file doesn't exist, write the template.
 * - Never removes existing config.
 */
async function mergeOpencodeJson(filePath: string): Promise<FileOp> {
  const existing = await safeRead(filePath);

  if (!existing) {
    const dir = dirname(filePath);
    if (dir) await ensureDir(dir);
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE, "utf-8");
    return { path: filePath, action: "written" };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    const instructions = Array.isArray(parsed["instructions"])
      ? (parsed["instructions"] as string[])
      : [];
    if (!instructions.includes("AGENTS.md")) {
      instructions.push("AGENTS.md");
      parsed["instructions"] = instructions;
    }
    if (!parsed["$schema"]) {
      parsed["$schema"] = "https://opencode.ai/config.json";
    }
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { path: filePath, action: "merged" };
  } catch {
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE, "utf-8");
    return { path: filePath, action: "written", reason: "existing file was malformed JSON" };
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Install governance into the target directory.
 *
 * Creates:
 * - tools/governance.ts (thin wrapper)
 * - plugins/governance-audit.ts (thin wrapper)
 * - commands/*.md (9 slash-command prompts)
 * - package.json (merged with governance deps)
 * - opencode.json (merged with instructions, project mode only)
 * - AGENTS.md (only if not present — never overwrites user rules)
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations and any errors.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.global);
  const ops: FileOp[] = [];
  const errors: string[] = [];

  try {
    // Ensure base directories
    await ensureDir(join(target, "tools"));
    await ensureDir(join(target, "plugins"));
    await ensureDir(join(target, "commands"));

    // 1. Tool wrapper
    ops.push(
      await writeIfAbsent(join(target, "tools", "governance.ts"), TOOL_WRAPPER, args.force),
    );

    // 2. Plugin wrapper
    ops.push(
      await writeIfAbsent(join(target, "plugins", "governance-audit.ts"), PLUGIN_WRAPPER, args.force),
    );

    // 3. Command files
    for (const [name, content] of Object.entries(COMMANDS)) {
      ops.push(
        await writeIfAbsent(join(target, "commands", name), content, args.force),
      );
    }

    // 4. package.json (merge)
    ops.push(await mergePackageJson(join(target, "package.json"), PACKAGE_VERSION));

    // 5. opencode.json (project mode only — global config at ~/.config/opencode/ may conflict)
    if (!args.global) {
      // For project mode, opencode.json goes in the project root (parent of .opencode/)
      const projectRoot = resolve(".");
      ops.push(await mergeOpencodeJson(join(projectRoot, "opencode.json")));
    } else {
      // For global mode, merge into ~/.config/opencode/opencode.json
      ops.push(await mergeOpencodeJson(join(target, "opencode.json")));
    }

    // 6. AGENTS.md (never overwrite)
    const agentsPath = args.global
      ? join(target, "AGENTS.md")
      : join(resolve("."), "AGENTS.md");
    ops.push(
      await writeIfAbsent(agentsPath, AGENTS_MD, false), // Never force — user content
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors };
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Uninstall governance from the target directory.
 *
 * Removes:
 * - tools/governance.ts
 * - plugins/governance-audit.ts
 * - commands/{hydrate,ticket,plan,...}.md (all 9)
 * - @governance/core from package.json dependencies
 *
 * Preserves:
 * - AGENTS.md (may contain user customizations)
 * - Other tools/plugins/commands in the same directories
 * - opencode.json (governance-specific entries are not critical to remove)
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations and any errors.
 */
export async function uninstall(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.global);
  const ops: FileOp[] = [];
  const errors: string[] = [];

  try {
    // Remove governance files
    for (const relPath of GOVERNANCE_FILES) {
      const fullPath = join(target, relPath);
      const removed = await safeUnlink(fullPath);
      ops.push({
        path: fullPath,
        action: removed ? "removed" : "not_found",
      });
    }

    // Remove @governance/core from package.json
    const pkgPath = join(target, "package.json");
    const pkgContent = await safeRead(pkgPath);
    if (pkgContent) {
      try {
        const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
        const deps = (parsed["dependencies"] ?? {}) as Record<string, string>;
        delete deps["@governance/core"];
        parsed["dependencies"] = deps;
        await writeFile(pkgPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
        ops.push({ path: pkgPath, action: "merged", reason: "removed @governance/core" });
      } catch {
        ops.push({ path: pkgPath, action: "skipped", reason: "malformed JSON" });
      }
    }

    // Note about AGENTS.md
    const agentsPath = args.global
      ? join(target, "AGENTS.md")
      : join(resolve("."), "AGENTS.md");
    if (existsSync(agentsPath)) {
      ops.push({
        path: agentsPath,
        action: "skipped",
        reason: "may contain custom rules — remove manually if no longer needed",
      });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors };
}

// ─── Doctor ───────────────────────────────────────────────────────────────────

/** Status of a single doctor check. */
export interface DoctorCheck {
  file: string;
  status: "ok" | "missing" | "modified" | "error";
  detail?: string;
}

/**
 * Verify the governance installation is correct and complete.
 *
 * Checks:
 * - All governance files exist
 * - Thin wrappers match expected content (not modified)
 * - package.json has @governance/core dependency
 * - AGENTS.md exists (content not checked — user may customize)
 *
 * @param args - Parsed CLI arguments.
 * @returns Array of check results.
 */
export async function doctor(args: CliArgs): Promise<DoctorCheck[]> {
  const target = resolveTarget(args.global);
  const checks: DoctorCheck[] = [];

  // Check tool wrapper
  const toolPath = join(target, "tools", "governance.ts");
  const toolContent = await safeRead(toolPath);
  if (!toolContent) {
    checks.push({ file: toolPath, status: "missing" });
  } else if (toolContent.trim() !== TOOL_WRAPPER.trim()) {
    checks.push({ file: toolPath, status: "modified", detail: "content differs from template" });
  } else {
    checks.push({ file: toolPath, status: "ok" });
  }

  // Check plugin wrapper
  const pluginPath = join(target, "plugins", "governance-audit.ts");
  const pluginContent = await safeRead(pluginPath);
  if (!pluginContent) {
    checks.push({ file: pluginPath, status: "missing" });
  } else if (pluginContent.trim() !== PLUGIN_WRAPPER.trim()) {
    checks.push({ file: pluginPath, status: "modified", detail: "content differs from template" });
  } else {
    checks.push({ file: pluginPath, status: "ok" });
  }

  // Check command files
  for (const [name, expectedContent] of Object.entries(COMMANDS)) {
    const cmdPath = join(target, "commands", name);
    const cmdContent = await safeRead(cmdPath);
    if (!cmdContent) {
      checks.push({ file: cmdPath, status: "missing" });
    } else if (cmdContent.trim() !== expectedContent.trim()) {
      checks.push({ file: cmdPath, status: "modified", detail: "content differs from template" });
    } else {
      checks.push({ file: cmdPath, status: "ok" });
    }
  }

  // Check package.json
  const pkgPath = join(target, "package.json");
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) {
    checks.push({ file: pkgPath, status: "missing" });
  } else {
    try {
      const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
      const deps = (parsed["dependencies"] ?? {}) as Record<string, string>;
      if (deps["@governance/core"]) {
        checks.push({ file: pkgPath, status: "ok" });
      } else {
        checks.push({ file: pkgPath, status: "error", detail: "missing @governance/core dependency" });
      }
    } catch {
      checks.push({ file: pkgPath, status: "error", detail: "malformed JSON" });
    }
  }

  // Check AGENTS.md
  const agentsPath = args.global
    ? join(target, "AGENTS.md")
    : join(resolve("."), "AGENTS.md");
  if (existsSync(agentsPath)) {
    checks.push({ file: agentsPath, status: "ok" });
  } else {
    checks.push({ file: agentsPath, status: "missing" });
  }

  return checks;
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_MODES: readonly PolicyMode[] = ["solo", "team", "regulated"] as const;
const VALID_ACTIONS: readonly CliAction[] = ["install", "uninstall", "doctor"] as const;

/**
 * Parse CLI arguments from process.argv.
 *
 * @param argv - Raw argv (typically process.argv.slice(2)).
 * @returns Parsed arguments, or null if invalid.
 */
export function parseArgs(argv: string[]): CliArgs | null {
  const action = argv[0] as CliAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return null;
  }

  let global = true;
  let mode: PolicyMode = "solo";
  let force = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--global":
        global = true;
        break;
      case "--project":
        global = false;
        break;
      case "--force":
        force = true;
        break;
      case "--mode": {
        const next = argv[i + 1];
        if (next && VALID_MODES.includes(next as PolicyMode)) {
          mode = next as PolicyMode;
          i++;
        } else {
          return null;
        }
        break;
      }
      default:
        // Unknown argument
        return null;
    }
  }

  return { action, global, mode, force };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

/**
 * Format a CliResult for human-readable console output.
 */
export function formatResult(result: CliResult): string {
  const lines: string[] = [];
  const written = result.ops.filter((o) => o.action === "written").length;
  const merged = result.ops.filter((o) => o.action === "merged").length;
  const skipped = result.ops.filter((o) => o.action === "skipped").length;
  const removed = result.ops.filter((o) => o.action === "removed").length;

  for (const op of result.ops) {
    const suffix = op.reason ? ` (${op.reason})` : "";
    lines.push(`  [${op.action}] ${op.path}${suffix}`);
  }

  lines.push("");
  if (written > 0) lines.push(`  Written: ${written} files`);
  if (merged > 0) lines.push(`  Merged:  ${merged} files`);
  if (skipped > 0) lines.push(`  Skipped: ${skipped} files`);
  if (removed > 0) lines.push(`  Removed: ${removed} files`);

  if (result.errors.length > 0) {
    lines.push("");
    for (const err of result.errors) {
      lines.push(`  [error] ${err}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format doctor check results for console output.
 */
export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    const suffix = check.detail ? ` — ${check.detail}` : "";
    const icon =
      check.status === "ok" ? "ok" :
      check.status === "missing" ? "MISSING" :
      check.status === "modified" ? "MODIFIED" : "ERROR";
    lines.push(`  [${icon}] ${check.file}${suffix}`);
  }

  const ok = checks.filter((c) => c.status === "ok").length;
  const total = checks.length;
  lines.push("");
  lines.push(`  ${ok}/${total} checks passed`);

  return lines.join("\n");
}

const USAGE = `\
Usage: governance <command> [options]

Commands:
  install     Install governance tools, plugins, and commands
  uninstall   Remove governance files (preserves AGENTS.md)
  doctor      Verify installation is correct and complete

Options:
  --global    Install to ~/.config/opencode/ (default)
  --project   Install to ./.opencode/ (project-local)
  --mode      Default policy mode: solo (default), team, regulated
  --force     Overwrite existing files

Examples:
  npx @governance/core install
  npx @governance/core install --project --mode regulated
  npx @governance/core uninstall --global
  npx @governance/core doctor
`;

/**
 * CLI main entry point.
 * Only executes when this file is run directly (not when imported for testing).
 */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args) {
    console.log(USAGE);
    return 1;
  }

  const targetLabel = args.global ? "~/.config/opencode/" : "./.opencode/";

  switch (args.action) {
    case "install": {
      console.log(`Installing governance to ${targetLabel}...`);
      console.log(`  Default policy mode: ${args.mode}`);
      console.log("");
      const result = await install(args);
      console.log(formatResult(result));
      if (result.errors.length > 0) return 1;
      console.log("");
      console.log(`  Run 'bun install' in ${targetLabel} to install dependencies.`);
      return 0;
    }

    case "uninstall": {
      console.log(`Uninstalling governance from ${targetLabel}...`);
      console.log("");
      const result = await uninstall(args);
      console.log(formatResult(result));
      return result.errors.length > 0 ? 1 : 0;
    }

    case "doctor": {
      console.log(`Checking governance installation at ${targetLabel}...`);
      console.log("");
      const checks = await doctor(args);
      console.log(formatDoctor(checks));
      const allOk = checks.every((c) => c.status === "ok");
      return allOk ? 0 : 1;
    }
  }
}

// Auto-run when executed directly
const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1]?.endsWith("install.js");

if (isDirectExecution) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
