/**
 * @module cli/uninstall-command
 * @description FlowGuard uninstall command implementation.
 */

import { existsSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { globalConfigPath } from '../adapters/persistence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  MANDATES_FILENAME,
  extractManagedBody,
  extractManagedDigest,
  isManagedArtifact,
} from './templates.js';
import {
  type CliArgs,
  type CliResult,
  type FileOp,
  FLOWGUARD_OWNED_FILES,
  FLOWGUARD_TARBALL_PATTERN,
  computeMandatesDigest,
  findParallelOpencodeConfig,
  removeFromOpencodeJson,
  resolveOpencodeConfigPath,
  resolveTarget,
  safeRead,
  safeUnlink,
  sha256,
  toCliError,
} from './install-helpers.js';
import { uninstallClaudeCodePlugin, uninstallCodexPlugin } from './platform-uninstall.js';

/** True if a vendor entry is a FlowGuard-owned tarball with a valid semver/pre-release version. */
function isFlowGuardVendorArtifact(entry: string): boolean {
  return FLOWGUARD_TARBALL_PATTERN.test(entry);
}

async function cleanupVendorDir(fullPath: string): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  try {
    if (existsSync(fullPath)) {
      const entries = await readdir(fullPath);
      let removedCount = 0;
      for (const entry of entries) {
        if (isFlowGuardVendorArtifact(entry)) {
          await safeUnlink(join(fullPath, entry));
          removedCount++;
          ops.push({ path: join(fullPath, entry), action: 'removed' });
        }
      }
      const remaining = await readdir(fullPath);
      if (remaining.length === 0) {
        await rm(fullPath, { recursive: true, force: true });
        ops.push({ path: fullPath, action: 'removed', reason: 'empty vendor directory' });
      } else if (removedCount === 0) {
        ops.push({ path: fullPath, action: 'skipped', reason: 'no FlowGuard tarballs in vendor' });
      }
    } else {
      ops.push({ path: fullPath, action: 'not_found' });
    }
  } catch {
    ops.push({ path: fullPath, action: 'not_found' });
  }
  return ops;
}

async function removeMandateIfModified(fullPath: string, warnings: string[]): Promise<void> {
  const content = await safeRead(fullPath);
  if (content === null) return;
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

async function removeManagedFiles(
  target: string,
  ops: FileOp[],
  warnings: string[],
): Promise<void> {
  for (const relPath of FLOWGUARD_OWNED_FILES) {
    const fullPath = join(target, relPath);

    if (relPath === MANDATES_FILENAME) {
      await removeMandateIfModified(fullPath, warnings);
    }

    if (relPath === 'vendor') {
      ops.push(...(await cleanupVendorDir(fullPath)));
      continue;
    }

    const removed = await safeUnlink(fullPath);
    ops.push({ path: fullPath, action: removed ? 'removed' : 'not_found' });
  }
}

async function cleanupPackageJson(target: string): Promise<FileOp[]> {
  const pkgPath = join(target, 'package.json');
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) return [];
  try {
    const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
    const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
    delete deps['@flowguard/core'];
    delete deps['@opencode-ai/plugin'];

    const hasScripts = parsed['scripts'] != null && Object.keys(parsed['scripts']).length > 0;
    const hasDevDeps =
      parsed['devDependencies'] != null && Object.keys(parsed['devDependencies']).length > 0;
    const depsWithoutZod = Object.keys(deps).filter((k) => k !== 'zod');
    const knownMetaKeys = new Set([
      'name',
      'version',
      'private',
      'type',
      'dependencies',
      'description',
    ]);
    const hasForeignFields = Object.keys(parsed).some((k) => !knownMetaKeys.has(k));

    if (!hasScripts && !hasDevDeps && depsWithoutZod.length === 0 && !hasForeignFields) {
      await safeUnlink(pkgPath);
      return [{ path: pkgPath, action: 'removed', reason: 'no non-FlowGuard content' }];
    }
    parsed['dependencies'] = deps;
    if (Object.keys(deps).length === 0) delete parsed['dependencies'];
    await writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return [{ path: pkgPath, action: 'merged', reason: 'removed FlowGuard dependencies' }];
  } catch {
    return [{ path: pkgPath, action: 'skipped', reason: 'malformed JSON' }];
  }
}

async function cleanupOpencodeConfig(args: CliArgs, target: string): Promise<FileOp[]> {
  const installPlatform = args.installPlatform ?? 'opencode';
  if (installPlatform === 'opencode') {
    const opencodeJsonPath = resolveOpencodeConfigPath(args.installScope, target);
    const ops = [await removeFromOpencodeJson(opencodeJsonPath, args.installScope)];
    const parallelConfig = findParallelOpencodeConfig(opencodeJsonPath);
    if (parallelConfig) {
      ops.push(await removeFromOpencodeJson(parallelConfig, args.installScope));
    }
    return ops;
  }
  if (installPlatform === 'claude-code') {
    return uninstallClaudeCodePlugin(target);
  }
  return uninstallCodexPlugin(args.installScope);
}

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
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    await removeManagedFiles(target, ops, warnings);
    ops.push(...(await cleanupPackageJson(target)));
    ops.push(...(await cleanupOpencodeConfig(args, target)));

    const cfgPath =
      installPlatform !== 'opencode'
        ? join(target, 'flowguard.json')
        : args.installScope === 'global'
          ? globalConfigPath()
          : join(resolve('.'), '.opencode', 'flowguard.json');
    const removedCfg = await safeUnlink(cfgPath);
    ops.push({ path: cfgPath, action: removedCfg ? 'removed' : 'not_found' });
  } catch (err) {
    getAdapterLogger().error('cli', 'uninstall command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, errorDetails: errors.map(toCliError), warnings, notices: [] };
}
