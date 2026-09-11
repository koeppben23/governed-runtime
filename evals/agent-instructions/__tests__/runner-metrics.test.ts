import { describe, expect, it } from 'vitest';
import {
  extractRunnerCaseMetrics,
  RUNNER_METRICS_PREFIX,
} from '../run.js';

describe('runner metrics envelope', () => {
  it('accepts one strict metrics envelope', () => {
    const stderr = `${RUNNER_METRICS_PREFIX}${JSON.stringify({
      reviewPrecision: 1,
      reviewRecall: 0.9,
      schemaRetries: 0,
      toolCallCount: 3,
      inputTokens: 100,
    })}\n`;

    expect(extractRunnerCaseMetrics(stderr)).toEqual({
      reviewPrecision: 1,
      reviewRecall: 0.9,
      schemaRetries: 0,
      toolCallCount: 3,
      inputTokens: 100,
    });
  });

  it('rejects duplicate, malformed, unknown, and invalid metrics fail-closed', () => {
    expect(() =>
      extractRunnerCaseMetrics(
        `${RUNNER_METRICS_PREFIX}{"schemaRetries":0}\n${RUNNER_METRICS_PREFIX}{"schemaRetries":0}`,
      ),
    ).toThrow('exactly one is allowed');
    expect(() => extractRunnerCaseMetrics(`${RUNNER_METRICS_PREFIX}{broken`)).toThrow(
      'not valid JSON',
    );
    expect(() =>
      extractRunnerCaseMetrics(`${RUNNER_METRICS_PREFIX}{"inventedMetric":1}`),
    ).toThrow('unsupported metric');
    expect(() =>
      extractRunnerCaseMetrics(`${RUNNER_METRICS_PREFIX}{"reviewPrecision":1.1}`),
    ).toThrow('between 0 and 1');
    expect(() =>
      extractRunnerCaseMetrics(`${RUNNER_METRICS_PREFIX}{"toolCallCount":-1}`),
    ).toThrow('finite non-negative number');
  });
});
