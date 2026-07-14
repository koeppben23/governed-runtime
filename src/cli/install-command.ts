/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * The install() function orchestrates named steps from install-steps.ts.
 * Each step has a single responsibility and is independently testable.
 *
 * @version v4
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type { CliArgs, CliResult } from './install-helpers.js';
import type { SnapshotResult } from './install-steps.js';
import {
  initInstallContext,
  validateTarball,
  buildRollbackSnapshot,
  writeArtifacts,
  writeConfigFiles,
  emitPostInstallWarnings,
} from './install-steps.js';
import { rollbackArtifacts } from './install-helpers.js';
import {
  installDependenciesStaged,
  commitDependencyTransaction,
  rollbackDependencyTransaction,
  isRollbackPossible,
  type DependencyTransaction,
} from './install-transaction.js';

// Re-export rollback utilities from their canonical location for backward compatibility.
export {
  detectPackageManager,
  type RollbackEntry,
  rollbackArtifacts,
  snapshotForRollback,
} from './install-helpers.js';

// ─── Lock ────────────────────────────────────────────────────────────────────

interface InstallLock {
  pid: number;
  token: string;
  createdAt: string;
}

const LOCK_PATH = join(homedir(), '.config', 'opencode', '.flowguard-install.lock');

async function acquireInstallLock(): Promise<{ release(): void }> {
  const lock: InstallLock = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  try {
    await writeFile(LOCK_PATH, JSON.stringify(lock), { flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      let existing: InstallLock;
      try {
        existing = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as InstallLock;
      } catch {
        throw new Error(
          `Install lock exists but is unreadable or malformed.\nRemove ${LOCK_PATH} manually after confirming no install is running.`,
        );
      }
      throw new Error(
        `Install already in progress or a stale lock exists (PID: ${existing.pid}).\n` +
          `If no install process is running, remove ${LOCK_PATH} manually.`,
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
      const raw = readFileSync(LOCK_PATH, 'utf-8');
      const current = JSON.parse(raw) as InstallLock;
      if (current.token === lock.token) {
        unlinkSync(LOCK_PATH);
      }
    } catch {
      // best-effort
    }
  };
  process.on('exit', release);
  return { release };
}

// ─── Preflight ───────────────────────────────────────────────────────────────

async function probeWritable(dir: string): Promise<void> {
  const probePath = join(dir, `.flowguard-write-test.${randomUUID()}`);
  let created = false;
  try {
    await writeFile(probePath, '', { flag: 'wx' });
    created = true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      created = true;
    } else {
      throw err;
    }
  } finally {
    if (created) {
      try {
        unlinkSync(probePath);
      } catch {
        /* ok */
      }
    }
  }
}

// ─── Main install orchestrator ───────────────────────────────────────────────

/**
 * Install FlowGuard into the target config directory.
 *
 * Orchestrates: lock → preflight → validate → snapshot → write artifacts →
 * config → dependencies (staged) → commit → warnings.
 *
 * On failure before commit: rolls back dependency transaction and artifacts.
 * After commit: installation is live; cleanup is retried on next run.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  let snapshot: SnapshotResult | null = null;
  let tx: DependencyTransaction | null = null;

  try {
    // Lock + Preflight
    const lock = await acquireInstallLock();
    const ctx = initInstallContext(args);

    // Pre-flight: existing installation
    const cfgPath = join(ctx.target, 'flowguard.json');
    if (existsSync(cfgPath) && !args.force) {
      lock.release();
      return {
        target: ctx.target,
        ops: [],
        errors: ['FlowGuard is already installed. Use --force to reinstall.'],
        warnings: [],
      };
    }

    // Pre-flight: writability
    if (existsSync(dirname(ctx.target))) {
      await probeWritable(dirname(ctx.target));
    }

    try {
      const tarball = await validateTarball(ctx);
      if (!tarball) {
        lock.release();
        return {
          target: ctx.target,
          ops: ctx.ops,
          errors: ctx.errors,
          warnings: ctx.warnings,
        };
      }

      snapshot = await buildRollbackSnapshot(ctx, tarball.name);
      await writeArtifacts(ctx, tarball, snapshot);
      await writeConfigFiles(ctx, snapshot);

      // Dependency transaction via staging
      tx = await installDependenciesStaged(ctx, snapshot, snapshot.vendorTarballPath);
      await commitDependencyTransaction(tx, ctx);

      lock.release();
      emitPostInstallWarnings(ctx);
      return {
        target: ctx.target,
        ops: ctx.ops,
        errors: ctx.errors,
        warnings: ctx.warnings,
      };
    } catch (err) {
      // Rollback dependency transaction
      if (tx && isRollbackPossible(tx)) {
        try {
          await rollbackDependencyTransaction(tx);
        } catch (rollbackErr) {
          ctx.errors.push(
            `Dependency rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        }
      }

      // Rollback artifacts
      if (snapshot) {
        try {
          await rollbackArtifacts(snapshot.rollbackEntries, ctx.ops, ctx.errors);
        } catch (rollbackErr2) {
          ctx.errors.push(
            `Artifact rollback failed: ${rollbackErr2 instanceof Error ? rollbackErr2.message : String(rollbackErr2)}`,
          );
        }
      }

      ctx.errors.push(err instanceof Error ? err.message : String(err));
      lock.release();
      getAdapterLogger().error('cli', 'install command failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        target: ctx.target,
        ops: ctx.ops,
        errors: ctx.errors,
        warnings: ctx.warnings,
      };
    }
  } catch (lockErr) {
    return {
      target: '',
      ops: [],
      errors: [lockErr instanceof Error ? lockErr.message : String(lockErr)],
      warnings: [],
    };
  }
}
