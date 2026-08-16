import type { AssertionResult, EvalCaseResult } from './schema.js';

export type Verdict = 'PASS' | 'FAIL' | 'RUNNER_ERROR';

export function scoreCase(
  caseId: string,
  assertionResults: AssertionResult[],
  durationMs: number,
  runnerError?: string,
  snapshotSummary?: EvalCaseResult['snapshotSummary'],
): EvalCaseResult {
  if (runnerError) {
    return {
      caseId,
      verdict: 'RUNNER_ERROR',
      durationMs,
      assertionResults,
      runnerError,
    };
  }

  const hardFailures = assertionResults.filter(
    (r) => r.severity === 'hard' && !r.passed,
  );

  return {
    caseId,
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
  cases: EvalCaseResult[];
} {
  return {
    schemaVersion: 1,
    runner,
    passed: caseResults.filter((c) => c.verdict === 'PASS').length,
    failed: caseResults.filter((c) => c.verdict === 'FAIL').length,
    runnerErrors: caseResults.filter((c) => c.verdict === 'RUNNER_ERROR').length,
    cases: caseResults,
  };
}
