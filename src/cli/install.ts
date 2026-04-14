#!/usr/bin/env node
/**
 * @module cli/install
 * @description CLI for installing/uninstalling FlowGuard into an OpenCode environment.
 *
 * Usage:
 *   npx @flowguard/core install  [--install-scope global|repo] [--policy-mode solo|team|regulated] [--force]
 *   npx @flowguard/core uninstall [--install-scope global|repo]
 *   npx @flowguard/core doctor   [--install-scope global|repo]
 *
 * Install scopes:
 *   --install-scope global  (default)  ~/.config/opencode/  — nothing in the customer repo
 *   --install-scope repo               ./.opencode/         — FlowGuard layer committed to repo
 *
 * Deprecated aliases (still work, emit warning):
 *   --global  → --install-scope global
 *   --project → --install-scope repo
 *   --mode X  → --policy-mode X
 *
 * Architecture:
 * - flowguard-mandates.md is a managed artifact: always replaced on install, digest-checked by doctor.
 * - AGENTS.md is NEVER touched — it belongs to the user/project (OpenCode's instruction slot).
 * - Thin wrappers (tools, plugins, commands) import from @flowguard/core.
 * - opencode.json is merge-managed: FlowGuard instruction entry added, legacy entries migrated.
 *
 * Ownership matrix:
 *   hard-managed:   flowguard-mandates.md, tools/*.ts, plugins/*.ts, commands/*.md
 *   merge-managed:  package.json, opencode.json
 *   user-owned:     AGENTS.md (never touched)
 *
 * @version v2
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  MANDATES_FILENAME,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  extractManagedBody,
  isManagedArtifact,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
} from "./templates";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Install scope: where FlowGuard artifacts are placed. */
export type InstallScope = "global" | "repo";

/** FlowGuard policy mode (runtime behavior, NOT install location). */
export type PolicyMode = "solo" | "team" | "regulated";

/** CLI action. */
export type CliAction = "install" | "uninstall" | "doctor";

/** Parsed CLI arguments. */
export interface CliArgs {
  action: CliAction;
  installScope: InstallScope;
  policyMode: PolicyMode;
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
  warnings: string[];
}

/** Extended doctor check status for managed artifacts. */
export type DoctorStatus =
  | "ok"
  | "missing"
  | "modified"
  | "unmanaged"
  | "version_mismatch"
  | "instruction_missing"
  | "instruction_stale"
  | "error";

/** Status of a single doctor check. */
export interface DoctorCheck {
  file: string;
  status: DoctorStatus;
  detail?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Current package version — injected at build time or read from package.json. */
const PACKAGE_VERSION = "2.0.0";

/** Files owned by FlowGuard that uninstall may remove. */
const FLOWGUARD_OWNED_FILES = [
  MANDATES_FILENAME,
  "tools/flowguard.ts",
  "plugins/flowguard-audit.ts",
  ...Object.keys(COMMANDS).map((name) => `commands/${name}`),
] as const;

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the target directory for install/uninstall.
 *
 * @param scope - "global" resolves to ~/.config/opencode/. "repo" resolves to ./.opencode/.
 * @returns Absolute path to the target directory.
 */
export function resolveTarget(scope: InstallScope): string {
  if (scope === "global") {
    return join(homedir(), ".config", "opencode");
  }
  return resolve(".opencode");
}

// ─── Crypto Helpers ───────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Compute the canonical digest for flowguard-mandates.md body.
 * This is the digest stored in the managed-artifact header.
 */
export function computeMandatesDigest(): string {
  return sha256(FLOWGUARD_MANDATES_BODY);
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
 * Used for hard-managed artifacts OTHER than flowguard-mandates.md
 * (which is always replaced).
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
 * Merge FlowGuard dependencies into an existing or new package.json.
 *
 * Strategy:
 * - If file exists, parse it and add/update the @flowguard/core dependency.
 * - If file doesn't exist, write the template.
 * - Never removes existing dependencies.
 * - Removes legacy @opencode-ai/plugin dependency if present (no longer needed).
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
    deps["@flowguard/core"] = `^${version}`;
    if (!deps["zod"]) deps["zod"] = "^3.23.0";
    // Remove legacy dependency that is no longer needed
    delete deps["@opencode-ai/plugin"];
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
 * Merge FlowGuard config into an existing or new opencode.json.
 *
 * Invariants (idempotent, enforced after every call):
 * 1. instructions array contains exactly 1x the scope-appropriate mandate entry
 * 2. instructions array does NOT contain the legacy "AGENTS.md" entry
 * 3. Order of existing user entries is preserved
 * 4. All other fields in opencode.json are preserved
 * 5. $schema is set if missing
 *
 * @param filePath - Path to opencode.json
 * @param scope    - Install scope (determines the instruction entry path)
 */
async function mergeOpencodeJson(
  filePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const entry = mandatesInstructionEntry(scope);
  const existing = await safeRead(filePath);

  if (!existing) {
    const dir = dirname(filePath);
    if (dir) await ensureDir(dir);
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), "utf-8");
    return { path: filePath, action: "written" };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    let instructions = Array.isArray(parsed["instructions"])
      ? (parsed["instructions"] as string[])
      : [];

    // Migration: remove legacy "AGENTS.md" entry (only the exact FlowGuard-owned one)
    instructions = instructions.filter((i) => i !== LEGACY_INSTRUCTION_ENTRY);

    // Deduplicate: remove our entry if already present, then add exactly once
    instructions = instructions.filter((i) => i !== entry);
    instructions.push(entry);

    parsed["instructions"] = instructions;

    if (!parsed["$schema"]) {
      parsed["$schema"] = "https://opencode.ai/config.json";
    }
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { path: filePath, action: "merged" };
  } catch {
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), "utf-8");
    return { path: filePath, action: "written", reason: "existing file was malformed JSON" };
  }
}

/**
 * Remove FlowGuard instruction entries from opencode.json during uninstall.
 * Removes both current and legacy entries. Preserves everything else.
 */
async function removeFromOpencodeJson(
  filePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) {
    return { path: filePath, action: "not_found" };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    if (!Array.isArray(parsed["instructions"])) {
      return { path: filePath, action: "skipped", reason: "no instructions array" };
    }

    const entry = mandatesInstructionEntry(scope);
    const before = parsed["instructions"] as string[];
    const after = before.filter(
      (i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY,
    );

    if (after.length === before.length) {
      return { path: filePath, action: "skipped", reason: "no FlowGuard entries found" };
    }

    parsed["instructions"] = after;
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return { path: filePath, action: "merged", reason: "removed FlowGuard instruction entries" };
  } catch {
    return { path: filePath, action: "skipped", reason: "malformed JSON" };
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Install FlowGuard into the target directory.
 *
 * Ownership semantics:
 * - flowguard-mandates.md: ALWAYS replaced (hard-managed, versioned, digest-tracked)
 * - tools/plugins/commands: write if absent, --force to replace (hard-managed)
 * - package.json: merge (merge-managed)
 * - opencode.json: merge with migration (merge-managed)
 * - AGENTS.md: NEVER touched (user-owned)
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations, warnings, and any errors.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.installScope);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Ensure base directories
    await ensureDir(join(target, "tools"));
    await ensureDir(join(target, "plugins"));
    await ensureDir(join(target, "commands"));

    // 1. flowguard-mandates.md (always replace — managed artifact)
    const digest = computeMandatesDigest();
    const mandatesContent = buildMandatesContent(PACKAGE_VERSION, digest);
    const mandatesPath = join(target, MANDATES_FILENAME);
    await ensureDir(dirname(mandatesPath));
    await writeFile(mandatesPath, mandatesContent, "utf-8");
    ops.push({ path: mandatesPath, action: "written" });

    // 2. Tool wrapper (write if absent, --force to replace)
    ops.push(
      await writeIfAbsent(join(target, "tools", "flowguard.ts"), TOOL_WRAPPER, args.force),
    );

    // 3. Plugin wrapper (write if absent, --force to replace)
    ops.push(
      await writeIfAbsent(join(target, "plugins", "flowguard-audit.ts"), PLUGIN_WRAPPER, args.force),
    );

    // 4. Command files (write if absent, --force to replace)
    for (const [name, content] of Object.entries(COMMANDS)) {
      ops.push(
        await writeIfAbsent(join(target, "commands", name), content, args.force),
      );
    }

    // 5. package.json (merge)
    ops.push(await mergePackageJson(join(target, "package.json"), PACKAGE_VERSION));

    // 6. opencode.json (merge with migration)
    //    - global: merge into ~/.config/opencode/opencode.json
    //    - repo: merge into ./opencode.json (project root, parent of .opencode/)
    const opencodeJsonPath = args.installScope === "global"
      ? join(target, "opencode.json")
      : join(resolve("."), "opencode.json");
    ops.push(await mergeOpencodeJson(opencodeJsonPath, args.installScope));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, warnings };
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Uninstall FlowGuard from the target directory.
 *
 * Removes all FlowGuard-owned files including flowguard-mandates.md.
 * Reports warnings for modified managed artifacts.
 * Cleans FlowGuard instruction entries from opencode.json.
 * Never touches AGENTS.md.
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations, warnings, and any errors.
 */
export async function uninstall(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.installScope);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Remove FlowGuard-owned files
    for (const relPath of FLOWGUARD_OWNED_FILES) {
      const fullPath = join(target, relPath);

      // For flowguard-mandates.md, check if modified before removing
      if (relPath === MANDATES_FILENAME) {
        const content = await safeRead(fullPath);
        if (content !== null) {
          if (isManagedArtifact(content)) {
            const fileDigest = extractManagedDigest(content);
            const expectedDigest = computeMandatesDigest();
            const fileBody = extractManagedBody(content);
            const bodyModified = fileBody !== null && sha256(fileBody) !== expectedDigest;
            if ((fileDigest && fileDigest !== expectedDigest) || bodyModified) {
              warnings.push(`${MANDATES_FILENAME} was locally modified — removed anyway`);
            }
          } else {
            warnings.push(`${MANDATES_FILENAME} has no managed header — removed anyway`);
          }
        }
      }

      const removed = await safeUnlink(fullPath);
      ops.push({
        path: fullPath,
        action: removed ? "removed" : "not_found",
      });
    }

    // Remove @flowguard/core from package.json
    const pkgPath = join(target, "package.json");
    const pkgContent = await safeRead(pkgPath);
    if (pkgContent) {
      try {
        const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
        const deps = (parsed["dependencies"] ?? {}) as Record<string, string>;
        delete deps["@flowguard/core"];
        delete deps["@opencode-ai/plugin"]; // Clean up legacy dep too
        parsed["dependencies"] = deps;
        await writeFile(pkgPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
        ops.push({ path: pkgPath, action: "merged", reason: "removed FlowGuard dependencies" });
      } catch {
        ops.push({ path: pkgPath, action: "skipped", reason: "malformed JSON" });
      }
    }

    // Remove FlowGuard instruction entries from opencode.json
    const opencodeJsonPath = args.installScope === "global"
      ? join(target, "opencode.json")
      : join(resolve("."), "opencode.json");
    ops.push(await removeFromOpencodeJson(opencodeJsonPath, args.installScope));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, warnings };
}

// ─── Doctor ───────────────────────────────────────────────────────────────────

/**
 * Verify the FlowGuard installation is correct and complete.
 *
 * Extended status model for managed artifacts:
 * - ok: file present, content/digest matches
 * - missing: file not found
 * - modified: file present, managed header found, digest mismatch
 * - unmanaged: file present, no managed header
 * - version_mismatch: file present, digest ok, header version != installed version
 * - instruction_missing: flowguard-mandates.md ok but opencode.json doesn't reference it
 * - instruction_stale: legacy "AGENTS.md" entry still in opencode.json instructions
 * - error: other problems (e.g. malformed JSON)
 *
 * @param args - Parsed CLI arguments.
 * @returns Array of check results.
 */
export async function doctor(args: CliArgs): Promise<DoctorCheck[]> {
  const target = resolveTarget(args.installScope);
  const checks: DoctorCheck[] = [];

  // 1. Check flowguard-mandates.md (digest verification)
  const mandatesPath = join(target, MANDATES_FILENAME);
  const mandatesContent = await safeRead(mandatesPath);
  if (!mandatesContent) {
    checks.push({ file: mandatesPath, status: "missing" });
  } else if (!isManagedArtifact(mandatesContent)) {
    checks.push({ file: mandatesPath, status: "unmanaged", detail: "no managed-artifact header" });
  } else {
    const fileDigest = extractManagedDigest(mandatesContent);
    const expectedDigest = computeMandatesDigest();
    const fileVersion = extractManagedVersion(mandatesContent);
    const fileBody = extractManagedBody(mandatesContent);

    if (!fileDigest) {
      checks.push({ file: mandatesPath, status: "error", detail: "managed header found but no digest" });
    } else if (fileDigest !== expectedDigest) {
      // Header claims a different digest than the canonical body — version/content drift
      checks.push({ file: mandatesPath, status: "modified", detail: "content-digest mismatch — file was locally edited" });
    } else if (fileBody !== null && sha256(fileBody) !== fileDigest) {
      // Header digest matches canonical, but actual body was modified (e.g. appended)
      checks.push({ file: mandatesPath, status: "modified", detail: "content-digest mismatch — file body was locally edited" });
    } else if (fileVersion !== PACKAGE_VERSION) {
      checks.push({ file: mandatesPath, status: "version_mismatch", detail: `header v${fileVersion} != installed v${PACKAGE_VERSION}` });
    } else {
      checks.push({ file: mandatesPath, status: "ok" });
    }
  }

  // 2. Check tool wrapper
  const toolPath = join(target, "tools", "flowguard.ts");
  const toolContent = await safeRead(toolPath);
  if (!toolContent) {
    checks.push({ file: toolPath, status: "missing" });
  } else if (toolContent.trim() !== TOOL_WRAPPER.trim()) {
    checks.push({ file: toolPath, status: "modified", detail: "content differs from template" });
  } else {
    checks.push({ file: toolPath, status: "ok" });
  }

  // 3. Check plugin wrapper
  const pluginPath = join(target, "plugins", "flowguard-audit.ts");
  const pluginContent = await safeRead(pluginPath);
  if (!pluginContent) {
    checks.push({ file: pluginPath, status: "missing" });
  } else if (pluginContent.trim() !== PLUGIN_WRAPPER.trim()) {
    checks.push({ file: pluginPath, status: "modified", detail: "content differs from template" });
  } else {
    checks.push({ file: pluginPath, status: "ok" });
  }

  // 4. Check command files
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

  // 5. Check package.json
  const pkgPath = join(target, "package.json");
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) {
    checks.push({ file: pkgPath, status: "missing" });
  } else {
    try {
      const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
      const deps = (parsed["dependencies"] ?? {}) as Record<string, string>;
      if (deps["@flowguard/core"]) {
        checks.push({ file: pkgPath, status: "ok" });
      } else {
        checks.push({ file: pkgPath, status: "error", detail: "missing @flowguard/core dependency" });
      }
    } catch {
      checks.push({ file: pkgPath, status: "error", detail: "malformed JSON" });
    }
  }

  // 6. Check opencode.json instruction entries
  const opencodeJsonPath = args.installScope === "global"
    ? join(target, "opencode.json")
    : join(resolve("."), "opencode.json");
  const opencodeContent = await safeRead(opencodeJsonPath);
  if (opencodeContent) {
    try {
      const parsed = JSON.parse(opencodeContent) as Record<string, unknown>;
      const instructions = Array.isArray(parsed["instructions"])
        ? (parsed["instructions"] as string[])
        : [];
      const entry = mandatesInstructionEntry(args.installScope);

      if (!instructions.includes(entry)) {
        checks.push({
          file: opencodeJsonPath,
          status: "instruction_missing",
          detail: `instructions array does not contain "${entry}"`,
        });
      }

      if (instructions.includes(LEGACY_INSTRUCTION_ENTRY)) {
        checks.push({
          file: opencodeJsonPath,
          status: "instruction_stale",
          detail: `legacy "${LEGACY_INSTRUCTION_ENTRY}" entry still in instructions — run install to migrate`,
        });
      }

      // If both checks passed (no missing, no stale), report ok
      const hasInstructionIssue = checks.some(
        (c) => c.file === opencodeJsonPath &&
          (c.status === "instruction_missing" || c.status === "instruction_stale"),
      );
      if (!hasInstructionIssue) {
        checks.push({ file: opencodeJsonPath, status: "ok" });
      }
    } catch {
      checks.push({ file: opencodeJsonPath, status: "error", detail: "malformed JSON" });
    }
  }

  return checks;
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_POLICY_MODES: readonly PolicyMode[] = ["solo", "team", "regulated"] as const;
const VALID_SCOPES: readonly InstallScope[] = ["global", "repo"] as const;
const VALID_ACTIONS: readonly CliAction[] = ["install", "uninstall", "doctor"] as const;

/**
 * Parse CLI arguments from process.argv.
 *
 * Supports both new flags (--install-scope, --policy-mode) and deprecated
 * aliases (--global, --project, --mode) with warnings.
 *
 * @param argv - Raw argv (typically process.argv.slice(2)).
 * @returns Parsed arguments and deprecation warnings, or null if invalid.
 */
export function parseArgs(argv: string[]): { args: CliArgs; deprecations: string[] } | null {
  const action = argv[0] as CliAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return null;
  }

  let installScope: InstallScope = "global";
  let policyMode: PolicyMode = "solo";
  let force = false;
  const deprecations: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      // ── New flags ──────────────────────────────────────────
      case "--install-scope": {
        const next = argv[i + 1];
        if (next && VALID_SCOPES.includes(next as InstallScope)) {
          installScope = next as InstallScope;
          i++;
        } else {
          return null;
        }
        break;
      }
      case "--policy-mode": {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          i++;
        } else {
          return null;
        }
        break;
      }
      case "--force":
        force = true;
        break;

      // ── Deprecated aliases ─────────────────────────────────
      case "--global":
        installScope = "global";
        deprecations.push("--global is deprecated, use --install-scope global");
        break;
      case "--project":
        installScope = "repo";
        deprecations.push("--project is deprecated, use --install-scope repo");
        break;
      case "--mode": {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          deprecations.push("--mode is deprecated, use --policy-mode");
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

  return {
    args: { action, installScope, policyMode, force },
    deprecations,
  };
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

  for (const w of result.warnings) {
    lines.push(`  [warn] ${w}`);
  }

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
  const iconMap: Record<DoctorStatus, string> = {
    ok: "ok",
    missing: "MISSING",
    modified: "MODIFIED",
    unmanaged: "UNMANAGED",
    version_mismatch: "VERSION",
    instruction_missing: "INSTR_MISSING",
    instruction_stale: "INSTR_STALE",
    error: "ERROR",
  };

  for (const check of checks) {
    const suffix = check.detail ? ` — ${check.detail}` : "";
    lines.push(`  [${iconMap[check.status]}] ${check.file}${suffix}`);
  }

  const ok = checks.filter((c) => c.status === "ok").length;
  const total = checks.length;
  lines.push("");
  lines.push(`  ${ok}/${total} checks passed`);

  return lines.join("\n");
}

const USAGE = `\
Usage: flowguard <command> [options]

Commands:
  install     Install FlowGuard tools, plugins, and commands
  uninstall   Remove FlowGuard files
  doctor      Verify installation is correct and complete

Options:
  --install-scope  Where to install: global (default) or repo
  --policy-mode    FlowGuard policy: solo (default), team, regulated
  --force          Overwrite all managed artifacts

Deprecated (still work):
  --global    → --install-scope global
  --project   → --install-scope repo
  --mode X    → --policy-mode X

Examples:
  npx @flowguard/core install
  npx @flowguard/core install --install-scope repo --policy-mode regulated
  npx @flowguard/core uninstall --install-scope global
  npx @flowguard/core doctor
`;

/**
 * CLI main entry point.
 * Only executes when this file is run directly (not when imported for testing).
 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed) {
    console.log(USAGE);
    return 1;
  }

  const { args, deprecations } = parsed;

  // Emit deprecation warnings
  for (const d of deprecations) {
    console.error(`  [deprecated] ${d}`);
  }

  const targetLabel = args.installScope === "global" ? "~/.config/opencode/" : "./.opencode/";

  switch (args.action) {
    case "install": {
      console.log(`Installing FlowGuard to ${targetLabel}...`);
      console.log(`  Install scope: ${args.installScope}`);
      console.log(`  Policy mode: ${args.policyMode}`);
      console.log("");
      const result = await install(args);
      console.log(formatResult(result));
      if (result.errors.length > 0) return 1;
      console.log("");
      console.log(`  Run 'bun install' in ${targetLabel} to install dependencies.`);
      return 0;
    }

    case "uninstall": {
      console.log(`Uninstalling FlowGuard from ${targetLabel}...`);
      console.log("");
      const result = await uninstall(args);
      console.log(formatResult(result));
      return result.errors.length > 0 ? 1 : 0;
    }

    case "doctor": {
      console.log(`Checking FlowGuard installation at ${targetLabel}...`);
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
