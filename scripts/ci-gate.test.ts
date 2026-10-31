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
      needs?: string[];
      if?: string;
      steps: { run?: string }[];
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
