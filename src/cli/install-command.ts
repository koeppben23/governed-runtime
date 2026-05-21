/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * The install() function orchestrates named steps from install-steps.ts.
 * Each step has a single responsibility and is independently testable.
 *
 * @version v2
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type { CliArgs, CliResult, FileOp } from './install-helpers.js';
import {
  initInstallContext,
  validateTarball,
  buildRollbackSnapshot,
  writeArtifacts,
  writeConfigFiles,
  installDependencies,
  emitPostInstallWarnings,
} from './install-steps.js';

// ─── Exported utilities (consumed by install-steps.ts) ───────────────────────

/** Detect available package manager. Prefers bun (OpenCode runtime), falls back to npm. */
export function detectPackageManager(): 'bun' | 'npm' | null {
  const opts = { stdio: 'ignore' as const, timeout: 5_000 };
  try {
    execSync('bun --version', opts);
    return 'bun';
  } catch {
    // bun not available
  }
  try {
    execSync('npm --version', opts);
    return 'npm';
  } catch {
    // npm not available
  }
  return null;
}

/** Pre-install snapshot for transactional rollback. */
export interface RollbackEntry {
  path: string;
  existed: boolean;
  originalContent?: Buffer;
}

/**
 * Snapshot a file path before any modification.
 * Reads original content as Buffer so binary artifacts (e.g. tarball) are preserved exactly.
 */
export async function snapshotForRollback(filePath: string): Promise<RollbackEntry> {
  if (existsSync(filePath)) {
    try {
      const content = await readFile(filePath);
      return { path: filePath, existed: true, originalContent: content };
    } catch {
      return { path: filePath, existed: true };
    }
  }
  return { path: filePath, existed: false };
}

/**
 * Rollback install artifacts after a failed auto-install step.
 *
 * Uniform semantics:
 * - existed before install (has originalContent) -> restore original content
 * - existed before install (no content, e.g. directory) -> leave untouched
 * - did not exist before install -> delete (remove file/directory)
 */
export async function rollbackArtifacts(
  entries: RollbackEntry[],
  ops: FileOp[],
  warnings: string[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.existed && entry.originalContent !== undefined) {
        await writeFile(entry.path, entry.originalContent);
        ops.push({ path: entry.path, action: 'written', reason: 'restored pre-install content' });
      } else if (entry.existed) {
        continue;
      } else if (existsSync(entry.path)) {
        await rm(entry.path, { recursive: true, force: true });
        ops.push({ path: entry.path, action: 'removed', reason: 'rollback after failure' });
      }
    } catch (rollbackErr) {
      warnings.push(
        `Rollback failed for ${entry.path}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
  }
}

// ─── Main install orchestrator ───────────────────────────────────────────────

/**
 * Install FlowGuard into the target config directory.
 *
 * Orchestrates: validate → snapshot → write artifacts → config → dependencies → warnings.
 * On failure, rolls back written artifacts to leave a clean state.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  const ctx = initInstallContext(args);

  try {
    const tarball = await validateTarball(ctx);
    if (!tarball)
      return { target: ctx.target, ops: ctx.ops, errors: ctx.errors, warnings: ctx.warnings };

    const snapshot = await buildRollbackSnapshot(ctx, tarball.name);
    await writeArtifacts(ctx, tarball, snapshot);
    await writeConfigFiles(ctx, snapshot);
    await installDependencies(ctx, snapshot);
    emitPostInstallWarnings(ctx);
  } catch (err) {
    getAdapterLogger().error('cli', 'install command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target: ctx.target, ops: ctx.ops, errors: ctx.errors, warnings: ctx.warnings };
}
