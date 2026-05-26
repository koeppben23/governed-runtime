/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 *
 * The install() function orchestrates named steps from install-steps.ts.
 * Each step has a single responsibility and is independently testable.
 *
 * @version v3
 */

import { getAdapterLogger } from '../logging/adapter-logger.js';
import type { CliArgs, CliResult } from './install-helpers.js';
import {
  initInstallContext,
  validateTarball,
  buildRollbackSnapshot,
  writeArtifacts,
  writeConfigFiles,
  installDependencies,
  emitPostInstallWarnings,
} from './install-steps.js';

// Re-export rollback utilities from their canonical location for backward compatibility.
export {
  detectPackageManager,
  type RollbackEntry,
  rollbackArtifacts,
  snapshotForRollback,
} from './install-helpers.js';

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
