/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * @version v4
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type { CliArgs, CliResult, FileOp } from './install-helpers.js';
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

export {
  detectPackageManager,
  type RollbackEntry,
  rollbackArtifacts,
  snapshotForRollback,
} from './install-helpers.js';

const DEFAULT_LOCK_PATH = join(homedir(), '.config', 'opencode', '.flowguard-install.lock');
const LOCK_PATH = process.env['FLOWGUARD_INSTALL_LOCK_PATH'] ?? DEFAULT_LOCK_PATH;

// ─── Lock ─────────────────────────────────────────────────────────────────────

async function acquireInstallLock(): Promise<{ release(): void }> {
  const token = randomUUID();
  const lock = { pid: process.pid, token, createdAt: new Date().toISOString() };

  try {
    await writeFile(LOCK_PATH, JSON.stringify(lock), { flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      let existing: { pid: number };
      try {
        existing = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
      } catch {
        throw new Error(`Install lock exists but is unreadable. Remove ${LOCK_PATH} manually.`);
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
      const current = JSON.parse(raw);
      if (current.token === token) unlinkSync(LOCK_PATH);
    } catch {
      // best-effort
    }
  };
  process.on('exit', release);
  return { release };
}

// ─── Preflight ────────────────────────────────────────────────────────────────

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

// ─── Rollback helpers ────────────────────────────────────────────────────────

async function rollbackDeps(tx: DependencyTransaction | null, errors: string[]): Promise<void> {
  if (!tx || !isRollbackPossible(tx)) return;
  try {
    await rollbackDependencyTransaction(tx);
  } catch (err) {
    errors.push(`Dependency rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function rollbackSnapshot(
  snapshot: SnapshotResult | null,
  ops: FileOp[],
  errors: string[],
): Promise<void> {
  if (!snapshot) return;
  try {
    await rollbackArtifacts(snapshot.rollbackEntries, ops, errors);
  } catch (err) {
    errors.push(`Artifact rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Install orchestrator ─────────────────────────────────────────────────────

export async function install(args: CliArgs): Promise<CliResult> {
  let snapshot: SnapshotResult | null = null;
  let tx: DependencyTransaction | null = null;

  let lock: { release(): void } | null = null;
  try {
    lock = await acquireInstallLock();
  } catch (lockErr) {
    return {
      target: '',
      ops: [],
      errors: [lockErr instanceof Error ? lockErr.message : String(lockErr)],
      warnings: [],
    };
  }

  const ctx = initInstallContext(args);

  // Existing installation check
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

  // Writability preflight
  if (existsSync(dirname(ctx.target))) {
    await probeWritable(dirname(ctx.target));
  }

  try {
    const tarball = await validateTarball(ctx);
    if (!tarball) {
      lock.release();
      return { target: ctx.target, ops: ctx.ops, errors: ctx.errors, warnings: ctx.warnings };
    }

    snapshot = await buildRollbackSnapshot(ctx, tarball.name);
    await writeArtifacts(ctx, tarball, snapshot);
    await writeConfigFiles(ctx, snapshot);

    tx = await installDependenciesStaged(ctx, snapshot, snapshot.vendorTarballPath);
    await commitDependencyTransaction(tx, ctx);

    lock.release();
    emitPostInstallWarnings(ctx);
    return { target: ctx.target, ops: ctx.ops, errors: ctx.errors, warnings: ctx.warnings };
  } catch (err) {
    ctx.errors.push(err instanceof Error ? err.message : String(err));
    await rollbackDeps(tx, ctx.errors);
    await rollbackSnapshot(snapshot, ctx.ops, ctx.errors);
    lock.release();
    getAdapterLogger().error('cli', 'install command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { target: ctx.target, ops: ctx.ops, errors: ctx.errors, warnings: ctx.warnings };
  }
}
