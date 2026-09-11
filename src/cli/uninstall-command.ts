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
  } catch {
    ops.push({ path: fullPath, action: 'not_found' });
  }
  return ops;
}

async function mayRemoveMandate(fullPath: string, warnings: string[]): Promise<boolean> {
  const content = await safeRead(fullPath);
  if (content === null) return true;
  if (!isManagedArtifact(content)) {
    warnings.push(`${MANDATES_FILENAME} has no managed header — preserved`);
    return false;
  }

  const fileDigest = extractManagedDigest(content);
  const expectedDigest = computeMandatesDigest();
  const fileBody = extractManagedBody(content);
  const bodyModified = fileBody !== null && sha256(fileBody) !== expectedDigest;
  if ((fileDigest && fileDigest !== expectedDigest) || bodyModified) {
    warnings.push(`${MANDATES_FILENAME} was locally modified — removing FlowGuard-owned artifact`);
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
          reason: 'same-named file is not a FlowGuard managed artifact',
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
  pkgPath: string,
  ownership: InstallOwnershipManifest['packageJson'] | undefined,
  warnings: string[],
): void {
  const previous = ownership?.previousCoreDependency;
  if (previous === null) {
    delete deps['@flowguard/core'];
    return;
  }
  if (typeof previous === 'string') {
    deps['@flowguard/core'] = previous;
    return;
  }
  if (typeof deps['@flowguard/core'] === 'string') {
    warnings.push(
      `${pkgPath}: @flowguard/core ownership predates installer provenance — preserved rather than guessed`,
    );
  }
}

function restorePackageDependencies(
  parsed: Record<string, unknown>,
  pkgPath: string,
  ownership: InstallOwnershipManifest['packageJson'] | undefined,
  warnings: string[],
): void {
  const deps = { ...((parsed['dependencies'] ?? {}) as Record<string, string>) };
  restoreCoreDependency(deps, pkgPath, ownership, warnings);
  if (ownership?.zodAdded === true && deps['zod'] === '^4.0.0') delete deps['zod'];
  if (Object.keys(deps).length === 0) delete parsed['dependencies'];
  else parsed['dependencies'] = deps;
}

function packageCleanupReason(
  ownership: InstallOwnershipManifest['packageJson'] | undefined,
): string {
  return ownership
    ? 'restored installer-owned dependency changes from provenance'
    : 'preserved package because dependency ownership is not provable';
}

async function cleanupPackageJson(
  target: string,
  ownership: InstallOwnershipManifest | null,
  warnings: string[],
): Promise<FileOp[]> {
  const pkgPath = join(target, 'package.json');
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) return [];

  try {
    const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
    const packageOwnership = ownership?.packageJson;
    restorePackageDependencies(parsed, pkgPath, packageOwnership, warnings);

    const restoreAbsent =
      packageOwnership?.created === true &&
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

    await writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return [
      {
        path: pkgPath,
        action: 'merged',
        reason: packageCleanupReason(packageOwnership),
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
    const ownership = await readInstallOwnershipManifest(target);
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

    const manifestPath = ownershipManifestPath(target);
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
