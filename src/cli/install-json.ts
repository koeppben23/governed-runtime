/**
 * @module cli/install-json
 * @description JSON merge helpers for the FlowGuard CLI installer.
 *
 * Extracted from install-helpers.ts. Contains package.json and opencode.json
 * merge logic, plus JSONC parsing and backup utilities.
 *
 * @version v1
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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

export function mergeReviewerTaskPermission(parsed: Record<string, unknown>): void {
  type AnyObj = Record<string, unknown>;

  if (!parsed['agent'] || typeof parsed['agent'] !== 'object' || parsed['agent'] === null) {
    parsed['agent'] = {};
  }
  const agent = parsed['agent'] as AnyObj;

  if (!agent['build'] || typeof agent['build'] !== 'object' || agent['build'] === null) {
    agent['build'] = {};
  }
  const build = agent['build'] as AnyObj;

  if (
    !build['permission'] ||
    typeof build['permission'] !== 'object' ||
    build['permission'] === null
  ) {
    build['permission'] = {};
  }
  const permission = build['permission'] as AnyObj;

  if (
    !permission['task'] ||
    typeof permission['task'] !== 'object' ||
    permission['task'] === null
  ) {
    permission['task'] = {};
  }

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

export async function removeFromOpencodeJson(
  filePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) {
    return { path: filePath, action: 'not_found' };
  }

  try {
    const parsed = parseJsonc(existing);

    const existingInstructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];
    const hasDesktopInstructions = hasNonFlowGuardInstructions(existingInstructions);
    const hasPluginField = 'plugin' in parsed;

    if (hasDesktopInstructions || hasPluginField) {
      const entry = mandatesInstructionEntry(scope);
      const hadInstructions = Array.isArray(parsed['instructions']);
      const before = existingInstructions;
      const after = before.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);
      const removedInstruction = after.length !== before.length;

      if (!removedInstruction) {
        return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
      }

      if (hadInstructions || after.length > 0) {
        parsed['instructions'] = after;
      }
      await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      return { path: filePath, action: 'merged', reason: 'removed FlowGuard entries' };
    }

    const entry = mandatesInstructionEntry(scope);
    const hasInstructions = Array.isArray(parsed['instructions']);
    const before = hasInstructions ? (parsed['instructions'] as string[]) : [];
    const after = before.filter((i) => i !== entry && i !== LEGACY_INSTRUCTION_ENTRY);
    const removedInstruction = after.length !== before.length;

    let removedTaskHardening = false;
    if (parsed['agent'] && typeof parsed['agent'] === 'object') {
      const agent = parsed['agent'] as Record<string, unknown>;
      if (agent['build'] && typeof agent['build'] === 'object') {
        const build = agent['build'] as Record<string, unknown>;
        if (build['permission'] && typeof build['permission'] === 'object') {
          const permission = build['permission'] as Record<string, unknown>;
          if (permission['task'] && typeof permission['task'] === 'object') {
            const task = permission['task'] as Record<string, unknown>;
            if (task[REVIEWER_SUBAGENT_TYPE] === 'allow') {
              delete task[REVIEWER_SUBAGENT_TYPE];
              removedTaskHardening = true;
            }
            if (task['*'] === 'deny' && Object.keys(task).filter((k) => k !== '*').length === 0) {
              delete task['*'];
              removedTaskHardening = true;
            }
            if (Object.keys(task).length === 0) delete permission['task'];
          }
          if (Object.keys(permission).length === 0) delete build['permission'];
        }
        if (Object.keys(build).length === 0) delete agent['build'];
      }
      if (Object.keys(agent).length === 0) delete parsed['agent'];
    }

    if (!removedInstruction && !removedTaskHardening) {
      return { path: filePath, action: 'skipped', reason: 'no FlowGuard entries found' };
    }

    if (hasInstructions) {
      parsed['instructions'] = after;
    }
    await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return { path: filePath, action: 'merged', reason: 'removed FlowGuard instruction entries' };
  } catch {
    getAdapterLogger().warn('cli', 'Opencode.json malformed during uninstall, skipping removal', {
      filePath,
    });
    return { path: filePath, action: 'skipped', reason: 'malformed JSON' };
  }
}
