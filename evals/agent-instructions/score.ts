import type {
  AssertionResult,
  AssuranceTag,
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
  assuranceTags: readonly AssuranceTag[] = [],
): EvalCaseResult {
  const provenance = {
    caseId,
    instructionSurface,
    ...(instructionHost ? { instructionHost } : {}),
    assuranceTags: [...assuranceTags],
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

function emptyCounts(): { passed: number; failed: number; runnerErrors: number } {
  return { passed: 0, failed: 0, runnerErrors: 0 };
}

function addVerdict(
  counts: { passed: number; failed: number; runnerErrors: number },
  verdict: EvalCaseResult['verdict'],
): void {
  if (verdict === 'PASS') counts.passed++;
  else if (verdict === 'FAIL') counts.failed++;
  else counts.runnerErrors++;
}

export function summarizeResults(
  runner: EvalRunnerProvenance,
  repository: RepositoryProvenance,
  caseResults: EvalCaseResult[],
): EvalSummary {
  const byInstructionSurface = {
    repository_contributor: emptyCounts(),
    flowguard_product: emptyCounts(),
  };
  const byInstructionHost = {
    opencode: emptyCounts(),
    'claude-code': emptyCounts(),
    codex: emptyCounts(),
  };

  for (const result of caseResults) {
    addVerdict(byInstructionSurface[result.instructionSurface], result.verdict);
    if (result.instructionHost) addVerdict(byInstructionHost[result.instructionHost], result.verdict);
  }

  return {
    schemaVersion: 3,
    runner,
    repository,
    byInstructionSurface,
    byInstructionHost,
    cases: caseResults,
  };
}
