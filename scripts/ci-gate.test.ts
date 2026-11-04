import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      'runs-on'?: string | string[];
      needs?: string | string[];
      if?: string;
      'timeout-minutes'?: number;
      strategy?: {
        matrix: {
          os?: string[];
          include?: Array<{ suite: string; file: string; filter: string }>;
        };
      };
      steps: {
        name?: string;
        uses?: string;
        shell?: string;
        run?: string;
        if?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }[];
    }
  >;
};
const prepareNode = parse(
  readFileSync(new URL('../.github/actions/prepare-node/action.yml', import.meta.url), 'utf8'),
) as { runs: { steps: (typeof workflow)['jobs'][string]['steps'] } };
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
  it('keeps installed parity out of the PR gate and in a separate acceptance workflow', () => {
    expect(workflow.jobs).not.toHaveProperty('inactive-parity');
    expect(workflow.jobs).not.toHaveProperty('inactive-parity-windows');
    expect(requiredJob('build').steps.some((step) => step.run === 'npm run pack:checksums')).toBe(
      false,
    );
    expect(dependencies).not.toContain('inactive-parity');

    const source = readFileSync(
      fileURLToPath(new URL('../.github/workflows/opencode-parity.yml', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('schedule:');
    expect(source).toContain('pull_request:');
    expect(source).toContain('run-parity-acceptance');
    const acceptance = parse(source) as {
      jobs: Record<
        string,
        {
          needs?: string;
          if?: string;
          'timeout-minutes'?: number;
          strategy?: {
            matrix?: { include?: Array<{ suite: string; file: string; filter: string }> };
          };
          steps?: Array<{
            id?: string;
            name?: string;
            uses?: string;
            run?: string;
            if?: string;
            env?: Record<string, string>;
            'continue-on-error'?: boolean;
          }>;
        }
      >;
    };
    for (const id of ['build', 'inactive-parity', 'inactive-parity-windows']) {
      expect(acceptance.jobs[id]?.if).toContain(
        "github.event.label.name == 'run-parity-acceptance'",
      );
    }
    for (const id of ['inactive-parity', 'inactive-parity-windows']) {
      expect(acceptance.jobs[id]?.needs).toBe('build');
      expect(acceptance.jobs[id]?.['timeout-minutes']).toBe(25);
    }
    expect(acceptance.jobs.build?.needs).toBeUndefined();
    const windowsSteps = acceptance.jobs['inactive-parity-windows']?.steps ?? [];
    const parity = windowsSteps.find((step) => step.id === 'windows-parity');
    expect(parity).toBeDefined();
    expect(parity?.env).toMatchObject({
      FLOWGUARD_BOOTSTRAP_PREFIX: 'inactive-parity-shared-bootstrap-${{ matrix.suite }}',
    });
    expect(parity?.env).not.toHaveProperty('TEMP');
    expect(parity?.env).not.toHaveProperty('TMP');
    expect(windowsSteps.some((step) => step.uses === './.github/actions/prepare-node')).toBe(true);
    expect(parity?.['continue-on-error']).toBeUndefined();
    expect(source).not.toContain('inactive-parity-volume-control');
    expect(acceptance.jobs['inactive-parity-windows']?.strategy?.matrix?.include).toEqual([
      {
        suite: 'mixed',
        file: 'src/cli/opencode-inactive-installed.smoke.test.ts',
        filter: 'scoped during live catalogue',
      },
      {
        suite: 'repo',
        file: 'src/cli/opencode-inactive-installed.smoke.test.ts',
        filter: 'Git=(true|false), scope=repo',
      },
      {
        suite: 'global',
        file: 'src/cli/opencode-inactive-installed.smoke.test.ts',
        filter: 'Git=(true|false), scope=global',
      },
      { suite: 'original', file: 'src/cli/opencode-inactive-parity.smoke.test.ts', filter: '' },
    ]);
  });
  it('prepares runner temp before every Windows test job without changing non-Windows environments', () => {
    const temp = prepareNode.runs.steps.find(
      (step) => step.name === 'Use runner temporary directory on Windows',
    );
    expect(temp).toMatchObject({
      if: "runner.os == 'Windows'",
      shell: 'bash',
      env: { TEST_TEMP: '${{ runner.temp }}' },
    });
    expect(prepareNode.runs.steps.indexOf(temp!)).toBeLessThan(
      prepareNode.runs.steps.findIndex((step) => step.run === 'npm ci'),
    );
    const windowsJobs: string[] = [];
    const directory = new URL('../.github/workflows/', import.meta.url);
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const parsed = parse(readFileSync(new URL(file, directory), 'utf8')) as typeof workflow;
      for (const [id, job] of Object.entries(parsed.jobs)) {
        if (!JSON.stringify([job['runs-on'], job.strategy?.matrix]).includes('windows-')) continue;
        windowsJobs.push(`${file}:${id}`);
        const shared = job.steps.findIndex(
          (step) => step.uses === './.github/actions/prepare-node',
        );
        const local = job.steps.findIndex((step) => step.name === temp?.name);
        const prepared = shared >= 0 ? shared : local;
        expect(
          prepared,
          `${file}:${id} must prepare Windows temporary directories`,
        ).toBeGreaterThanOrEqual(0);
        expect(prepared).toBeLessThan(
          job.steps.findIndex((step, index) => step.run !== undefined && index !== local),
        );
        if (shared < 0) expect(job.steps[local]).toEqual(temp);
        for (const step of job.steps) {
          expect(step.env ?? {}).not.toHaveProperty('TEMP');
          expect(step.env ?? {}).not.toHaveProperty('TMP');
        }
      }
    }
    expect(windowsJobs.sort()).toEqual([
      'ci.yml:architecture-windows',
      'ci.yml:critical-windows',
      'ci.yml:install',
      'ci.yml:install-verify',
      'ci.yml:scripts-windows',
      'opencode-parity.yml:inactive-parity-windows',
      'release.yml:release-smoke',
    ]);
  });

  it('exports literal Windows temp paths through GITHUB_ENV, including spaces and backslashes', () => {
    const temp = prepareNode.runs.steps.find(
      (step) => step.name === 'Use runner temporary directory on Windows',
    );
    const root = mkdtempSync(join(tmpdir(), 'fg-windows-test-env-'));
    try {
      const envFile = join(root, 'github-env');
      const windowsPath = 'D:\\a\\_temp\\literal path & data';
      const result = spawnSync('bash', ['-c', temp!.run!], {
        encoding: 'utf8',
        env: { ...process.env, TEST_TEMP: windowsPath, GITHUB_ENV: envFile },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(envFile, 'utf8')).toBe(`TEMP=${windowsPath}\nTMP=${windowsPath}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects a missing runner temp rather than exporting empty Windows paths', () => {
    const temp = prepareNode.runs.steps.find(
      (step) => step.name === 'Use runner temporary directory on Windows',
    );
    const root = mkdtempSync(join(tmpdir(), 'fg-missing-windows-test-env-'));
    try {
      const envFile = join(root, 'github-env');
      const result = spawnSync('bash', ['-c', temp!.run!], {
        encoding: 'utf8',
        env: { ...process.env, TEST_TEMP: '', GITHUB_ENV: envFile },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Runner temporary directory is required');
      expect(() => readFileSync(envFile, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
