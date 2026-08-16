/**
 * exit-code.ts
 *
 * Determines the process exit code based on eval results and whether
 * the run is advisory.
 *
 *   0 = all PASS (or FAIL in advisory mode)
 *   1 = at least one FAIL (normal mode only)
 *   2 = at least one RUNNER_ERROR or framework error
 */

import type { ExecutedEvalCase } from './schema.js';

export function determineExitCode(
  executed: ExecutedEvalCase[],
  advisory: boolean,
): 0 | 1 | 2 {
  if (
    executed.some(
      (e) => e.result.verdict === 'RUNNER_ERROR',
    )
  ) {
    return 2;
  }

  if (
    !advisory &&
    executed.some((e) => e.result.verdict === 'FAIL')
  ) {
    return 1;
  }

  return 0;
}
