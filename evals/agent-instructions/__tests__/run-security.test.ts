import { afterEach, describe, expect, it } from 'vitest';
import { EvalCaseSchema, type RunnerConfig } from '../schema.js';
import { resolveRunnerEnv, writeReports } from '../run.js';

const touchedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of touchedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touchedEnv.clear();
});

function runner(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    name: 'security-test',
    command: process.execPath,
    promptTransport: 'stdin',
    args: [],
    staticEnv: {},
    secretEnvNames: [],
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('eval runner trust boundaries', () => {
  it('does not inherit unrelated process environment values', () => {
    setEnv('FG_UNRELATED_SECRET', 'must-not-cross-boundary');

    const resolved = resolveRunnerEnv(runner({ staticEnv: { CI: 'true' } }));

    expect(resolved.childEnv.FG_UNRELATED_SECRET).toBeUndefined();
    expect(resolved.childEnv.CI).toBe('true');
  });

  it('passes only explicitly declared secrets and registers them for redaction', () => {
    setEnv('FG_REQUIRED_SECRET', 'synthetic-secret-value');

    const resolved = resolveRunnerEnv(runner({ secretEnvNames: ['FG_REQUIRED_SECRET'] }));

    expect(resolved.childEnv.FG_REQUIRED_SECRET).toBe('synthetic-secret-value');
    expect(resolved.redactionValues).toEqual(['synthetic-secret-value']);
  });

  it('fails closed when an explicitly required secret is unavailable', () => {
    delete process.env.FG_MISSING_SECRET;

    expect(() => resolveRunnerEnv(runner({ secretEnvNames: ['FG_MISSING_SECRET'] }))).toThrow(
      'FG_MISSING_SECRET',
    );
  });

  it('rejects traversal-capable case identifiers', () => {
    const result = EvalCaseSchema.safeParse({
      id: '../../escape',
      description: 'invalid id',
      instructionSurface: 'repository_contributor',
      task: 'noop',
      mode: 'output-only',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit ok' }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects traversal-capable report run identifiers before writing', () => {
    expect(() => writeReports('security-test', [], { runId: '../escape' })).toThrow(
      'Invalid eval run ID',
    );
  });
});
