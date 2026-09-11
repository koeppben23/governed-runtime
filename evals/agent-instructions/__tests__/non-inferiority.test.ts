import { describe, expect, it } from 'vitest';
import type { EvalSummary } from '../schema.js';
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
});
