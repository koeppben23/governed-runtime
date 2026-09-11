import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EvalSummarySchema, type EvalSummary } from './schema.js';
import {
  extractRunnerCaseMetrics,
  RUNNER_METRICS_PREFIX,
  type RunnerCaseMetrics,
} from './run.js';

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
  readonly runnerKind?: 'synthetic' | 'live-host';
  readonly instructionHost?: string;
  readonly configDigest: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
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

const OPTIONAL_METRIC_KEYS = [
  'reviewPrecision',
  'reviewRecall',
  'falsePositiveFindings',
  'falseNegativeDefects',
  'schemaRetries',
  'toolCallCount',
  'unnecessaryToolCalls',
  'clarificationCount',
  'prematureStops',
  'scopeDeviations',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'verificationExecutions',
  'duplicateVerification',
] as const satisfies readonly (keyof RunnerCaseMetrics)[];

type OptionalMetricKey = (typeof OPTIONAL_METRIC_KEYS)[number];

/**
 * Live provider latency is inherently noisy. Treat increases within both a small
 * absolute floor and a 10% relative envelope as equivalent rather than turning
 * network jitter into a governance regression.
 */
export const LATENCY_NON_INFERIORITY_ABSOLUTE_MARGIN_MS = 250;
export const LATENCY_NON_INFERIORITY_RELATIVE_MARGIN = 0.1;

export function deriveRunMetrics(
  summary: EvalSummary,
  caseMetrics: ReadonlyMap<string, RunnerCaseMetrics> = new Map(),
): EvalRunMetrics {
  return {
    schemaVersion: 1,
    provider: summary.runner.provider,
    model: summary.runner.model,
    modelVersion: summary.runner.modelVersion,
    runnerVersion: summary.runner.runnerVersion,
    ...(summary.runner.runnerKind ? { runnerKind: summary.runner.runnerKind } : {}),
    ...(summary.runner.instructionHost ? { instructionHost: summary.runner.instructionHost } : {}),
    configDigest: summary.runner.configDigest,
    gitCommit: summary.repository.gitCommit,
    gitDirty: summary.repository.gitDirty,
    mandateDigest: summary.repository.mandateDigest,
    caseCorpusDigest: summary.repository.caseCorpusDigest,
    cases: summary.cases.map((result) => {
      const failedHard = result.assertionResults.filter(
        (assertion) => assertion.severity === 'hard' && !assertion.passed,
      ).length;
      const notVerifiedCase = result.caseId.includes('not-verified');
      const telemetry = caseMetrics.get(result.caseId);
      return {
        caseId: result.caseId,
        correctness:
          result.verdict === 'PASS'
            ? 'pass'
            : result.verdict === 'FAIL'
              ? 'fail'
              : 'runner_error',
        governanceViolations: failedHard,
        // Conservative by design: every hard assertion is an invariant. This avoids
        // silently changing criticality when a case is merely renamed.
        criticalInvariantViolations: failedHard,
        reviewPrecision: telemetry?.reviewPrecision ?? null,
        reviewRecall: telemetry?.reviewRecall ?? null,
        falsePositiveFindings: telemetry?.falsePositiveFindings ?? null,
        falseNegativeDefects: telemetry?.falseNegativeDefects ?? null,
        schemaRetries: telemetry?.schemaRetries ?? null,
        toolCallCount: telemetry?.toolCallCount ?? null,
        unnecessaryToolCalls: telemetry?.unnecessaryToolCalls ?? null,
        clarificationCount: telemetry?.clarificationCount ?? null,
        prematureStops: telemetry?.prematureStops ?? null,
        scopeDeviations: telemetry?.scopeDeviations ?? null,
        inputTokens: telemetry?.inputTokens ?? null,
        outputTokens: telemetry?.outputTokens ?? null,
        reasoningTokens: telemetry?.reasoningTokens ?? null,
        latencyMs: result.durationMs,
        verificationExecutions: telemetry?.verificationExecutions ?? null,
        duplicateVerification: telemetry?.duplicateVerification ?? null,
        notVerifiedCorrectness: notVerifiedCase
          ? result.verdict === 'PASS'
            ? 'correct'
            : 'incorrect'
          : 'not_applicable',
      } satisfies EvalCaseMetrics;
    }),
  };
}

interface MetricAggregate {
  readonly value: AvailabilityMetric;
  readonly caseIds: readonly string[];
}

function aggregateMetric(cases: readonly EvalCaseMetrics[], key: OptionalMetricKey): MetricAggregate {
  const available = cases
    .filter((entry) => entry[key] !== null)
    .map((entry) => ({ caseId: entry.caseId, value: entry[key] as number }));
  return {
    value:
      available.length === 0
        ? null
        : available.reduce((sum, entry) => sum + entry.value, 0) / available.length,
    caseIds: available.map((entry) => entry.caseId).sort(),
  };
}

function sameCoverage(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareOptionalMetric(
  name: OptionalMetricKey,
  baseline: MetricAggregate,
  current: MetricAggregate,
  direction: 'higher' | 'lower',
  blockers: string[],
  regressions: string[],
  improvements: string[],
): void {
  if (baseline.value === null || current.value === null) {
    blockers.push(`${name} comparison is unavailable`);
    return;
  }
  if (!sameCoverage(baseline.caseIds, current.caseIds)) {
    blockers.push(
      `${name} telemetry coverage differs: baseline=[${baseline.caseIds.join(',')}] current=[${current.caseIds.join(',')}]`,
    );
    return;
  }

  const regressed = direction === 'higher' ? current.value < baseline.value : current.value > baseline.value;
  const improved = direction === 'higher' ? current.value > baseline.value : current.value < baseline.value;
  if (regressed) regressions.push(`${name} regressed: ${baseline.value} -> ${current.value}`);
  if (improved) improvements.push(`${name} improved: ${baseline.value} -> ${current.value}`);
}

function averageLatency(cases: readonly EvalCaseMetrics[]): number {
  if (cases.length === 0) return 0;
  return cases.reduce((sum, entry) => sum + entry.latencyMs, 0) / cases.length;
}

function compareProvenance(
  baseline: EvalRunMetrics,
  current: EvalRunMetrics,
  blockers: string[],
): void {
  const comparableFields: readonly [
    string,
    string | undefined,
    string | undefined,
  ][] = [
    ['provider', baseline.provider, current.provider],
    ['model', baseline.model, current.model],
    ['model version', baseline.modelVersion, current.modelVersion],
    ['runner version', baseline.runnerVersion, current.runnerVersion],
    ['runner kind', baseline.runnerKind, current.runnerKind],
    ['instruction host', baseline.instructionHost, current.instructionHost],
    ['runner config digest', baseline.configDigest, current.configDigest],
  ];

  for (const [name, previous, candidate] of comparableFields) {
    if (previous !== candidate) {
      blockers.push(
        `${name} differs: ${previous ?? 'unbound'} -> ${candidate ?? 'unbound'}; runs are not directly comparable`,
      );
    }
  }

  if (baseline.gitDirty) blockers.push('baseline repository worktree is dirty');
  if (current.gitDirty) blockers.push('current repository worktree is dirty');
}

export function compareNonInferiority(
  baseline: EvalRunMetrics,
  current: EvalRunMetrics,
): NonInferiorityResult {
  const blockers: string[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];

  compareProvenance(baseline, current, blockers);

  if (baseline.caseCorpusDigest !== current.caseCorpusDigest) {
    regressions.push('case corpus digest differs; baseline subjects are not identical');
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
    if (candidate.governanceViolations > previous.governanceViolations) {
      regressions.push(
        `${candidate.caseId} governance violations increased: ${previous.governanceViolations} -> ${candidate.governanceViolations}`,
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

  const metricDirections: Readonly<Record<OptionalMetricKey, 'higher' | 'lower'>> = {
    reviewPrecision: 'higher',
    reviewRecall: 'higher',
    falsePositiveFindings: 'lower',
    falseNegativeDefects: 'lower',
    schemaRetries: 'lower',
    toolCallCount: 'lower',
    unnecessaryToolCalls: 'lower',
    clarificationCount: 'lower',
    prematureStops: 'lower',
    scopeDeviations: 'lower',
    inputTokens: 'lower',
    outputTokens: 'lower',
    reasoningTokens: 'lower',
    verificationExecutions: 'higher',
    duplicateVerification: 'lower',
  };

  for (const key of OPTIONAL_METRIC_KEYS) {
    compareOptionalMetric(
      key,
      aggregateMetric(baseline.cases, key),
      aggregateMetric(current.cases, key),
      metricDirections[key],
      blockers,
      regressions,
      improvements,
    );
  }

  const baselineLatency = averageLatency(baseline.cases);
  const currentLatency = averageLatency(current.cases);
  const allowedLatencyIncrease = Math.max(
    LATENCY_NON_INFERIORITY_ABSOLUTE_MARGIN_MS,
    baselineLatency * LATENCY_NON_INFERIORITY_RELATIVE_MARGIN,
  );
  if (currentLatency > baselineLatency + allowedLatencyIncrease) {
    regressions.push(
      `latencyMs regressed beyond margin: ${baselineLatency} -> ${currentLatency} (allowed +${allowedLatencyIncrease})`,
    );
  } else if (currentLatency < baselineLatency) {
    improvements.push(`latencyMs improved: ${baselineLatency} -> ${currentLatency}`);
  }

  return {
    verdict: regressions.length > 0 ? 'FAIL' : blockers.length > 0 ? 'NOT_VERIFIED' : 'PASS',
    blockers,
    regressions,
    improvements,
  };
}

function loadCaseMetrics(runDir: string, summary: EvalSummary): Map<string, RunnerCaseMetrics> {
  const metrics = new Map<string, RunnerCaseMetrics>();
  for (const result of summary.cases) {
    const path = join(runDir, 'cases', result.caseId, 'metrics.json');
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8').trim();
    const parsed = extractRunnerCaseMetrics(`${RUNNER_METRICS_PREFIX}${raw}`);
    if (!parsed) throw new Error(`Unable to parse runner metrics for ${result.caseId}`);
    metrics.set(result.caseId, parsed);
  }
  return metrics;
}

export function writeMetricsAndComparison(
  runDir: string,
  baselineSummaryPath?: string,
): NonInferiorityResult | null {
  const currentSummary = EvalSummarySchema.parse(
    JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')),
  );
  const currentMetrics = deriveRunMetrics(currentSummary, loadCaseMetrics(runDir, currentSummary));
  writeFileSync(join(runDir, 'metrics.json'), JSON.stringify(currentMetrics, null, 2) + '\n');

  if (!baselineSummaryPath) return null;
  const baselineSummary = EvalSummarySchema.parse(
    JSON.parse(readFileSync(baselineSummaryPath, 'utf8')),
  );
  const baselineRunDir = dirname(baselineSummaryPath);
  const baselineMetrics = deriveRunMetrics(
    baselineSummary,
    loadCaseMetrics(baselineRunDir, baselineSummary),
  );
  const comparison = compareNonInferiority(baselineMetrics, currentMetrics);
  writeFileSync(join(runDir, 'non-inferiority.json'), JSON.stringify(comparison, null, 2) + '\n');
  return comparison;
}
