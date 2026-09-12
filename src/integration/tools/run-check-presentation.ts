import type {
  AssertionExtractionResult,
  ValidationOutcome,
} from '../../state/evidence-validation.js';

export interface RunCheckExecutionPresentation {
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number;
  readonly executionMs: number;
}

export interface RunCheckClassificationPresentation {
  readonly passed: boolean;
  readonly outcome: ValidationOutcome;
  readonly assertionExtraction?: AssertionExtractionResult;
}

/**
 * Render durable validation detail without conflating process success with
 * assertion completeness. Exit 0 remains execution evidence; extracted
 * assertion counts make skips/failures visible to downstream readers.
 */
export function formatValidationDetail(
  evidence: RunCheckExecutionPresentation,
  extraction?: AssertionExtractionResult,
): string {
  const execution = evidence.timedOut
    ? `Timed out after ${evidence.executionMs}ms`
    : evidence.passed
      ? `Passed (exit 0, ${evidence.executionMs}ms)`
      : `Failed (exit ${evidence.exitCode}, ${evidence.executionMs}ms)`;

  if (extraction?.status !== 'extracted') return execution;
  const summary = extraction.summary;
  return (
    `${execution}; assertions: ${summary.passedCount} passed, ${summary.failedCount} failed, ` +
    `${summary.erroredCount} errored, ${summary.skippedCount} skipped`
  );
}

/**
 * The user-visible check status follows FlowGuard's classified validation
 * result. A successful subprocess must never be presented as a passing check
 * when structured evidence classified it as blocked or inconclusive.
 */
export function formatRunCheckStatus(
  kind: string,
  result: RunCheckClassificationPresentation,
  evidence: RunCheckExecutionPresentation,
): string {
  if (result.passed) {
    const extraction = result.assertionExtraction;
    if (extraction?.status === 'extracted' && extraction.summary.skippedCount > 0) {
      return `Check '${kind}' passed with ${extraction.summary.skippedCount} skipped assertion(s).`;
    }
    return `Check '${kind}' passed.`;
  }
  if (evidence.timedOut) return `Check '${kind}' timed out.`;
  if (evidence.passed) return `Check '${kind}' ${result.outcome}.`;
  return `Check '${kind}' failed (exit ${evidence.exitCode}).`;
}
