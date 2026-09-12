/**
 * @module cli/install-json
 * @description JSON merge helpers for the FlowGuard CLI installer.
 *
 * Extracted from install-helpers.ts. Contains package.json and opencode.json
 * merge logic, plus JSONC parsing and backup utilities.
 *
 * @version v1
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as jsoncParse, type ParseError } from 'jsonc-parser';
import { ensureDir } from '../adapters/persistence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { hasNonFlowGuardInstructions, type FileOp, type InstallScope } from './install-types.js';
import {
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
  mandatesInstructionEntry,
} from './templates.js';

export function parseJsonc<T = Record<string, unknown>>(content: string): T {
  const errors: ParseError[] = [];
  const result = jsoncParse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new SyntaxError(`JSONC parse error at offset ${first.offset}: error code ${first.error}`);
  }
  return result as T;
}

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
  parsed['dependencies'] = deps;
  await writeJson(filePath, parsed);
  return { path: filePath, action: 'merged' };
}

function ensureNested(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!parent[key] || typeof parent[key] !== 'object' || parent[key] === null) parent[key] = {};
  return parent[key] as Record<string, unknown>;
}

export function getTaskPermissions(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!parsed['agent'] || typeof parsed['agent'] !== 'object') return null;
  const build = (parsed['agent'] as Record<string, unknown>)['build'];
  if (!build || typeof build !== 'object') return null;
  const permission = (build as Record<string, unknown>)['permission'];
  if (!permission || typeof permission !== 'object') return null;
  const task = (permission as Record<string, unknown>)['task'];
  if (!task || typeof task !== 'object') return null;
  return task as Record<string, unknown>;
}

export function mergeReviewerTaskPermission(parsed: Record<string, unknown>): void {
  const existingTask = getTaskPermissions(parsed);
  if (existingTask) {
    if (!('*' in existingTask)) existingTask['*'] = 'deny';
    existingTask[REVIEWER_SUBAGENT_TYPE] = 'allow';
    return;
  }

  const agent = ensureNested(parsed, 'agent');
  const build = ensureNested(agent, 'build');
  const permission = ensureNested(build, 'permission');
  permission['task'] = { '*': 'deny', [REVIEWER_SUBAGENT_TYPE]: 'allow' };
}

function hasCustomerTaskPermissions(parsed: Record<string, unknown>): boolean {
  const task = getTaskPermissions(parsed);
  return task !== null && Object.keys(task).length > 0;
}

function instructionsFrom(parsed: Record<string, unknown>): string[] {
  return Array.isArray(parsed['instructions']) ? (parsed['instructions'] as string[]) : [];
}

async function writeJson(filePath: string, parsed: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

function isCustomerOwnedConfig(parsed: Record<string, unknown>, instructions: string[]): boolean {
  return (
    'plugin' in parsed ||
    hasNonFlowGuardInstructions(instructions) ||
    hasCustomerTaskPermissions(parsed)
  );
}

async function mergeCustomerOwnedConfig(
  filePath: string,
  parsed: Record<string, unknown>,
  instructions: string[],
  entry: string,
): Promise<FileOp> {
  if (!instructions.includes(entry)) instructions.push(entry);
  parsed['instructions'] = instructions;
  await writeJson(filePath, parsed);
  return {
    path: filePath,
    action: 'merged',
    reason: 'customer-owned config: preserved task permissions and merged FlowGuard instruction',
  };
}

async function mergeManagedConfig(
  filePath: string,
  parsed: Record<string, unknown>,
  instructions: string[],
  entry: string,
): Promise<FileOp> {
  parsed['instructions'] = [...instructions.filter((instruction) => instruction !== entry), entry];
  mergeReviewerTaskPermission(parsed);
  if (!parsed['$schema']) parsed['$schema'] = 'https://opencode.ai/config.json';
  await writeJson(filePath, parsed);
  return { path: filePath, action: 'merged' };
}

async function overwriteMalformedOpencode(
  filePath: string,
  existing: string,
  entry: string,
): Promise<FileOp> {
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

export async function mergeOpencodeJson(filePath: string, scope: InstallScope): Promise<FileOp> {
  const entry = mandatesInstructionEntry(scope);
  const existing = await safeRead(filePath);
  if (!existing) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, OPENCODE_JSON_TEMPLATE(entry), 'utf-8');
    return { path: filePath, action: 'written' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(existing);
  } catch {
    return overwriteMalformedOpencode(filePath, existing, entry);
  }

  const instructions = instructionsFrom(parsed);
  return isCustomerOwnedConfig(parsed, instructions)
    ? mergeCustomerOwnedConfig(filePath, parsed, instructions, entry)
    : mergeManagedConfig(filePath, parsed, instructions, entry);
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

  if (task[REVIEWER_SUBAGENT_TYPE] !== 'allow') return false;
  delete task[REVIEWER_SUBAGENT_TYPE];
  if (task['*'] === 'deny') delete task['*'];
  if (Object.keys(task).length === 0) delete permission['task'];
  cleanupEmptyParents(parsed, agent, build, permission);
  return true;
}

async function removeFlowGuardOnly(
  parsed: Record<string, unknown>,
  scope: InstallScope,
  removeManagedTaskHardening: boolean,
): Promise<boolean> {
  const entry = mandatesInstructionEntry(scope);
  const hasInstructions = Array.isArray(parsed['instructions']);
  const before = hasInstructions ? (parsed['instructions'] as string[]) : [];
  const after = before.filter((instruction) => instruction !== entry);
  const removedInstruction = after.length !== before.length;
  const removedTaskHardening = removeManagedTaskHardening ? removeTaskHardening(parsed) : false;
  if (hasInstructions) parsed['instructions'] = after;
  return removedInstruction || removedTaskHardening;
}

function removeFlowGuardInstruction(
  parsed: Record<string, unknown>,
  instructions: string[],
  scope: InstallScope,
): boolean {
  const entry = mandatesInstructionEntry(scope);
  const after = instructions.filter((instruction) => instruction !== entry);
  if (after.length === instructions.length) return false;
  parsed['instructions'] = after;
  return true;
}

async function removeFromCustomerOwned(
  filePath: string,
  parsed: Record<string, unknown>,
  instructions: string[],
  scope: InstallScope,
  removeManagedTaskHardening: boolean,
): Promise<FileOp> {
  const removedInstruction = removeFlowGuardInstruction(parsed, instructions, scope);
  const removedTaskHardening = removeManagedTaskHardening ? removeTaskHardening(parsed) : false;
  if (!removedInstruction && !removedTaskHardening) {
    return {
      path: filePath,
      action: 'skipped',
      reason: 'no provably FlowGuard-owned entries found',
    };
  }
  await writeJson(filePath, parsed);
  return {
    path: filePath,
    action: 'merged',
    reason: removedTaskHardening
      ? 'removed FlowGuard instruction and provenance-owned task hardening'
      : 'removed FlowGuard instruction; preserved customer task permissions',
  };
}

async function removeFromManagedConfig(
  filePath: string,
  parsed: Record<string, unknown>,
  scope: InstallScope,
  removeManagedTaskHardening: boolean,
): Promise<FileOp> {
  const removed = await removeFlowGuardOnly(parsed, scope, removeManagedTaskHardening);
  if (!removed) {
    return {
      path: filePath,
      action: 'skipped',
      reason: 'no provably FlowGuard-owned entries found',
    };
  }
  await writeJson(filePath, parsed);
  return { path: filePath, action: 'merged', reason: 'removed FlowGuard instruction entries' };
}

export async function removeFromOpencodeJson(
  filePath: string,
  scope: InstallScope,
  options: { removeManagedTaskHardening?: boolean } = {},
): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) return { path: filePath, action: 'not_found' };

  try {
    const parsed = parseJsonc(existing);
    const instructions = instructionsFrom(parsed);
    const removeHardening = options.removeManagedTaskHardening === true;
    return isCustomerOwnedConfig(parsed, instructions)
      ? await removeFromCustomerOwned(filePath, parsed, instructions, scope, removeHardening)
      : await removeFromManagedConfig(filePath, parsed, scope, removeHardening);
  } catch {
    getAdapterLogger().warn('cli', 'Opencode.json malformed during uninstall, skipping removal', {
      filePath,
    });
    return { path: filePath, action: 'skipped', reason: 'malformed JSON' };
  }
}
