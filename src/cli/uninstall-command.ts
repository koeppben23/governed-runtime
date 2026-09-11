/**
 * @module cli/uninstall-command
 * @description FlowGuard uninstall command implementation.
 */

import { existsSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { globalConfigPath } from '../adapters/persistence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  type CliArgs,
  type CliResult,
  type FileOp,
  type InstallPlatform,
  FLOWGUARD_OWNED_FILES,
  FLOWGUARD_TARBALL_PATTERN,
  computeMandatesDigest,
  findParallelOpencodeConfig,
  removeFromOpencodeJson,
  resolveOpencodeConfigPath,
  resolveTarget,
  reviewerDefinitionForPlatform,
  safeRead,
  safeUnlink,
  sha256,
  toCliError,
} from './install-helpers.js';
import {
  ownershipManifestPath,
  readInstallOwnershipManifest,
  type InstallOwnershipManifest,
} from './install-ownership.js';
import { uninstallClaudeCodePlugin, uninstallCodexPlugin } from './platform-uninstall.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  PLUGIN_WRAPPER,
  TOOL_WRAPPER,
  extractManagedBody,
  extractManagedDigest,
  isManagedArtifact,
} from './templates.js';

function isFlowGuardVendorArtifact(entry: string): boolean {
  return FLOWGUARD_TARBALL_PATTERN.test(entry);
}

async function cleanupVendorDir(fullPath: string): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  try {
    if (!existsSync(fullPath)) return [{ path: fullPath, action: 'not_found' }];
    const entries = await readdir(fullPath);
    let removedCount = 0;
    for (const entry of entries) {
      if (!isFlowGuardVendorArtifact(entry)) continue;
      await safeUnlink(join(fullPath, entry));
      removedCount++;
      ops.push({ path: join(fullPath, entry), action: 'removed' });
    }
    const remaining = await readdir(fullPath);
    if (remaining.length === 0) {
      await rm(fullPath, { recursive: true, force: true });
      ops.push({ path: fullPath, action: 'removed', reason: 'empty vendor directory' });
    } else if (removedCount === 0) {
      ops.push({ path: fullPath, action: 'skipped', reason: 'no FlowGuard tarballs in vendor' });
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [{ path: fullPath, action: 'not_found' }];
    }
    throw error;
  }
  return ops;
}

async function mayRemoveMandate(fullPath: string, warnings: string[]): Promise<boolean> {
  const content = await safeRead(fullPath);
  if (content === null) return true;
  if (!isManagedArtifact(content)) {
    warnings.push(`${MANDATES_FILENAME} has no valid managed envelope — preserved`);
    return false;
  }

  const fileDigest = extractManagedDigest(content);
  const expectedDigest = computeMandatesDigest();
  const fileBody = extractManagedBody(content);
  const bodyModified = fileBody !== null && sha256(fileBody) !== expectedDigest;
  if ((fileDigest && fileDigest !== expectedDigest) || bodyModified) {
    warnings.push(
      `${MANDATES_FILENAME} is FlowGuard-owned but from a different canonical mandate revision`,
    );
  }
  return true;
}

function expectedOpenCodeFile(relPath: string): string | null {
  if (relPath === 'tools/flowguard.ts') return TOOL_WRAPPER;
  if (relPath === 'plugins/flowguard-audit.ts') return PLUGIN_WRAPPER;
  const reviewer = reviewerDefinitionForPlatform('opencode');
  if (relPath === reviewer.relativePath) return reviewer.content;
  if (relPath.startsWith('commands/')) return COMMANDS[basename(relPath)] ?? null;
  return null;
}

async function removeExactManagedFile(
  fullPath: string,
  expectedContent: string,
  warnings: string[],
): Promise<FileOp> {
  const content = await safeRead(fullPath);
  if (content === null) return { path: fullPath, action: 'not_found' };
  if (content !== expectedContent) {
    warnings.push(`${fullPath} differs from the FlowGuard-managed template — preserved`);
    return { path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' };
  }
  await safeUnlink(fullPath);
  return { path: fullPath, action: 'removed' };
}

async function removeManagedFiles(
  target: string,
  platform: InstallPlatform,
  ops: FileOp[],
  warnings: string[],
): Promise<void> {
  for (const relPath of FLOWGUARD_OWNED_FILES) {
    const fullPath = join(target, relPath);

    if (relPath === MANDATES_FILENAME) {
      if (!(await mayRemoveMandate(fullPath, warnings))) {
        ops.push({
          path: fullPath,
          action: 'skipped',
          reason: 'same-named file is not a cryptographically valid FlowGuard managed artifact',
        });
      } else {
        const removed = await safeUnlink(fullPath);
        ops.push({ path: fullPath, action: removed ? 'removed' : 'not_found' });
      }
      continue;
    }

    if (relPath === 'vendor') {
      ops.push(...(await cleanupVendorDir(fullPath)));
      continue;
    }

    if (platform !== 'opencode') continue;
    const expected = expectedOpenCodeFile(relPath);
    if (expected === null) {
      if (existsSync(fullPath)) {
        warnings.push(
          `${fullPath} has no provable OpenCode FlowGuard template ownership — preserved`,
        );
        ops.push({ path: fullPath, action: 'skipped', reason: 'ownership not proven' });
      }
      continue;
    }
    ops.push(await removeExactManagedFile(fullPath, expected, warnings));
  }
}

function isGeneratedPackageShell(parsed: Record<string, unknown>): boolean {
  const allowed = new Set(['name', 'version', 'private', 'dependencies']);
  return (
    parsed['name'] === '@flowguard/opencode-runtime' &&
    parsed['private'] === true &&
    Object.keys(parsed).every((key) => allowed.has(key))
  );
}

function restoreCoreDependency(
  deps: Record<string, string>,
  ownership: InstallOwnershipManifest['packageJson'],
): void {
  const previous = ownership.previousCoreDependency;
  if (previous === null) {
    delete deps['@flowguard/core'];
    return;
  }
  deps['@flowguard/core'] = previous;
}

function restorePackageDependencies(
  parsed: Record<string, unknown>,
  ownership: InstallOwnershipManifest['packageJson'],
): void {
  const deps = { ...((parsed['dependencies'] ?? {}) as Record<string, string>) };
  restoreCoreDependency(deps, ownership);
  if (ownership.zodAdded === true && deps['zod'] === '^4.0.0') delete deps['zod'];
  if (Object.keys(deps).length === 0) delete parsed['dependencies'];
  else parsed['dependencies'] = deps;
}

async function cleanupPackageJson(
  target: string,
  ownership: InstallOwnershipManifest | null,
  warnings: string[],
): Promise<FileOp[]> {
  const pkgPath = join(target, 'package.json');
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) return [];

  if (ownership === null) {
    warnings.push(
      `${pkgPath}: dependency ownership is not provable — preserving package.json byte-for-byte`,
    );
    return [
      { path: pkgPath, action: 'skipped', reason: 'ownership not proven; no mutation performed' },
    ];
  }

  try {
    const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
    const packageOwnership = ownership.packageJson;
    restorePackageDependencies(parsed, packageOwnership);

    const restoreAbsent =
      packageOwnership.created === true &&
      isGeneratedPackageShell(parsed) &&
      !parsed['dependencies'];
    if (restoreAbsent) {
      await safeUnlink(pkgPath);
      return [
        {
          path: pkgPath,
          action: 'removed',
          reason: 'installer-created package restored to absent pre-state',
        },
      ];
    }

    const updated = JSON.stringify(parsed, null, 2) + '\n';
    if (updated === pkgContent) {
      return [
        { path: pkgPath, action: 'skipped', reason: 'owned dependency state already restored' },
      ];
    }
    await writeFile(pkgPath, updated, 'utf-8');
    return [
      {
        path: pkgPath,
        action: 'merged',
        reason: 'restored installer-owned dependency changes from provenance',
      },
    ];
  } catch {
    return [{ path: pkgPath, action: 'skipped', reason: 'malformed JSON' }];
  }
}

async function cleanupOpencodeConfig(
  args: CliArgs,
  target: string,
  ownership: InstallOwnershipManifest | null,
): Promise<FileOp[]> {
  const installPlatform = args.installPlatform ?? 'opencode';
  if (installPlatform === 'opencode') {
    const opencodeJsonPath = resolveOpencodeConfigPath(args.installScope, target);
    const ops = [
      await removeFromOpencodeJson(opencodeJsonPath, args.installScope, {
        removeManagedTaskHardening: ownership?.opencode?.taskHardeningAdded === true,
      }),
    ];
    const parallelConfig = findParallelOpencodeConfig(opencodeJsonPath);
    if (parallelConfig) ops.push(await removeFromOpencodeJson(parallelConfig, args.installScope));
    return ops;
  }
  if (installPlatform === 'claude-code') return uninstallClaudeCodePlugin(target);
  return uninstallCodexPlugin(args.installScope);
}

export async function uninstall(args: CliArgs): Promise<CliResult> {
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const manifestPath = ownershipManifestPath(target);
    const ownership = await readInstallOwnershipManifest(target);
    if (ownership === null && existsSync(manifestPath)) {
      throw new Error(
        `${manifestPath} exists but is not a valid FlowGuard ownership manifest; refusing uninstall because ownership cannot be proven`,
      );
    }

    await removeManagedFiles(target, installPlatform, ops, warnings);
    ops.push(...(await cleanupPackageJson(target, ownership, warnings)));
    ops.push(...(await cleanupOpencodeConfig(args, target, ownership)));

    const cfgPath =
      installPlatform !== 'opencode'
        ? join(target, 'flowguard.json')
        : args.installScope === 'global'
          ? globalConfigPath()
          : join(resolve('.'), '.opencode', 'flowguard.json');
    const removedCfg = await safeUnlink(cfgPath);
    ops.push({ path: cfgPath, action: removedCfg ? 'removed' : 'not_found' });

    const removedManifest = await safeUnlink(manifestPath);
    ops.push({ path: manifestPath, action: removedManifest ? 'removed' : 'not_found' });
  } catch (err) {
    getAdapterLogger().error('cli', 'uninstall command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, errorDetails: errors.map(toCliError), warnings, notices: [] };
}
