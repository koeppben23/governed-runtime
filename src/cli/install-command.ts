/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * @version v5
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type { CliArgs, CliResult, FileOp } from './install-helpers.js';
import type { InstallContext, SnapshotResult } from './install-steps.js';
import {
  initInstallContext,
  validateTarball,
  buildRollbackSnapshot,
  writeArtifacts,
  writeConfigFiles,
  emitPostInstallWarnings,
  resolveConfigTargetDir,
} from './install-steps.js';
import { rollbackArtifacts, toCliError } from './install-helpers.js';
import { detectOpenCodeRuntimeEvidence } from './opencode-runtime-detect.js';
import { classifyOpenCodeRuntime } from './opencode-runtime-compat.js';
import { defaultReasonRegistry } from '../config/reasons.js';
import {
  createDependencyTransaction,
  executeDependencyTransaction,
  commitDependencyTransaction,
  rollbackDependencyTransaction,
  isRollbackPossible,
  recoverOrAbort,
  type DependencyTransaction,
} from './install-transaction.js';

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

// ─── Lock ─────────────────────────────────────────────────────────────────────

async function acquireInstallLock(): Promise<{ release(): void }> {
  const lockPath = installLockPath();
  const token = randomUUID();
  const lock = { pid: process.pid, token, createdAt: new Date().toISOString() };
  // Ensure lock parent exists, fail-closed on unexpected errors
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
      if (JSON.parse(raw).token === token) {
        unlinkSync(lockPath);
        return;
      }
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        getAdapterLogger().warn('cli', 'lock release failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
  };
  process.on('exit', release);
  return { release };
}

// ─── Preflight ────────────────────────────────────────────────────────────────

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
    if (created)
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

// ─── Rollback helpers ────────────────────────────────────────────────────────

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

// ─── Install orchestrator ─────────────────────────────────────────────────────

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

// ─── Instruction-source compatibility gate ────────────────────────────────────

/**
 * Instruction-source compatibility gate for install.
 *
 * Runs AFTER artifacts are written (write-but-refuse posture): a positively
 * known-incompatible runtime does not roll back the install but pushes a
 * blocking error + warning carrying the OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED
 * reason, so the install result is not clean/active. Compatible, unknown and
 * Desktop runtimes pass silently (evidence is still logged by the detector).
 */
async function enforceInstructionSourceCompat(ctx: InstallContext): Promise<void> {
  if (ctx.installPlatform !== 'opencode') return;

  const evidence = await detectOpenCodeRuntimeEvidence({
    scope: ctx.args.installScope,
    platform: 'opencode',
    target: ctx.target,
  });
  const classification = classifyOpenCodeRuntime(evidence);
  if (classification.compatibility !== 'known-incompatible') return;

  const formatted = defaultReasonRegistry.format('OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED', {
    runtimeLine: evidence.runtimeLine ?? 'unknown',
    version: evidence.version ?? 'unknown',
  });
  ctx.warnings.push(
    'FlowGuard artifacts were written but the detected OpenCode runtime does not resolve instruction sources — mandates are NOT active.',
  );
  ctx.errors.push(formatted.reason);
  ctx.errorDetails.push({ message: formatted.reason });
}

async function doInstall(args: CliArgs): Promise<CliResult> {
  let snapshot: SnapshotResult | null = null;
  let tx: DependencyTransaction | null = null;

  const ctx = initInstallContext(args);

  try {
    const configTargetDir = resolveConfigTargetDir(ctx);
    await recoverOrAbort(configTargetDir);

    const cfgPath = join(configTargetDir, 'flowguard.json');
    if (existsSync(cfgPath) && !args.force) {
      return {
        target: ctx.target,
        ops: [],
        errors: ['FlowGuard is already installed. Use --force to reinstall.'],
        errorDetails: [
          {
            code: 'ALREADY_INSTALLED',
            message: 'FlowGuard is already installed. Use --force to reinstall.',
          },
        ],
        warnings: [],
        notices: [],
      };
    }

    await runInstallPreflight(ctx, configTargetDir);

    const tarball = await validateTarball(ctx);
    if (!tarball)
      return {
        target: ctx.target,
        ops: ctx.ops,
        errors: ctx.errors,
        errorDetails: ctx.errorDetails,
        warnings: ctx.warnings,
        notices: ctx.notices,
      };

    snapshot = await buildRollbackSnapshot(ctx, tarball.name);
    await writeArtifacts(ctx, tarball, snapshot);
    await writeConfigFiles(ctx, snapshot);

    // Instruction-source compatibility gate (write-but-refuse posture).
    // Artifacts are already written; if the runtime is positively known to be
    // incompatible we surface a blocking error + warning so the install does
    // not report a clean/active result. Compatible/unknown/Desktop pass.
    await enforceInstructionSourceCompat(ctx);

    // Create transaction before any dependency mutations
    tx = await createDependencyTransaction(snapshot, snapshot.vendorTarballPath);
    await executeDependencyTransaction(tx);
    await commitDependencyTransaction(tx, ctx);

    emitPostInstallWarnings(ctx);
    return {
      target: ctx.target,
      ops: ctx.ops,
      errors: ctx.errors,
      errorDetails: ctx.errorDetails,
      warnings: ctx.warnings,
      notices: ctx.notices,
    };
  } catch (error) {
    const formattedError = formatInstallError(error);
    ctx.errors.push(formattedError);
    ctx.errorDetails.push(toCliError(error));
    await rollbackDeps(tx, ctx.errors);
    await rollbackSnap(snapshot, ctx.ops, ctx.errors);
    getAdapterLogger().error('cli', 'install command failed', {
      error: formattedError,
    });
    return {
      target: ctx.target,
      ops: ctx.ops,
      errors: ctx.errors,
      errorDetails: ctx.errorDetails,
      warnings: ctx.warnings,
      notices: ctx.notices,
    };
  }
}
