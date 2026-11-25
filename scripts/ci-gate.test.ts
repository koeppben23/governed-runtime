import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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
          include?: Array<{
            name?: string;
            files?: string;
            suite?: string;
            file?: string;
            filter?: string;
          }>;
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
        'continue-on-error'?: boolean;
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

function smokeTestFiles(directory = join(REPO_ROOT, 'src')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...smokeTestFiles(file));
    } else if (entry.name.endsWith('.smoke.test.ts')) {
      files.push(relative(REPO_ROOT, file).split(sep).join('/'));
    }
  }
  return files.sort();
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
  it('documents every ci-gate dependency in README.md', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

    for (const dependency of dependencies) {
      expect(readme, dependency).toContain(dependency.replaceAll('_', '-'));
    }
  });

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
  it('runs unit and integration coverage shards on separate two-worker runners', () => {
    for (const [jobName, project] of [
      ['coverage-unit', 'unit'],
      ['coverage-integration', 'integration'],
    ] as const) {
      const job = requiredJob(jobName);
      expect(job['timeout-minutes'], jobName).toBe(25);
      const commands = job.steps.flatMap((step) => (step.run ? [step.run] : []));
      expect(commands).toEqual([`npm run test:coverage:shard -- ${project}`]);
      expect(job.steps.some((step) => step.uses === './.github/actions/prepare-node')).toBe(true);
      expect(
        job.steps.some(
          (step) =>
            step.uses?.includes('actions/upload-artifact') &&
            step.with?.name === `coverage-shard-${project}` &&
            step.with?.path === `coverage-shards/${project}/`,
        ),
      ).toBe(true);
      expect(job.steps.every((step) => step['continue-on-error'] !== true)).toBe(true);
    }
    const packageScripts = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ).scripts as Record<string, string>;
    expect(packageScripts['test:coverage:shard']).toBe('node scripts/coverage-shard.mjs');
    expect(packageScripts['test:coverage:merge']).toBe('node scripts/coverage-merge.mjs');
  });

  it('merges both coverage shards into the canonical coverage gate before ci-gate', () => {
    const job = requiredJob('coverage');
    expect(job.needs).toEqual(['coverage-unit', 'coverage-integration']);
    expect(job['timeout-minutes']).toBe(15);
    const downloads = job.steps
      .filter((step) => step.uses?.includes('actions/download-artifact'))
      .map((step) => step.with?.name);
    expect(downloads).toEqual(['coverage-shard-unit', 'coverage-shard-integration']);
    expect(job.steps.map((step) => step.run).filter(Boolean)).toContain(
      'npm run test:coverage:merge -- --ci',
    );
    expect(
      job.steps.some((step) => step.run?.includes('test:coverage:ci')),
      'the monolithic CI runner must not remain a second coverage authority',
    ).toBe(false);
    expect(
      job.steps.some(
        (step) =>
          step.uses?.includes('actions/upload-artifact') && step.with?.name === 'coverage-report',
      ),
    ).toBe(true);
    expect(
      job.steps.some((step) => step.name === 'Comment coverage summary'),
      'PR summary bookkeeping must not be removed with the old runner',
    ).toBe(true);
    expect(
      job.steps.find((step) => step.run?.includes('test:coverage:merge'))?.['continue-on-error'],
    ).toBeUndefined();
    expect(gate.needs).toContain('coverage');
  });

  it('splits smoke into three complete groups sharing one checksum-bound artifact', () => {
    const suite = requiredJob('smoke-suite');
    expect(suite['timeout-minutes']).toBe(15);
    expect(suite.needs).toBe('smoke-package');
    const includes = suite.strategy?.matrix.include ?? [];
    expect(includes.map((entry) => entry.name)).toEqual([
      'native-parity',
      'installed-host',
      'package-install',
      'runtime-install',
    ]);
    const listed = includes.flatMap((entry) =>
      (entry.files ?? '').trim().split(/\s+/).filter(Boolean),
    );
    expect(listed.length, 'a smoke file must appear in exactly one group').toBe(
      new Set(listed).size,
    );
    expect(listed.sort()).toEqual(smokeTestFiles());

    const suiteCommands = suite.steps.flatMap((step) => (step.run ? [step.run] : [])).join('\n');
    expect(suiteCommands).toContain('npx vitest run --project smoke ${{ matrix.files }}');
    expect(suiteCommands).toContain('sha256sum -c checksums.sha256');
    expect(suiteCommands).toContain('FLOWGUARD_TARBALL=');
    expect(suiteCommands).not.toContain('npm run test:smoke');
    expect(
      suite.steps.some(
        (step) =>
          step.uses?.includes('actions/download-artifact') && step.with?.name === 'smoke-package',
      ),
    ).toBe(true);
    expect(suite.steps.every((step) => step['continue-on-error'] !== true)).toBe(true);

    const pack = requiredJob('smoke-package');
    expect(pack.needs).toBe('build');
    expect(pack.steps.some((step) => step.run?.includes('npm run pack:checksums'))).toBe(true);
    expect(
      pack.steps.some((step) =>
        step.run?.includes('mv flowguard-core-*.tgz checksums.sha256 smoke-package/'),
      ),
    ).toBe(true);
    expect(
      pack.steps.some(
        (step) =>
          step.uses?.includes('actions/upload-artifact') &&
          step.with?.name === 'smoke-package' &&
          step.with?.path === 'smoke-package/',
      ),
    ).toBe(true);

    const smoke = requiredJob('smoke');
    expect(smoke.needs).toBe('smoke-suite');
    expect(smoke.if).toBe('always()');
    const aggregator = smoke.steps.flatMap((step) => (step.run ? [step.run] : [])).join('\n');
    expect(aggregator).toContain('needs.smoke-suite.result');
    expect(aggregator).toContain('exit 1');
    expect(dependencies).not.toContain('smoke');
    expect(requiredJob('ci-runtime-report').needs).toEqual(
      expect.arrayContaining(['smoke-package', 'smoke-suite', 'smoke']),
    );
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
