/**
 * @module cli/install-json
 * @description JSON merge helpers for the FlowGuard CLI installer.
 *
 * Extracted from install-helpers.ts. Contains package.json and opencode.json
 * merge logic, plus JSONC parsing and backup utilities.
 *
 * @version v1
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir } from '../adapters/persistence.js';
import { parse as jsoncParse, type ParseError } from 'jsonc-parser';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
  LEGACY_INSTRUCTION_ENTRY,
  mandatesInstructionEntry,
} from './templates.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { InstallScope, FileOp } from './install-types.js';
import { hasNonFlowGuardInstructions } from './install-types.js';

// ---- JSONC Parsing ----

/**
 * Parse JSONC content. Uses jsonc-parser which handles
 * single-line comments, block comments, and trailing commas.
 */
export function parseJsonc<T = Record<string, unknown>>(content: string): T {
  const errors: ParseError[] = [];
  const result = jsoncParse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new SyntaxError(`JSONC parse error at offset ${first.offset}: error code ${first.error}`);
  }
  return result as T;
}

// ---- Error Discrimination ----

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function createMalformedJsonBackup(
  filePath: string,
  originalContent: string,
  now = new Date(),
): Promise<string> {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  const backupPath = `${filePath}.flowguard-backup-${timestamp}`;
  await writeFile(backupPath, originalContent, { encoding: 'utf-8', flag: 'wx' });
  return backupPath;
}

export function vendorDependency(version: string): string {
  return `file:./vendor/flowguard-core-${version}.tgz`;
}

// ---- JSON Merge Helpers ----

export async function mergePackageJson(filePath: string, version: string): Promise<FileOp> {
  const existing = await safeRead(filePath);

  if (!existing) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return { path: filePath, action: 'written' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    const backupPath = await createMalformedJsonBackup(filePath, existing);
    getAdapterLogger().warn('cli', 'Package.json malformed, creating backup and overwriting', {
      filePath,
      backupPath,
    });
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return {
      path: filePath,
      action: 'written',
      reason: `existing file was malformed JSON (backup: ${backupPath})`,
    };
  }

  const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
  deps['@flowguard/core'] = vendorDependency(version);
  if (!deps['zod']) deps['zod'] = '^4.0.0';
  delete deps['@opencode-ai/plugin'];
  parsed['dependencies'] = deps;
  await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  return { path: filePath, action: 'merged' };
}

function ensureNested(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!parent[key] || typeof parent[key] !== 'object' || parent[key] === null) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

export function mergeReviewerTaskPermission(parsed: Record<string, unknown>): void {
  const agent = ensureNested(parsed, 'agent');
  const build = ensureNested(agent, 'build');
  const permission = ensureNested(build, 'permission');

  permission['task'] = {
    '*': 'deny',
    [REVIEWER_SUBAGENT_TYPE]: 'allow',
  };
}

export async function mergeOpencodeJson(filePath: string, scope: InstallScope): Promise<FileOp> {
  const entry = mandatesInstructionEntry(scope);
  const existing = await safeRead(filePath);

  if (!existing) {
    const dir = dirname(filePath);
    if (dir) await ensureDir(dir);
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), 'utf-8');
    return { path: filePath, action: 'written' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(existing);
  } catch {
    const backupPath = await createMalformedJsonBackup(filePath, existing);
    getAdapterLogger().warn('cli', 'Opencode.json malformed, creating backup and overwriting', {
      filePath,
      backupPath,
    });
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), 'utf-8');
    return {
      path: filePath,
      action: 'written',
      reason: `existing file was malformed JSON/JSONC (backup: ${backupPath})`,
    };
  }

  const hasPluginField = 'plugin' in parsed;
  const existingInstructions = Array.isArray(parsed['instructions'])
    ? (parsed['instructions'] as string[])
    : [];
  const hasDesktopInstructions = hasNonFlowGuardInstructions(existingInstructions);

  if (hasPluginField || hasDesktopInstructions) {
    const instructions = existingInstructions.filter((i) => i !== LEGACY_INSTRUCTION_ENTRY);
    if (!instructions.includes(entry)) {
      instructions.push(entry);
    }
    parsed['instructions'] = instructions;
    mergeReviewerTaskPermission(parsed);
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return {
      path: filePath,
      action: 'merged',
      reason: 'desktop-owned config: merged with task permission',
    };
  }

  let instructions = Array.isArray(parsed['instructions'])
    ? (parsed['instructions'] as string[])
    : [];

  instructions = instructions.filter((i) => i !== LEGACY_INSTRUCTION_ENTRY);
  instructions = instructions.filter((i) => i !== entry);
  instructions.push(entry);
  parsed['instructions'] = instructions;
  mergeReviewerTaskPermission(parsed);

  if (!parsed['$schema']) {
    parsed['$schema'] = 'https://opencode.ai/config.json';
  }
  await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  return { path: filePath, action: 'merged' };
}

function getTaskPermissions(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (!parsed['agent'] || typeof parsed['agent'] !== 'object') return null;
  const build = (parsed['agent'] as Record<string, unknown>)['build'];
  if (!build || typeof build !== 'object') return null;
  const permission = (build as Record<string, unknown>)['permission'];
  if (!permission || typeof permission !== 'object') return null;
  const task = (permission as Record<string, unknown>)['task'];
  if (!task || typeof task !== 'object') return null;
  return task as Record<string, unknown>;
}

function cleanupEmptyParents(
  parsed: Record<string, unknown>,
  agent: Record<string, unknown>,
  build: Record<string, unknown>,
  permission: Record<string, unknown>,
): void {
  if (Object.keys(permission).length === 0) delete build['permission'];
  if (Object.keys(build).length === 0) delete agent['build'];
  if (Object.keys(agent).length === 0) delete parsed['agent'];
}

function removeTaskHardening(parsed: Record<string, unknown>): boolean {
  const task = getTaskPermissions(parsed);
  if (!task) return false;
  const agent = parsed['agent'] as Record<string, unknown>;
  const build = agent['build'] as Record<string, unknown>;
  const permission = build['permission'] as Record<string, unknown>;

  let removed = false;
  if (task[REVIEWER_SUBAGENT_TYPE] === 'allow') {
    delete task[REVIEWER_SUBAGENT_TYPE];
    removed = true;
  }
  if (task['*'] === 'deny' && Object.keys(task).filter((k) => k !== '*').length === 0) {
    delete task['*'];
    removed = true;
  }
  if (Object.keys(task).length === 0) delete permission['task'];
  cleanupEmptyParents(parsed, agent, build, permission);
  return removed;
}

async function removeFlowGuardOnly(
  parsed: Record<string, unknown>,
  scope: InstallScope,
): Promise<{ removed: boolean }> {
  const entry = mandatesInstructionEntry(scope);
  const hasInstructions = Array.isArray(parsed['instructions']);
  const before = hasInstructions ? (parsed['instructions'] as string[]) : [];
  const after = before.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);
  const removedInstruction = after.length !== before.length;
  const removedTaskHardening = removeTaskHardening(parsed);

  if (hasInstructions) {
    parsed['instructions'] = after;
  }
  return { removed: removedInstruction || removedTaskHardening };
}

async function removeFromDesktopOwned(
  parsed: Record<string, unknown>,
  instructions: string[],
  scope: InstallScope,
): Promise<{ removed: true; parsed: Record<string, unknown> } | { removed: false }> {
  const entry = mandatesInstructionEntry(scope);
  const after = instructions.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);
  if (after.length === instructions.length) return { removed: false };
  if (Array.isArray(parsed['instructions']) || after.length > 0) {
    parsed['instructions'] = after;
  }
  return { removed: true, parsed };
}

export async function removeFromOpencodeJson(
  filePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) return { path: filePath, action: 'not_found' };

  try {
    const parsed = parseJsonc(existing);
    const instructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];

    if (hasNonFlowGuardInstructions(instructions) || 'plugin' in parsed) {
      const result = await removeFromDesktopOwned(parsed, instructions, scope);
      if (!result.removed)
        return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
      await writeFile(filePath, JSON.stringify(result.parsed, null, 2) + '\n', 'utf-8');
      return { path: filePath, action: 'merged', reason: 'removed FlowGuard entries' };
    }

    const { removed } = await removeFlowGuardOnly(parsed, scope);
    if (!removed)
      return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return { path: filePath, action: 'merged', reason: 'removed FlowGuard instruction entries' };
  } catch {
    getAdapterLogger().warn('cli', 'Opencode.json malformed during uninstall, skipping removal', {
      filePath,
    });
    return { path: filePath, action: 'skipped', reason: 'malformed JSON' };
  }
}
