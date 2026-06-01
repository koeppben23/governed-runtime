/**
 * @module cli/install-helpers
 * @description Path resolution, tarball integrity, and file helpers for the FlowGuard CLI installer.
 *
 * Types and JSON merge logic extracted to install-types.ts and install-json.ts
 * following FG-REL-042. This module re-exports everything for backward compatibility.
 *
 * @version v2
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { hashText, hashFile } from '../shared/hashing.js';
import {
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_SUBAGENT,
  REVIEWER_AGENT_FILENAME,
  REVIEWER_AGENT,
  FLOWGUARD_MANDATES_BODY,
} from './templates.js';

// ---- re-export everything from split modules for backward compatibility ----
export type {
  InstallScope,
  InstallPlatform,
  CliAction,
  CliArgs,
  FileOp,
  CliResult,
  DoctorStatus,
  DoctorCheck,
  PolicyMode,
} from './install-types.js';
export {
  PACKAGE_VERSION,
  FLOWGUARD_OWNED_FILES,
  FLOWGUARD_TARBALL_PATTERN,
  FLOWGUARD_INSTRUCTION_ENTRIES,
  hasNonFlowGuardInstructions,
} from './install-types.js';
import {
  FLOWGUARD_REVIEWER_MODEL_ENV,
  VALID_MODEL_ID_PATTERN,
  FLOWGUARD_REVIEWER_EFFORT_ENV,
  VALID_EFFORT_PATTERN,
  OPENCODE_CONFIG_FILENAMES,
} from './install-types.js';
export {
  FLOWGUARD_REVIEWER_MODEL_ENV,
  VALID_MODEL_ID_PATTERN,
  FLOWGUARD_REVIEWER_EFFORT_ENV,
  VALID_EFFORT_PATTERN,
  OPENCODE_CONFIG_FILENAMES,
} from './install-types.js';
export {
  parseJsonc,
  createMalformedJsonBackup,
  vendorDependency,
  mergePackageJson,
  mergeReviewerTaskPermission,
  mergeOpencodeJson,
  removeFromOpencodeJson,
} from './install-json.js';
export { hashText as sha256 };

import type { InstallScope, InstallPlatform, FileOp } from './install-types.js';

// ---- Path Resolution ----

export function resolveTarget(scope: InstallScope, platform: InstallPlatform = 'opencode'): string {
  if (scope === 'global') {
    if (platform === 'claude-code')
      return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    if (platform === 'codex') return join(homedir(), '.codex', 'plugins', 'flowguard');
    return process.env.OPENCODE_CONFIG_DIR || join(homedir(), '.config', 'opencode');
  }
  if (platform === 'claude-code') return resolve('.claude');
  if (platform === 'codex') return resolve('plugins', 'flowguard');
  return resolve('.opencode');
}

export function reviewerDefinitionForPlatform(platform: InstallPlatform): {
  readonly relativePath: string;
  readonly content: string;
} {
  if (platform === 'claude-code') {
    return {
      relativePath: `agents/${REVIEWER_AGENT_FILENAME}`,
      content: buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code'),
    };
  }
  if (platform === 'codex') {
    assertReviewerTuningSupported('codex');
    return {
      relativePath: `subagents/${REVIEWER_AGENT_FILENAME}`,
      content: CODEX_REVIEWER_SUBAGENT,
    };
  }
  return {
    relativePath: `agents/${REVIEWER_AGENT_FILENAME}`,
    content: buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'),
  };
}

export function computeMandatesDigest(): string {
  return hashText(FLOWGUARD_MANDATES_BODY);
}

// ---- Tarball Integrity Verification ----

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const CHECKSUM_LINE_RE = /^([0-9a-fA-F]{64})\s+[*]?\s*(.+)$/;

function safeHashHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function verifyTarballChecksum(
  tarballPath: string,
  checksumsFilePath: string,
): Promise<void> {
  const tarballName = basename(tarballPath);

  let content: string;
  try {
    content = readFileSync(checksumsFilePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read checksums file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = content.split('\n');
  let matchedHash: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(CHECKSUM_LINE_RE);
    if (!match) continue;

    const hashHex = match[1]!;
    const filename = match[2]!;

    if (!SHA256_HEX_RE.test(hashHex)) continue;

    if (basename(filename) === tarballName) {
      if (matchedHash !== undefined) {
        throw new Error(
          `Duplicate entry for "${tarballName}" in checksums file. ` +
            `Ambiguous integrity verification is denied.`,
        );
      }
      matchedHash = hashHex.toLowerCase();
    }
  }

  if (matchedHash === undefined) {
    throw new Error(`Tarball "${tarballName}" not found in checksums file "${checksumsFilePath}".`);
  }

  const expectedHash = matchedHash;
  const actualHash = await hashFile(tarballPath);

  if (!safeHashHexEqual(actualHash, expectedHash)) {
    throw new Error(
      `Tarball SHA-256 mismatch.\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}\n` +
        `  The tarball may be corrupted or tampered.`,
    );
  }
}

// ---- Reviewer Agent Capability Transport (model + reasoning effort) ----
//
// Operative-layer adaptation ONLY. Governance ceremony/mandates stay
// model-invariant; these knobs adjust the reviewer transport (which model and
// how much reasoning effort) without ever hardcoding a model name and without
// touching governance verbosity. Both knobs are operator-controlled env vars.
//
// Host support (verified against official host docs):
//   - opencode:    `model:` + passthrough `reasoningEffort:` frontmatter.
//   - claude-code: `model:` + `effort:` frontmatter.
//   - codex:       custom-agent tuning is configured via native TOML under
//                  `.codex/agents/` (model + model_reasoning_effort), NOT via the
//                  markdown plugin subagent FlowGuard ships. Injecting these
//                  directives into the markdown frontmatter is unsupported, so we
//                  fail closed instead of silently emitting a no-op directive.

/** Per-host frontmatter key for the reasoning-effort knob; null = unsupported. */
function reviewerEffortFieldForPlatform(platform: InstallPlatform): string | null {
  if (platform === 'claude-code') return 'effort';
  if (platform === 'codex') return null;
  return 'reasoningEffort'; // opencode (provider passthrough)
}

/** Whether reviewer `model:` frontmatter injection is supported for the host. */
function reviewerModelSupportedForPlatform(platform: InstallPlatform): boolean {
  return platform !== 'codex';
}

function readReviewerModelEnv(): string | null {
  const raw = process.env[FLOWGUARD_REVIEWER_MODEL_ENV];
  if (!raw) return null;
  const model = raw.trim();
  if (!model) return null;

  if (/[\r\n]/.test(model)) {
    throw new Error(
      `${FLOWGUARD_REVIEWER_MODEL_ENV} contains newline characters — ` +
        'rejected to prevent YAML injection.',
    );
  }
  if (!VALID_MODEL_ID_PATTERN.test(model)) {
    throw new Error(
      `${FLOWGUARD_REVIEWER_MODEL_ENV} contains invalid characters: "${model}" — ` +
        'only alphanumeric, dots, slashes, @, colons, and hyphens are allowed.',
    );
  }
  return model;
}

function readReviewerEffortEnv(): string | null {
  const raw = process.env[FLOWGUARD_REVIEWER_EFFORT_ENV];
  if (!raw) return null;
  const effort = raw.trim();
  if (!effort) return null;

  if (!VALID_EFFORT_PATTERN.test(effort)) {
    throw new Error(
      `${FLOWGUARD_REVIEWER_EFFORT_ENV} contains invalid value: "${effort}" — ` +
        'only lowercase letters are allowed (e.g. low, medium, high, xhigh, max).',
    );
  }
  return effort;
}

/**
 * Fail closed when reviewer tuning is requested for a host that cannot honor it.
 *
 * Silently dropping an operator's explicit override would hide that their intent
 * is not applied (AGENTS.md red line: no silent fallback). For Codex we surface
 * the limitation and point at the native mechanism.
 */
function assertReviewerTuningSupported(platform: InstallPlatform): void {
  if (reviewerModelSupportedForPlatform(platform) && reviewerEffortFieldForPlatform(platform)) {
    return;
  }
  const requested: string[] = [];
  if (process.env[FLOWGUARD_REVIEWER_MODEL_ENV]?.trim())
    requested.push(FLOWGUARD_REVIEWER_MODEL_ENV);
  if (process.env[FLOWGUARD_REVIEWER_EFFORT_ENV]?.trim())
    requested.push(FLOWGUARD_REVIEWER_EFFORT_ENV);
  if (requested.length === 0) return;

  throw new Error(
    `${requested.join(' and ')} ${requested.length > 1 ? 'are' : 'is'} set but reviewer ` +
      `model/effort tuning is not supported for platform "${platform}". ` +
      'Codex configures custom-agent model and model_reasoning_effort via native TOML under ' +
      '.codex/agents/, not via the FlowGuard markdown subagent. ' +
      `Unset ${requested.join('/')} for this install, or configure the Codex custom agent directly.`,
  );
}

/**
 * Inject operator-configured reviewer transport tuning into agent frontmatter.
 *
 * Host defaults to opencode for backward compatibility. Returns the template
 * unchanged when no override is set or the template has no frontmatter line.
 */
export function buildReviewerAgentContent(
  template: string,
  platform: InstallPlatform = 'opencode',
): string {
  const lines: string[] = [];

  const model = readReviewerModelEnv();
  if (model && reviewerModelSupportedForPlatform(platform)) {
    lines.push(`model: ${model}`);
  }

  const effort = readReviewerEffortEnv();
  const effortField = reviewerEffortFieldForPlatform(platform);
  if (effort && effortField) {
    lines.push(`${effortField}: ${effort}`);
  }

  if (lines.length === 0) return template;

  const firstNewline = template.indexOf('\n');
  if (firstNewline < 0) return template;

  const injected = lines.map((line) => `${line}\n`).join('');
  return template.slice(0, firstNewline + 1) + injected + template.slice(firstNewline + 1);
}

// ---- OpenCode Config Path ----

export function resolveOpencodeConfigPath(
  scope: InstallScope,
  target = resolveTarget(scope),
  projectRoot = resolve('.'),
): string {
  const dir = scope === 'global' ? target : projectRoot;
  for (const filename of OPENCODE_CONFIG_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, 'opencode.json');
}

export function findParallelOpencodeConfig(preferredPath: string): string | null {
  const dir = dirname(preferredPath);
  const preferredName = basename(preferredPath);
  for (const name of OPENCODE_CONFIG_FILENAMES) {
    if (name !== preferredName) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ---- File Helpers ----

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

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

// ─── Rollback utilities (moved from install-command.ts to break circular dep) ─

/** Detect available package manager. Prefers bun (OpenCode runtime), falls back to npm. */
export function detectPackageManager(): 'bun' | 'npm' | null {
  const opts = { stdio: 'ignore' as const, timeout: 5_000 };
  try {
    execSync('bun --version', opts);
    return 'bun';
  } catch {
    // bun not available
  }
  try {
    execSync('npm --version', opts);
    return 'npm';
  } catch {
    // npm not available
  }
  return null;
}

/** Pre-install snapshot for transactional rollback. */
export interface RollbackEntry {
  path: string;
  existed: boolean;
  originalContent?: Buffer;
}

/**
 * Snapshot a file path before any modification.
 * Reads original content as Buffer so binary artifacts (e.g. tarball) are preserved exactly.
 */
export async function snapshotForRollback(filePath: string): Promise<RollbackEntry> {
  if (existsSync(filePath)) {
    try {
      const content = await readFile(filePath);
      return { path: filePath, existed: true, originalContent: content };
    } catch {
      return { path: filePath, existed: true };
    }
  }
  return { path: filePath, existed: false };
}

/**
 * Rollback install artifacts after a failed auto-install step.
 *
 * Uniform semantics:
 * - existed before install (has originalContent) -> restore original content
 * - existed before install (no content, e.g. directory) -> leave untouched
 * - did not exist before install -> delete (remove file/directory)
 */
export async function rollbackArtifacts(
  entries: RollbackEntry[],
  ops: FileOp[],
  warnings: string[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.existed && entry.originalContent !== undefined) {
        await writeFile(entry.path, entry.originalContent);
        ops.push({ path: entry.path, action: 'written', reason: 'restored pre-install content' });
      } else if (entry.existed) {
        continue;
      } else if (existsSync(entry.path)) {
        await rm(entry.path, { recursive: true, force: true });
        ops.push({ path: entry.path, action: 'removed', reason: 'rollback after failure' });
      }
    } catch (rollbackErr) {
      warnings.push(
        `Rollback failed for ${entry.path}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
  }
}
