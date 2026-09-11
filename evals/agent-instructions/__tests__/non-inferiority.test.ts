import { describe, expect, it } from 'vitest';
import type { EvalSummary } from '../schema.js';
import type { RunnerCaseMetrics } from '../run.js';
import { compareNonInferiority, deriveRunMetrics } from '../non-inferiority.js';

function summary(verdict: 'PASS' | 'FAIL' = 'PASS'): EvalSummary {
  return {
    schemaVersion: 3,
    runner: {
      name: 'opencode-live',
      command: 'opencode',
      args: [],
      promptTransport: 'stdin',
      provider: 'test-provider',
      model: 'test-model',
      modelVersion: '1',
      runnerVersion: '1.18.29',
      seed: 'seed-42',
      runnerKind: 'live-host',
      instructionHost: 'opencode',
      timeoutMs: 1_000,
      configDigest: 'a'.repeat(64),
      secretEnvNames: [],
    },
    repository: {
      gitCommit: 'b'.repeat(40),
      gitDirty: false,
      flowguardVersion: '1.2.3',
      mandateDigest: 'c'.repeat(64),
      caseCorpusDigest: 'd'.repeat(64),
    },
    byInstructionSurface: {
      repository_contributor: { passed: 0, failed: 0, runnerErrors: 0 },
      flowguard_product: {
        passed: verdict === 'PASS' ? 1 : 0,
        failed: verdict === 'FAIL' ? 1 : 0,
        runnerErrors: 0,
      },
    },
    byInstructionHost: {
      opencode: {
        passed: verdict === 'PASS' ? 1 : 0,
        failed: verdict === 'FAIL' ? 1 : 0,
        runnerErrors: 0,
      },
      'claude-code': { passed: 0, failed: 0, runnerErrors: 0 },
      codex: { passed: 0, failed: 0, runnerErrors: 0 },
    },
    cases: [
      {
        caseId: 'product-not-verified',
        instructionSurface: 'flowguard_product',
        instructionHost: 'opencode',
        verdict,
        durationMs: 10,
        assertionResults: [
          {
            description: 'NOT_VERIFIED remains explicit',
            type: 'output_contains',
            severity: 'hard',
            passed: verdict === 'PASS',
          },
        ],
      },
    ],
  };
}

function completeTelemetry(): RunnerCaseMetrics {
  return {
    reviewPrecision: 1,
    reviewRecall: 1,
    falsePositiveFindings: 0,
    falseNegativeDefects: 0,
    schemaRetries: 0,
    toolCallCount: 2,
    unnecessaryToolCalls: 0,
    clarificationCount: 0,
    prematureStops: 0,
    scopeDeviations: 0,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 25,
    verificationExecutions: 1,
    duplicateVerification: 0,
  };
}

describe('non-inferiority gate', () => {
  it('fails when a previously passing critical case regresses', () => {
    const result = compareNonInferiority(
      deriveRunMetrics(summary('PASS')),
      deriveRunMetrics(summary('FAIL')),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.regressions.join('\n')).toContain('correctness regressed');
    expect(result.regressions.join('\n')).toContain('critical invariant violations increased');
  });

  it('does not claim PASS when provider-dependent metrics are unavailable', () => {
    const baseline = deriveRunMetrics(summary('PASS'));
    const current = deriveRunMetrics(summary('PASS'));
    const result = compareNonInferiority(baseline, current);
    expect(result.verdict).toBe('NOT_VERIFIED');
    expect(result.regressions).toEqual([]);
    expect(result.blockers).toContain('reviewPrecision comparison is unavailable');
    expect(result.blockers).toContain('inputTokens comparison is unavailable');
  });

  it('passes when all required telemetry is measured with identical coverage and no regressions', () => {
    const telemetry = new Map([['product-not-verified', completeTelemetry()]]);
    const baseline = deriveRunMetrics(summary('PASS'), telemetry);
    const current = deriveRunMetrics(summary('PASS'), telemetry);
    const result = compareNonInferiority(baseline, current);
    expect(result).toEqual({ verdict: 'PASS', blockers: [], regressions: [], improvements: [] });
  });

  it('blocks when telemetry coverage differs even if aggregate values exist', () => {
    const baseline = deriveRunMetrics(
      summary('PASS'),
      new Map([['product-not-verified', completeTelemetry()]]),
    );
    const current = deriveRunMetrics(summary('PASS'));
    const result = compareNonInferiority(baseline, current);
    expect(result.verdict).toBe('NOT_VERIFIED');
    expect(result.blockers).toContain('reviewPrecision comparison is unavailable');
  });

  it('fails comparison when subjects/corpus differ', () => {
    const baseline = deriveRunMetrics(summary('PASS'));
    const current = {
      ...deriveRunMetrics(summary('PASS')),
      caseCorpusDigest: 'e'.repeat(64),
    };
    const result = compareNonInferiority(baseline, current);
    expect(result.verdict).toBe('FAIL');
    expect(result.regressions).toContain(
      'case corpus digest differs; baseline subjects are not identical',
    );
  });

  it('blocks comparison when provider/model/runner provenance differs', () => {
    const telemetry = new Map([['product-not-verified', completeTelemetry()]]);
    const baseline = deriveRunMetrics(summary('PASS'), telemetry);
    const current = {
      ...deriveRunMetrics(summary('PASS'), telemetry),
      modelVersion: '2',
    };
    const result = compareNonInferiority(baseline, current);
    expect(result.verdict).toBe('NOT_VERIFIED');
    expect(result.blockers.join('\n')).toContain('model version differs');
  });

  it('blocks comparison when deterministic seeds differ or are absent', () => {
    const telemetry = new Map([['product-not-verified', completeTelemetry()]]);
    const baseline = deriveRunMetrics(summary('PASS'), telemetry);
    const current = { ...deriveRunMetrics(summary('PASS'), telemetry), seed: 'seed-99' };
    const mismatch = compareNonInferiority(baseline, current);
    expect(mismatch.verdict).toBe('NOT_VERIFIED');
    expect(mismatch.blockers.join('\n')).toContain('seed differs');

    const missing = compareNonInferiority(
      { ...baseline, seed: undefined },
      { ...baseline, seed: undefined },
    );
    expect(missing.verdict).toBe('NOT_VERIFIED');
    expect(missing.blockers).toContain('deterministic seed is missing from baseline or current run');
  });

  it('blocks assurance comparison when either repository worktree is dirty', () => {
    const telemetry = new Map([['product-not-verified', completeTelemetry()]]);
    const baseline = deriveRunMetrics(summary('PASS'), telemetry);
    const current = { ...deriveRunMetrics(summary('PASS'), telemetry), gitDirty: true };
    const result = compareNonInferiority(baseline, current);
    expect(result.verdict).toBe('NOT_VERIFIED');
    expect(result.blockers).toContain('current repository worktree is dirty');
  });

  it('tolerates small latency jitter but fails material latency regression', () => {
    const telemetry = new Map([['product-not-verified', completeTelemetry()]]);
    const baseline = deriveRunMetrics(summary('PASS'), telemetry);
    const withinMargin = {
      ...deriveRunMetrics(summary('PASS'), telemetry),
      cases: deriveRunMetrics(summary('PASS'), telemetry).cases.map((entry) => ({
        ...entry,
        latencyMs: 200,
      })),
    };
    expect(compareNonInferiority(baseline, withinMargin).verdict).toBe('PASS');

    const beyondMargin = {
      ...deriveRunMetrics(summary('PASS'), telemetry),
      cases: deriveRunMetrics(summary('PASS'), telemetry).cases.map((entry) => ({
        ...entry,
        latencyMs: 400,
      })),
    };
    const result = compareNonInferiority(baseline, beyondMargin);
    expect(result.verdict).toBe('FAIL');
    expect(result.regressions.join('\n')).toContain('latencyMs regressed beyond margin');
  });
});
