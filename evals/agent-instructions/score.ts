import type {
  AssertionResult,
  EvalCaseResult,
  InstructionHost,
  InstructionSurface,
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
  runner: string,
  caseResults: EvalCaseResult[],
): {
  schemaVersion: 1;
  runner: string;
  passed: number;
  failed: number;
  runnerErrors: number;
  byInstructionSurface: Record<
    InstructionSurface,
    { passed: number; failed: number; runnerErrors: number }
  >;
  cases: EvalCaseResult[];
} {
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
    schemaVersion: 1,
    runner,
    passed: caseResults.filter((c) => c.verdict === 'PASS').length,
    failed: caseResults.filter((c) => c.verdict === 'FAIL').length,
    runnerErrors: caseResults.filter((c) => c.verdict === 'RUNNER_ERROR').length,
    byInstructionSurface,
    cases: caseResults,
  };
}
