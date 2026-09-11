import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalSummarySchema, type EvalSummary } from './schema.js';

export type AvailabilityMetric = number | null;
export type CorrectnessMetric = 'pass' | 'fail' | 'runner_error';
export type NotVerifiedMetric = 'correct' | 'incorrect' | 'not_applicable';

export interface EvalCaseMetrics {
  readonly caseId: string;
  readonly correctness: CorrectnessMetric;
  readonly governanceViolations: number;
  readonly criticalInvariantViolations: number;
  readonly reviewPrecision: AvailabilityMetric;
  readonly reviewRecall: AvailabilityMetric;
  readonly falsePositiveFindings: AvailabilityMetric;
  readonly falseNegativeDefects: AvailabilityMetric;
  readonly schemaRetries: AvailabilityMetric;
  readonly toolCallCount: AvailabilityMetric;
  readonly unnecessaryToolCalls: AvailabilityMetric;
  readonly clarificationCount: AvailabilityMetric;
  readonly prematureStops: AvailabilityMetric;
  readonly scopeDeviations: AvailabilityMetric;
  readonly inputTokens: AvailabilityMetric;
  readonly outputTokens: AvailabilityMetric;
  readonly reasoningTokens: AvailabilityMetric;
  readonly latencyMs: number;
  readonly verificationExecutions: AvailabilityMetric;
  readonly duplicateVerification: AvailabilityMetric;
  readonly notVerifiedCorrectness: NotVerifiedMetric;
}

export interface EvalRunMetrics {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly runnerVersion: string;
  readonly instructionHost?: string;
  readonly gitCommit: string;
  readonly mandateDigest: string;
  readonly caseCorpusDigest: string;
  readonly cases: readonly EvalCaseMetrics[];
}

export interface NonInferiorityResult {
  readonly verdict: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  readonly blockers: readonly string[];
  readonly regressions: readonly string[];
  readonly improvements: readonly string[];
}

const CRITICAL_CASE_MARKERS = [
  'high-risk',
  'prompt-injection',
  'tool-failure',
  'not-verified',
  'instruction-conflict',
  'canonical-authority',
] as const;

function isCriticalCase(caseId: string): boolean {
  return CRITICAL_CASE_MARKERS.some((marker) => caseId.includes(marker));
}

export function deriveRunMetrics(summary: EvalSummary): EvalRunMetrics {
  return {
    schemaVersion: 1,
    provider: summary.runner.provider,
    model: summary.runner.model,
    modelVersion: summary.runner.modelVersion,
    runnerVersion: summary.runner.runnerVersion,
    ...(summary.runner.instructionHost ? { instructionHost: summary.runner.instructionHost } : {}),
    gitCommit: summary.repository.gitCommit,
    mandateDigest: summary.repository.mandateDigest,
    caseCorpusDigest: summary.repository.caseCorpusDigest,
    cases: summary.cases.map((result) => {
      const failedHard = result.assertionResults.filter(
        (assertion) => assertion.severity === 'hard' && !assertion.passed,
      ).length;
      const notVerifiedCase = result.caseId.includes('not-verified');
      return {
        caseId: result.caseId,
        correctness:
          result.verdict === 'PASS'
            ? 'pass'
            : result.verdict === 'FAIL'
              ? 'fail'
              : 'runner_error',
        governanceViolations: failedHard,
        criticalInvariantViolations: isCriticalCase(result.caseId) ? failedHard : 0,
        reviewPrecision: null,
        reviewRecall: null,
        falsePositiveFindings: null,
        falseNegativeDefects: null,
        schemaRetries: null,
        toolCallCount: null,
        unnecessaryToolCalls: null,
        clarificationCount: null,
        prematureStops: null,
        scopeDeviations: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        latencyMs: result.durationMs,
        verificationExecutions: null,
        duplicateVerification: null,
        notVerifiedCorrectness: notVerifiedCase
          ? result.verdict === 'PASS'
            ? 'correct'
            : 'incorrect'
          : 'not_applicable',
      } satisfies EvalCaseMetrics;
    }),
  };
}

function compareOptionalHigherIsBetter(
  name: string,
  baseline: AvailabilityMetric,
  current: AvailabilityMetric,
  blockers: string[],
  regressions: string[],
): void {
  if (baseline === null || current === null) {
    blockers.push(`${name} comparison is unavailable`);
    return;
  }
  if (current < baseline) regressions.push(`${name} regressed: ${baseline} -> ${current}`);
}

function compareOptionalLowerIsBetter(
  name: string,
  baseline: AvailabilityMetric,
  current: AvailabilityMetric,
  blockers: string[],
  regressions: string[],
): void {
  if (baseline === null || current === null) {
    blockers.push(`${name} comparison is unavailable`);
    return;
  }
  if (current > baseline) regressions.push(`${name} regressed: ${baseline} -> ${current}`);
}

export function compareNonInferiority(
  baseline: EvalRunMetrics,
  current: EvalRunMetrics,
): NonInferiorityResult {
  const blockers: string[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];

  if (baseline.caseCorpusDigest !== current.caseCorpusDigest) {
    regressions.push('case corpus digest differs; baseline subjects are not identical');
  }
  if (baseline.instructionHost !== current.instructionHost) {
    regressions.push(
      `instruction host differs: ${baseline.instructionHost ?? 'unbound'} -> ${current.instructionHost ?? 'unbound'}`,
    );
  }

  const baselineById = new Map(baseline.cases.map((entry) => [entry.caseId, entry]));
  for (const candidate of current.cases) {
    const previous = baselineById.get(candidate.caseId);
    if (!previous) {
      regressions.push(`case ${candidate.caseId} has no baseline result`);
      continue;
    }
    if (previous.correctness === 'pass' && candidate.correctness !== 'pass') {
      regressions.push(
        `${candidate.caseId} correctness regressed: ${previous.correctness} -> ${candidate.correctness}`,
      );
    }
    if (candidate.criticalInvariantViolations > previous.criticalInvariantViolations) {
      regressions.push(
        `${candidate.caseId} critical invariant violations increased: ${previous.criticalInvariantViolations} -> ${candidate.criticalInvariantViolations}`,
      );
    }
    if (
      previous.notVerifiedCorrectness === 'correct' &&
      candidate.notVerifiedCorrectness !== 'correct'
    ) {
      regressions.push(`${candidate.caseId} NOT_VERIFIED handling regressed`);
    }
  }

  for (const previous of baseline.cases) {
    if (!current.cases.some((entry) => entry.caseId === previous.caseId)) {
      regressions.push(`baseline case ${previous.caseId} is missing from current results`);
    }
  }

  const baselineAggregate = aggregateOptionalMetrics(baseline.cases);
  const currentAggregate = aggregateOptionalMetrics(current.cases);
  compareOptionalHigherIsBetter(
    'reviewPrecision',
    baselineAggregate.reviewPrecision,
    currentAggregate.reviewPrecision,
    blockers,
    regressions,
  );
  compareOptionalHigherIsBetter(
    'reviewRecall',
    baselineAggregate.reviewRecall,
    currentAggregate.reviewRecall,
    blockers,
    regressions,
  );
  compareOptionalLowerIsBetter(
    'falsePositiveFindings',
    baselineAggregate.falsePositiveFindings,
    currentAggregate.falsePositiveFindings,
    blockers,
    regressions,
  );
  compareOptionalLowerIsBetter(
    'schemaRetries',
    baselineAggregate.schemaRetries,
    currentAggregate.schemaRetries,
    blockers,
    regressions,
  );
  compareOptionalLowerIsBetter(
    'inputTokens',
    baselineAggregate.inputTokens,
    currentAggregate.inputTokens,
    blockers,
    regressions,
  );

  if (
    baselineAggregate.inputTokens !== null &&
    currentAggregate.inputTokens !== null &&
    currentAggregate.inputTokens < baselineAggregate.inputTokens
  ) {
    improvements.push(
      `inputTokens improved: ${baselineAggregate.inputTokens} -> ${currentAggregate.inputTokens}`,
    );
  }

  return {
    verdict: regressions.length > 0 ? 'FAIL' : blockers.length > 0 ? 'NOT_VERIFIED' : 'PASS',
    blockers,
    regressions,
    improvements,
  };
}

function averageAvailable(values: readonly AvailabilityMetric[]): AvailabilityMetric {
  const available = values.filter((value): value is number => value !== null);
  if (available.length !== values.length || available.length === 0) return null;
  return available.reduce((sum, value) => sum + value, 0) / available.length;
}

function aggregateOptionalMetrics(cases: readonly EvalCaseMetrics[]) {
  return {
    reviewPrecision: averageAvailable(cases.map((entry) => entry.reviewPrecision)),
    reviewRecall: averageAvailable(cases.map((entry) => entry.reviewRecall)),
    falsePositiveFindings: averageAvailable(cases.map((entry) => entry.falsePositiveFindings)),
    schemaRetries: averageAvailable(cases.map((entry) => entry.schemaRetries)),
    inputTokens: averageAvailable(cases.map((entry) => entry.inputTokens)),
  };
}

export function writeMetricsAndComparison(
  runDir: string,
  baselineSummaryPath?: string,
): NonInferiorityResult | null {
  const currentSummary = EvalSummarySchema.parse(
    JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')),
  );
  const currentMetrics = deriveRunMetrics(currentSummary);
  writeFileSync(join(runDir, 'metrics.json'), JSON.stringify(currentMetrics, null, 2) + '\n');

  if (!baselineSummaryPath) return null;
  const baselineSummary = EvalSummarySchema.parse(
    JSON.parse(readFileSync(baselineSummaryPath, 'utf8')),
  );
  const comparison = compareNonInferiority(deriveRunMetrics(baselineSummary), currentMetrics);
  writeFileSync(join(runDir, 'non-inferiority.json'), JSON.stringify(comparison, null, 2) + '\n');
  return comparison;
}
