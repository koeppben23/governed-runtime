/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * @version v5
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultReasonRegistry } from '../config/reasons.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type {
  CliArgs,
  CliResult,
  FileOp,
  RollbackEntry as InstallRollbackEntry,
} from './install-helpers.js';
import { rollbackArtifacts, snapshotForRollback, toCliError } from './install-helpers.js';
import {
  assertManagedMandatesOwnership,
  assertNoAmbiguousLegacyInstruction,
  deriveInstallOwnershipManifest,
  ownershipManifestPath,
  type InstallOwnershipManifest,
  writeInstallOwnershipManifest,
} from './install-ownership.js';
import type { InstallContext, SnapshotResult } from './install-steps.js';
import {
  buildRollbackSnapshot,
  emitPostInstallWarnings,
  initInstallContext,
  resolveConfigTargetDir,
  validateTarball,
  writeArtifacts,
  writeConfigFiles,
} from './install-steps.js';
import {
  commitDependencyTransaction,
  createDependencyTransaction,
  executeDependencyTransaction,
  isRollbackPossible,
  recoverOrAbort,
  rollbackDependencyTransaction,
  type DependencyTransaction,
} from './install-transaction.js';
import { classifyOpenCodeRuntime } from './opencode-runtime-compat.js';
import { detectOpenCodeRuntimeEvidence } from './opencode-runtime-detect.js';

export {
  detectPackageManager,
  type RollbackEntry,
  rollbackArtifacts,
  snapshotForRollback,
} from './install-helpers.js';

const DEFAULT_LOCK = join(homedir(), '.config', 'opencode', '.flowguard-install.lock');

function installLockPath(): string {
  return process.env['FLOWGUARD_INSTALL_LOCK_PATH'] ?? DEFAULT_LOCK;
}

async function acquireInstallLock(): Promise<{ release(): void }> {
  const lockPath = installLockPath();
  const token = randomUUID();
  const lock = { pid: process.pid, token, createdAt: new Date().toISOString() };
  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
  }
  try {
    await writeFile(lockPath, JSON.stringify(lock), { flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      let existing: { pid: number };
      try {
        existing = JSON.parse(readFileSync(lockPath, 'utf-8'));
      } catch {
        throw new Error(`Install lock exists but is unreadable. Remove ${lockPath} manually.`);
      }
      throw new Error(
        `Install already in progress (PID: ${existing.pid}).\n` +
          'The lock may be stale if the previous process was interrupted.\n' +
          `If no install runs, remove ${lockPath} manually.`,
      );
    }
    throw err;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      if (JSON.parse(raw).token === token) unlinkSync(lockPath);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        getAdapterLogger().warn('cli', 'lock release failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  process.on('exit', release);
  return { release };
}

async function probeWritable(dir: string): Promise<void> {
  const probe = join(dir, `.flowguard-write-test.${randomUUID()}`);
  let created = false;
  try {
    await writeFile(probe, '', { flag: 'wx' });
    created = true;
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    created = true;
  } finally {
    if (created) {
      try {
        unlinkSync(probe);
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
          getAdapterLogger().warn('cli', 'writability probe cleanup failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

function nearestExistingDirectory(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function formatInstallError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(
      (cause, index) => `  ${index + 1}. ${formatInstallError(cause).replace(/\n/g, '\n     ')}`,
    );
    return [error.message, ...causes].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

async function runInstallPreflight(ctx: InstallContext, configTargetDir: string): Promise<void> {
  const parents = new Set<string>();
  const targetParent = dirname(ctx.target);
  if (existsSync(targetParent)) parents.add(targetParent);
  if (existsSync(ctx.target)) parents.add(ctx.target);
  if (existsSync(configTargetDir)) parents.add(configTargetDir);
  else parents.add(nearestExistingDirectory(configTargetDir));
  for (const path of parents) await probeWritable(path);
}

async function rollbackDeps(tx: DependencyTransaction | null, errors: string[]): Promise<void> {
  if (!tx || !isRollbackPossible(tx)) return;
  try {
    await rollbackDependencyTransaction(tx);
  } catch (err) {
    errors.push(`Dependency rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function rollbackSnap(
  snapshot: SnapshotResult | null,
  ops: FileOp[],
  errors: string[],
): Promise<void> {
  if (!snapshot) return;
  try {
    await rollbackArtifacts(snapshot.mutationJournal.deduplicated(), ops, errors);
  } catch (err) {
    errors.push(`Artifact rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function snapshotEntry(snapshot: SnapshotResult, path: string): InstallRollbackEntry {
  const entry = snapshot.preStateEntries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Missing pre-install ownership snapshot: ${path}`);
  return entry;
}

function resultFromContext(ctx: InstallContext): CliResult {
  return {
    target: ctx.target,
    ops: ctx.ops,
    errors: ctx.errors,
    errorDetails: ctx.errorDetails,
    warnings: ctx.warnings,
    notices: ctx.notices,
  };
}

function alreadyInstalledResult(ctx: InstallContext): CliResult {
  const message = 'FlowGuard is already installed. Use --force to reinstall.';
  return {
    target: ctx.target,
    ops: [],
    errors: [message],
    errorDetails: [{ code: 'ALREADY_INSTALLED', message }],
    warnings: [],
    notices: [],
  };
}

export async function install(args: CliArgs): Promise<CliResult> {
  let lock: { release(): void } | null = null;
  try {
    lock = await acquireInstallLock();
  } catch (lockErr) {
    const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
    const lockPath = installLockPath();
    return {
      target: '',
      ops: [],
      errors: [msg],
      errorDetails: [
        { code: 'INSTALL_LOCK_CONFLICT', message: msg, recoveryContext: { path: lockPath } },
      ],
      warnings: [],
      notices: [],
    };
  }

  try {
    return await doInstall(args);
  } finally {
    lock.release();
  }
}

async function enforceInstructionSourceCompat(ctx: InstallContext): Promise<void> {
  if (ctx.installPlatform !== 'opencode') return;

  const evidence = await detectOpenCodeRuntimeEvidence({
    scope: ctx.args.installScope,
    platform: 'opencode',
    target: ctx.target,
  });
  const classification = classifyOpenCodeRuntime(evidence);

  if (classification.status === 'known-unsupported') {
    const formatted = defaultReasonRegistry.format('OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED', {
      runtimeLine: evidence.runtimeLine ?? 'unknown',
      version: evidence.version ?? 'unknown',
    });
    ctx.warnings.push(
      'The detected OpenCode runtime is known not to resolve instruction sources — installation was blocked before artifacts were written.',
    );
    ctx.errors.push(formatted.reason);
    ctx.errorDetails.push({ message: formatted.reason });
    return;
  }

  ctx.notices.push({
    kind: 'status',
    message:
      'FlowGuard mandates are configured for OpenCode. Activation depends on the runtime ' +
      'loading instructions[] into the agent context; install does not verify this. ' +
      'A present instructions[] entry does not prove activation.',
  });
}

function assertLegacyBoundary(ctx: InstallContext, snapshot: SnapshotResult): void {
  const configPreState = snapshotEntry(snapshot, snapshot.cfgPath);
  const opencodePreState = snapshot.opencodeJsonPath
    ? snapshotEntry(snapshot, snapshot.opencodeJsonPath)
    : null;
  assertNoAmbiguousLegacyInstruction({
    platform: ctx.installPlatform,
    verifiedReinstall: ctx.args.force && configPreState.existed,
    opencodeOriginalContent: opencodePreState?.originalContent,
  });
}

function deriveOwnership(ctx: InstallContext, snapshot: SnapshotResult): InstallOwnershipManifest {
  const packagePreState = snapshotEntry(snapshot, snapshot.pkgPath);
  const opencodePreState = snapshot.opencodeJsonPath
    ? snapshotEntry(snapshot, snapshot.opencodeJsonPath)
    : null;
  return deriveInstallOwnershipManifest({
    platform: ctx.installPlatform,
    scope: ctx.args.installScope,
    packageJsonExisted: packagePreState.existed,
    packageJsonOriginalContent: packagePreState.originalContent,
    opencodeOriginalContent: opencodePreState?.originalContent,
    opencodeCurrentContent: snapshot.opencodeJsonPath
      ? readFileSync(snapshot.opencodeJsonPath, 'utf-8')
      : null,
  });
}

async function persistOwnership(
  ctx: InstallContext,
  snapshot: SnapshotResult,
  ownership: InstallOwnershipManifest,
): Promise<void> {
  const path = ownershipManifestPath(ctx.target);
  const preState = await snapshotForRollback(path, 'file');
  await writeInstallOwnershipManifest(ctx.target, ownership);
  snapshot.mutationJournal.record(preState);
  ctx.ops.push({
    path,
    action: preState.existed ? 'merged' : 'written',
    reason: 'persisted installer ownership provenance before dependency commit',
  });
}

async function doInstall(args: CliArgs): Promise<CliResult> {
  let snapshot: SnapshotResult | null = null;
  let tx: DependencyTransaction | null = null;
  const ctx = initInstallContext(args);

  try {
    const configTargetDir = resolveConfigTargetDir(ctx);
    await recoverOrAbort(configTargetDir);
    await enforceInstructionSourceCompat(ctx);
    if (ctx.errors.length > 0) return resultFromContext(ctx);

    const cfgPath = join(configTargetDir, 'flowguard.json');
    if (existsSync(cfgPath) && !args.force) return alreadyInstalledResult(ctx);

    await runInstallPreflight(ctx, configTargetDir);
    const tarball = await validateTarball(ctx);
    if (!tarball) return resultFromContext(ctx);

    snapshot = await buildRollbackSnapshot(ctx, tarball.name);
    await assertManagedMandatesOwnership(snapshot.mandatesPath);
    assertLegacyBoundary(ctx, snapshot);
    await writeArtifacts(ctx, tarball, snapshot);
    await writeConfigFiles(ctx, snapshot);
    const ownership = deriveOwnership(ctx, snapshot);

    tx = await createDependencyTransaction(snapshot, snapshot.vendorTarballPath);
    await executeDependencyTransaction(tx);
    await persistOwnership(ctx, snapshot, ownership);
    await commitDependencyTransaction(tx, ctx);

    emitPostInstallWarnings(ctx);
    return resultFromContext(ctx);
  } catch (error) {
    const formattedError = formatInstallError(error);
    ctx.errors.push(formattedError);
    ctx.errorDetails.push(toCliError(error));
    await rollbackDeps(tx, ctx.errors);
    await rollbackSnap(snapshot, ctx.ops, ctx.errors);
    getAdapterLogger().error('cli', 'install command failed', { error: formattedError });
    return resultFromContext(ctx);
  }
}
