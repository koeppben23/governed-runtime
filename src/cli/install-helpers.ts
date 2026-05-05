/**
 * @module cli/install-helpers
 * @description Types, constants, and utility functions for the FlowGuard CLI installer.
 *
 * Extracted from install.ts to reduce file size. Pure types and utility functions
 * with no CLI entry-point logic.
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  COMMANDS,
  REVIEWER_AGENT_FILENAME,
  FLOWGUARD_MANDATES_BODY,
  MANDATES_FILENAME,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
} from './templates.js';

import type { PolicyMode } from '../config/policy-types.js';

// ─── Types ────────────────────────────────────────────────────────────────────
export type InstallScope = 'global' | 'repo';

/** Re-export canonical PolicyMode from config/policy-types. */
export type { PolicyMode };

/** CLI action. */
export type CliAction = 'install' | 'uninstall' | 'doctor' | 'run' | 'serve';

/** Parsed CLI arguments. */
export interface CliArgs {
  action: CliAction;
  installScope: InstallScope;
  policyMode: PolicyMode;
  force: boolean;
  coreTarball?: string;
}

/** Result of a single file operation. */
export interface FileOp {
  path: string;
  action: 'written' | 'skipped' | 'merged' | 'removed' | 'not_found';
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
  | 'ok'
  | 'missing'
  | 'modified'
  | 'unmanaged'
  | 'version_mismatch'
  | 'instruction_missing'
  | 'instruction_stale'
  | 'error'
  | 'warn';

/** Status of a single doctor check. */
export interface DoctorCheck {
  file: string;
  status: DoctorStatus;
  detail?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Get the current package version from the VERSION file.
 * SSOT: This is the single source of truth for the version.
 * Both package.json and the release workflow validate against this value.
 */
function getPackageVersion(): string {
  const versionFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'VERSION');
  try {
    return readFileSync(versionFile, 'utf-8').trim();
  } catch {
    throw new Error(`VERSION file not found at ${versionFile}. Run from the project root.`);
  }
}

/** Cache the version so we don't re-read the file on every call. */
let _cachedVersion: string | undefined;
export function PACKAGE_VERSION(): string {
  if (!_cachedVersion) {
    _cachedVersion = getPackageVersion();
  }
  return _cachedVersion;
}

/** Files owned by FlowGuard that uninstall may remove. */
export const FLOWGUARD_OWNED_FILES = [
  MANDATES_FILENAME,
  'tools/flowguard.ts',
  'plugins/flowguard-audit.ts',
  `agents/${REVIEWER_AGENT_FILENAME}`,
  ...Object.keys(COMMANDS).map((name) => `commands/${name}`),
  'vendor',
] as const;

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the target directory for install/uninstall.
 *
 * @param scope - "global" resolves to ~/.config/opencode/. "repo" resolves to ./.opencode/.
 * @returns Absolute path to the target directory.
 */
export function resolveTarget(scope: InstallScope): string {
  if (scope === 'global') {
    return join(homedir(), '.config', 'opencode');
  }
  return resolve('.opencode');
}

// ─── Crypto Helpers ───────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
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
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Safely read a file. Returns null if the file doesn't exist.
 */
export async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Safely delete a file. Returns true if deleted, false if not found.
 */
export async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the file:-dependency string for @flowguard/core.
 * Used by both PACKAGE_JSON_TEMPLATE and mergePackageJson() to ensure
 * consistent A1 model: local vendor directory with offline-resolvable file:-dependency.
 */
export function vendorDependency(version: string): string {
  return `file:./vendor/flowguard-core-${version}.tgz`;
}

/**
 * Write a file only if it doesn't exist or --force is set.
 * Used for hard-managed artifacts OTHER than flowguard-mandates.md
 * (which is always replaced).
 */
export async function writeIfAbsent(
  filePath: string,
  content: string,
  force: boolean,
): Promise<FileOp> {
  if (!force && existsSync(filePath)) {
    return { path: filePath, action: 'skipped', reason: 'already exists' };
  }
  const dir = dirname(filePath);
  if (dir) await ensureDir(dir);
  await writeFile(filePath, content, 'utf-8');
  return { path: filePath, action: 'written' };
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
export async function mergePackageJson(filePath: string, version: string): Promise<FileOp> {
  const existing = await safeRead(filePath);

  if (!existing) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return { path: filePath, action: 'written' };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
    deps['@flowguard/core'] = vendorDependency(version);
    if (!deps['zod']) deps['zod'] = '^4.0.0';
    // Remove legacy dependency that is no longer needed
    delete deps['@opencode-ai/plugin'];
    parsed['dependencies'] = deps;
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return { path: filePath, action: 'merged' };
  } catch {
    // Malformed JSON — overwrite with template
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return { path: filePath, action: 'written', reason: 'existing file was malformed JSON' };
  }
}

/**
 * Enforce strict P35 Task permission for the build agent.
 *
 * Replaces parsed.agent.build.permission.task with a wildcard deny baseline
 * plus an explicit flowguard-reviewer allow. Existing task allow entries are
 * intentionally removed so the build agent can only invoke the reviewer
 * subagent via the Task tool.
 */
export function mergeReviewerTaskPermission(parsed: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyObj = Record<string, any>;

  if (!parsed['agent'] || typeof parsed['agent'] !== 'object') {
    parsed['agent'] = {};
  }
  const agent = parsed['agent'] as AnyObj;

  if (!agent['build'] || typeof agent['build'] !== 'object') {
    agent['build'] = {};
  }
  const build = agent['build'] as AnyObj;

  if (!build['permission'] || typeof build['permission'] !== 'object') {
    build['permission'] = {};
  }
  const permission = build['permission'] as AnyObj;

  if (!permission['task'] || typeof permission['task'] !== 'object') {
    permission['task'] = {};
  }

  // P35: Strict assurance — the build agent may only invoke flowguard-reviewer
  // via the Task tool. Any pre-existing allow entries are removed and replaced
  // with a wildcard deny baseline plus the explicit reviewer allow.
  // flowguard-reviewer must appear after * because OpenCode uses last-matching-rule.
  permission['task'] = {
    '*': 'deny',
    'flowguard-reviewer': 'allow',
  };
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
 * 6. build agent has task permission for flowguard-reviewer subagent (standard merge path;
 *    desktop-owned configs are out of installer enforcement scope for task permissions)
 *
 * @param filePath - Path to opencode.json
 * @param scope    - Install scope (determines the instruction entry path)
 */
export async function mergeOpencodeJson(filePath: string, scope: InstallScope): Promise<FileOp> {
  const entry = mandatesInstructionEntry(scope);
  const existing = await safeRead(filePath);

  if (!existing) {
    const dir = dirname(filePath);
    if (dir) await ensureDir(dir);
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), 'utf-8');
    return { path: filePath, action: 'written' };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;

    // Detect desktop app config: has plugin field or has non-FlowGuard instructions.
    // Desktop app owns its own plugin/instruction config — do NOT touch it.
    // FlowGuard only manages its own mandates entry.
    const hasPluginField = 'plugin' in parsed;
    const existingInstructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];
    const hasDesktopInstructions = existingInstructions.some(
      (i) => !i.includes('flowguard-mandates') && !i.includes('AGENTS.md'),
    );

    if (hasPluginField || hasDesktopInstructions) {
      // Desktop app owns this config — only add our entries
      const instructions = existingInstructions.filter((i) => i !== LEGACY_INSTRUCTION_ENTRY);
      if (!instructions.includes(entry)) {
        instructions.push(entry);
      }
      parsed['instructions'] = instructions;

      if (!Array.isArray(parsed['plugin'])) {
        parsed['plugin'] = ['flowguard-audit'];
      } else if (!(parsed['plugin'] as string[]).includes('flowguard-audit')) {
        (parsed['plugin'] as string[]).push('flowguard-audit');
      }

      await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      return {
        path: filePath,
        action: 'merged',
        reason: 'desktop-owned config: task permission not enforced',
      };
    }

    // Standard merge for FlowGuard-only configs
    let instructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];

    // Migration: remove legacy "AGENTS.md" entry (only the exact FlowGuard-owned one)
    instructions = instructions.filter((i) => i !== LEGACY_INSTRUCTION_ENTRY);

    // Deduplicate: remove our entry if already present, then add exactly once
    instructions = instructions.filter((i) => i !== entry);
    instructions.push(entry);

    parsed['instructions'] = instructions;

    // Ensure build agent has task permission for flowguard-reviewer subagent
    mergeReviewerTaskPermission(parsed);

    // Register plugin entry as a compatibility safety net.
    if (!Array.isArray(parsed['plugin'])) {
      parsed['plugin'] = ['flowguard-audit'];
    } else if (!(parsed['plugin'] as string[]).includes('flowguard-audit')) {
      (parsed['plugin'] as string[]).push('flowguard-audit');
    }

    if (!parsed['$schema']) {
      parsed['$schema'] = 'https://opencode.ai/config.json';
    }
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return { path: filePath, action: 'merged' };
  } catch {
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), 'utf-8');
    return { path: filePath, action: 'written', reason: 'existing file was malformed JSON' };
  }
}

/**
 * Remove FlowGuard instruction entries from opencode.json during uninstall.
 * Removes both current and legacy entries. Preserves everything else.
 */
export async function removeFromOpencodeJson(
  filePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) {
    return { path: filePath, action: 'not_found' };
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;

    // Detect desktop app config — do NOT modify it (flowguard uninstall should not
    // touch desktop app's instruction configuration beyond removing our own entries)
    const hasPluginField = 'plugin' in parsed;
    const existingInstructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];
    const hasDesktopInstructions = existingInstructions.some(
      (i) => !i.includes('flowguard-mandates') && !i.includes('AGENTS.md'),
    );

    if (hasPluginField || hasDesktopInstructions) {
      // Desktop app owns this config — only remove FlowGuard entries
      const entry = mandatesInstructionEntry(scope);
      const before = parsed['instructions'] as string[];
      const after = before.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);
      const removedInstruction = after.length !== before.length;

      if (Array.isArray(parsed['plugin'])) {
        (parsed['plugin'] as string[]) = (parsed['plugin'] as string[]).filter(
          (p) => p !== 'flowguard-audit',
        );
      }

      if (!removedInstruction && !hasPluginField) {
        return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
      }

      parsed['instructions'] = after;
      await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      return { path: filePath, action: 'merged', reason: 'removed FlowGuard entries' };
    }

    // Standard removal for FlowGuard-only configs
    if (!Array.isArray(parsed['instructions'])) {
      return { path: filePath, action: 'skipped', reason: 'no instructions array' };
    }

    const entry = mandatesInstructionEntry(scope);
    const before = parsed['instructions'] as string[];
    const after = before.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);

    if (Array.isArray(parsed['plugin'])) {
      (parsed['plugin'] as string[]) = (parsed['plugin'] as string[]).filter(
        (p) => p !== 'flowguard-audit',
      );
    }

    if (after.length === before.length) {
      return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
    }

    parsed['instructions'] = after;
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return { path: filePath, action: 'merged', reason: 'removed FlowGuard instruction entries' };
  } catch {
    return { path: filePath, action: 'skipped', reason: 'malformed JSON' };
  }
}
