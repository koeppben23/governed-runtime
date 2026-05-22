/**
 * @module cli/install-helpers
 * @description Path resolution, tarball integrity, and file helpers for the FlowGuard CLI installer.
 *
 * Types and JSON merge logic extracted to install-types.ts and install-json.ts
 * following FG-REL-042. This module re-exports everything for backward compatibility.
 *
 * @version v2
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
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
  OPENCODE_CONFIG_FILENAMES,
} from './install-types.js';
export {
  FLOWGUARD_REVIEWER_MODEL_ENV,
  VALID_MODEL_ID_PATTERN,
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
    return { relativePath: `agents/${REVIEWER_AGENT_FILENAME}`, content: CLAUDE_REVIEWER_AGENT };
  }
  if (platform === 'codex') {
    return {
      relativePath: `subagents/${REVIEWER_AGENT_FILENAME}`,
      content: CODEX_REVIEWER_SUBAGENT,
    };
  }
  return {
    relativePath: `agents/${REVIEWER_AGENT_FILENAME}`,
    content: buildReviewerAgentContent(REVIEWER_AGENT),
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

// ---- Reviewer Agent Model Override ----

export function buildReviewerAgentContent(template: string): string {
  const raw = process.env[FLOWGUARD_REVIEWER_MODEL_ENV];
  if (!raw) return template;

  const model = raw.trim();
  if (!model) return template;

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

  const firstNewline = template.indexOf('\n');
  if (firstNewline < 0) return template;

  return (
    template.slice(0, firstNewline + 1) + `model: ${model}\n` + template.slice(firstNewline + 1)
  );
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
