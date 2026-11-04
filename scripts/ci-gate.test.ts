import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
) as {
  jobs: Record<
    string,
    {
      name?: string;
      needs?: string | string[];
      if?: string;
      strategy?: { matrix: { os: string[] } };
      steps: { run?: string; with?: Record<string, unknown> }[];
    }
  >;
};
function requiredJob(id: string) {
  const job = workflow.jobs[id];
  if (!job) throw new TypeError(`Missing CI job: ${id}`);
  return job;
}
const gate = requiredJob('test');
const dependencies = [
  'unit',
  'scripts-windows',
  'critical-windows',
  'coverage',
  'integration_perf',
  'provider-conformance',
  'regulated_e2e',
  'doc-drift',
  'inactive-parity',
];

function executeGate(overrides: Record<string, string> = {}) {
  const script = gate.steps
    .map((step) => step.run ?? '')
    .join('\n')
    .replace(
      /\$\{\{ needs\.([\w-]+)\.result \}\}/g,
      (_match, job: string) => overrides[job] ?? 'success',
    );
  expect(script).not.toContain('${{');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('required ci-gate documentation enforcement', () => {
  it('runs both installed-parity suites on every OS against one shared build artifact', () => {
    const parity = requiredJob('inactive-parity');
    expect(parity.needs).toBe('build');
    expect(parity.strategy?.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(parity.steps.some((step) => step.with?.name === 'inactive-parity-package')).toBe(true);
    expect(requiredJob('build').steps.some((step) => step.run === 'npm run pack:checksums')).toBe(
      true,
    );
    expect(
      requiredJob('build').steps.find((step) => step.with?.name === 'inactive-parity-package')?.with
        ?.path,
    ).toContain('checksums.sha256');
    expect(parity.steps.find((step) => step.run?.startsWith('npx vitest run'))?.run).toBe(
      'npx vitest run --project smoke src/cli/opencode-inactive-parity.smoke.test.ts src/cli/opencode-inactive-installed.smoke.test.ts --silent=false --reporter=default --reporter=json --outputFile=inactive-parity-results.json',
    );
  });
  it('serializes critical Windows unit workers without dropping suites or changing PERF budgets', () => {
    const commands = requiredJob('critical-windows').steps.flatMap((step) =>
      step.run ? [step.run] : [],
    );
    expect(commands).toEqual([
      'npx vitest run --maxWorkers=1 --project unit src/hooks src/state src/audit/proofgraph src/adapters/git-porcelain.test.ts src/verification/implementation-subject.test.ts',
      'npx vitest run --project integration src/integration/proofgraph-replan-recovery.test.ts src/integration/evidence-approval-persistence.test.ts src/integration/reduced-ceremony-subject-artifacts-e2e.test.ts',
    ]);
    expect(commands.join(' ')).not.toMatch(/FLOWGUARD_PERF|PERF_BUDGET|testNamePattern|exclude/);
  });
  it('waits for documentation and every existing test dependency even on upstream failures', () => {
    expect(gate.name).toBe('ci-gate');
    expect(gate.needs).toEqual(dependencies);
    expect(gate.if).toBe('always()');
    const commands = requiredJob('doc-drift')
      .steps.map((step) => step.run ?? '')
      .join('\n');
    expect(commands).toContain('npm run check:pr-documentation --');
    expect(commands).toContain('npm run check:doc-drift');
  });

  it('passes only when every dependency succeeded', () => {
    const result = executeGate();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'rejects any dependency with result %j',
    (status) => {
      for (const dependency of dependencies) {
        const result = executeGate({ [dependency]: status });
        expect(result.error).toBeUndefined();
        expect(result.status, `${dependency}: ${result.stdout} ${result.stderr}`).toBe(1);
      }
    },
  );
});
