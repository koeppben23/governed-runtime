/**
 * @module cli/install-outcome
 * @description Derived install outcome projection for operator output.
 *
 * `CliResult.ops` and `CliResult.errors` remain the single source of truth; the
 * outcome is a pure classification, never persisted into ownership state.
 *
 * @version v1
 */

import type { CliResult } from './install-types.js';

export type InstallOutcome = 'applied' | 'skipped' | 'failed';

/**
 * Classify a finished install result.
 *
 * - `failed`: any error was recorded. A genuine conflict must have failed
 *   before reaching a result; it is never reported as applied.
 * - `applied`: at least one artifact was written or merged. A mix of written
 *   and skipped operations is `applied`; the individual skips stay visible in
 *   the operation list.
 * - `skipped`: nothing was applied and nothing failed (idempotent no-op).
 */
export function classifyInstallOutcome(result: Pick<CliResult, 'errors' | 'ops'>): InstallOutcome {
  if (result.errors.length > 0) return 'failed';
  const applied = result.ops.some((op) => op.action === 'written' || op.action === 'merged');
  return applied ? 'applied' : 'skipped';
}
