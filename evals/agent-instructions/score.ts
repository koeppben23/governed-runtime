import type {
  AssertionResult,
  EvalCaseResult,
  EvalRunnerProvenance,
  EvalSummary,
  InstructionHost,
  InstructionSurface,
  RepositoryProvenance,
} from './schema.js';

export type Verdict = 'PASS' | 'FAIL' | 'RUNNER_ERROR';

export function scoreCase(
  caseId: string,
  instructionSurface: InstructionSurface,
  assertionResults: AssertionResult[],
  durationMs: number,
  runnerError?: string,
  snapshotSummary?: EvalCaseResult['snapshotSummary'],
  instructionHost?: InstructionHost,
): EvalCaseResult {
  const provenance = {
    caseId,
    instructionSurface,
    ...(instructionHost ? { instructionHost } : {}),
  };
  if (runnerError) {
    return {
      ...provenance,
      verdict: 'RUNNER_ERROR',
      durationMs,
      assertionResults,
      runnerError,
    };
  }

  const hardFailures = assertionResults.filter((r) => r.severity === 'hard' && !r.passed);

  return {
    ...provenance,
    verdict: hardFailures.length > 0 ? 'FAIL' : 'PASS',
    durationMs,
    assertionResults,
    snapshotSummary,
  };
}

export function summarizeResults(
  runner: EvalRunnerProvenance,
  repository: RepositoryProvenance,
  caseResults: EvalCaseResult[],
): EvalSummary {
  const byInstructionSurface = {
    repository_contributor: { passed: 0, failed: 0, runnerErrors: 0 },
    flowguard_product: { passed: 0, failed: 0, runnerErrors: 0 },
  };
  for (const result of caseResults) {
    const summary = byInstructionSurface[result.instructionSurface];
    if (result.verdict === 'PASS') summary.passed++;
    else if (result.verdict === 'FAIL') summary.failed++;
    else summary.runnerErrors++;
  }
  return {
    schemaVersion: 2,
    runner,
    repository,
    byInstructionSurface,
    cases: caseResults,
  };
}
