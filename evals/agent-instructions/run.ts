import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMandatesDigest } from '../../src/cli/install-helpers.js';
import { PACKAGE_VERSION } from '../../src/shared/package-version.js';
import { evaluateAllAssertions, type AssertionContext } from './assertions.js';
import { loadCases } from './load-cases.js';
import { redactSecrets } from './redact.js';
import { runProcess } from './runners/process-runner.js';
import { scoreCase, summarizeResults } from './score.js';
import { EvalSummarySchema } from './schema.js';
import type {
  EvalRunnerProvenance,
  ExecutedEvalCase,
  RepositoryProvenance,
  RunnerConfig,
} from './schema.js';

export interface ResolvedEnv {
  childEnv: NodeJS.ProcessEnv;
  redactionValues: string[];
}

export interface RunnerCaseMetrics {
  readonly reviewPrecision?: number;
  readonly reviewRecall?: number;
  readonly falsePositiveFindings?: number;
  readonly falseNegativeDefects?: number;
  readonly schemaRetries?: number;
  readonly toolCallCount?: number;
  readonly unnecessaryToolCalls?: number;
  readonly clarificationCount?: number;
  readonly prematureStops?: number;
  readonly scopeDeviations?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly verificationExecutions?: number;
  readonly duplicateVerification?: number;
}

export const RUNNER_METRICS_PREFIX = 'FLOWGUARD_EVAL_METRICS_JSON=';

const RUNNER_METRIC_KEYS = new Set<keyof RunnerCaseMetrics>([
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
]);

const FRACTION_METRICS = new Set<keyof RunnerCaseMetrics>(['reviewPrecision', 'reviewRecall']);

export function extractRunnerCaseMetrics(stderr: string): RunnerCaseMetrics | null {
  const payloads = stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(RUNNER_METRICS_PREFIX))
    .map((line) => line.slice(RUNNER_METRICS_PREFIX.length));

  if (payloads.length === 0) return null;
  if (payloads.length > 1) {
    throw new Error(`Runner emitted ${payloads.length} metrics envelopes; exactly one is allowed`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloads[0]!);
  } catch (error) {
    throw new Error(
      `Runner metrics envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Runner metrics envelope must be a JSON object');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new Error('Runner metrics envelope must contain at least one metric');

  const metrics: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (!RUNNER_METRIC_KEYS.has(key as keyof RunnerCaseMetrics)) {
      throw new Error(`Runner metrics envelope contains unsupported metric: ${key}`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Runner metric ${key} must be a finite non-negative number`);
    }
    if (FRACTION_METRICS.has(key as keyof RunnerCaseMetrics) && value > 1) {
      throw new Error(`Runner metric ${key} must be between 0 and 1`);
    }
    metrics[key] = value;
  }
  return metrics as RunnerCaseMetrics;
}

const CHILD_RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function allowedRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_RUNTIME_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function resolveRunnerEnv(config: RunnerConfig): ResolvedEnv {
  const redactionValues: string[] = [];
  const childEnv: NodeJS.ProcessEnv = {
    ...allowedRuntimeEnv(),
    ...(config.staticEnv ?? {}),
    ...(config.seed ? { FLOWGUARD_EVAL_SEED: config.seed } : {}),
  };

  const missing: string[] = [];
  for (const name of config.secretEnvNames ?? []) {
    const val = process.env[name];
    if (val === undefined) {
      missing.push(name);
      continue;
    }
    childEnv[name] = val;
    redactionValues.push(val);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s):\n${missing.map((m) => `  - ${m}`).join('\n')}`,
    );
  }

  return { childEnv, redactionValues };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');
const RESULTS_DIR = join(ROOT, 'eval-results');
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function makeEmptyDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-empty-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export async function runEval(
  config: RunnerConfig,
  repoRoot: string,
  caseIds?: string[],
  opts?: { requireLiveHost?: boolean },
): Promise<{ executed: ExecutedEvalCase[]; redactionValues: string[] }> {
  const env = resolveRunnerEnv(config);
  const redactionValues = new Set(env.redactionValues);

  let cases = loadCases(CASES_DIR).sort((a, b) => a.id.localeCompare(b.id));

  if (caseIds && caseIds.length > 0) {
    const requestedIds = [...new Set(caseIds)];
    const idSet = new Set(requestedIds);
    const unknown = requestedIds.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) throw new Error(`Unknown case ID(s): ${unknown.join(', ')}`);
    cases = cases.filter((c) => idSet.has(c.id));
    if (cases.length === 0) throw new Error('No matching cases found');
  }

  if (opts?.requireLiveHost) {
    if (config.runnerKind !== 'live-host' || !config.instructionHost) {
      throw new Error('Strict live evaluation requires a host-bound live-host runner');
    }
    cases = cases.filter(
      (evalCase) =>
        evalCase.instructionSurface === 'repository_contributor' ||
        evalCase.instructionHost === config.instructionHost,
    );
    if (cases.length === 0) {
      throw new Error(`No eval cases match live host ${config.instructionHost}`);
    }
  }

  const results: ExecutedEvalCase[] = [];

  for (const evalCase of cases) {
    const startMs = Date.now();
    const forceCopy = evalCase.mode === 'workspace';
    const caseEnv: NodeJS.ProcessEnv = {
      ...env.childEnv,
      ...evalCase.syntheticSecrets,
    };
    for (const value of Object.values(evalCase.syntheticSecrets)) redactionValues.add(value);

    let fixtureRoot: string;
    let cleanupTemp: (() => void) | undefined;

    if (evalCase.mode === 'workspace') {
      fixtureRoot = join(CASES_DIR, evalCase.id, 'fixture');
    } else {
      const empty = makeEmptyDir();
      fixtureRoot = empty.dir;
      cleanupTemp = empty.cleanup;
    }

    const outcome = await runProcess(
      config,
      fixtureRoot,
      evalCase.task,
      forceCopy,
      repoRoot,
      caseEnv,
      evalCase.instructionSurface,
      evalCase.instructionHost,
    );

    cleanupTemp?.();

    if (outcome.status === 'runner_error') {
      const er = scoreCase(
        evalCase.id,
        evalCase.instructionSurface,
        [],
        Date.now() - startMs,
        outcome.message,
        undefined,
        evalCase.instructionHost,
      );
      results.push({ evalCase, result: er, outcome });
      continue;
    }

    const ctx: AssertionContext = {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      beforeSnapshot: outcome.beforeSnapshot,
      afterSnapshot: outcome.afterSnapshot,
      beforeContent: outcome.beforeContent,
      afterContent: outcome.afterContent,
    };

    const assertionResults = evaluateAllAssertions(evalCase.assertions, ctx);
    const snapshotSummary =
      evalCase.mode === 'workspace'
        ? {
            beforeFiles: outcome.beforeSnapshot.size,
            afterFiles: outcome.afterSnapshot.size,
            changed: (() => {
              const allFiles = new Set([
                ...outcome.beforeSnapshot.keys(),
                ...outcome.afterSnapshot.keys(),
              ]);
              return Array.from(allFiles).filter((k) => {
                const b = outcome.beforeSnapshot.get(k);
                const a = outcome.afterSnapshot.get(k);
                return !b || !a ? b !== a : b.sha256 !== a.sha256;
              });
            })(),
          }
        : undefined;

    const result = scoreCase(
      evalCase.id,
      evalCase.instructionSurface,
      assertionResults,
      Date.now() - startMs,
      undefined,
      snapshotSummary,
      evalCase.instructionHost,
    );

    results.push({ evalCase, result, outcome });
  }

  return { executed: results, redactionValues: [...redactionValues] };
}

function toRunnerProvenance(config: RunnerConfig): EvalRunnerProvenance {
  const safeConfig = {
    name: config.name,
    command: config.command,
    args: config.args,
    promptTransport: config.promptTransport,
    provider: config.provider,
    model: config.model,
    modelVersion: config.modelVersion,
    runnerVersion: config.runnerVersion,
    seed: config.seed,
    runnerKind: config.runnerKind,
    instructionHost: config.instructionHost,
    staticEnv: config.staticEnv,
    secretEnvNames: config.secretEnvNames,
    timeoutMs: config.timeoutMs,
  };
  return {
    name: config.name,
    command: config.command,
    args: [...config.args],
    promptTransport: config.promptTransport,
    provider: config.provider,
    model: config.model,
    modelVersion: config.modelVersion,
    runnerVersion: config.runnerVersion,
    ...(config.seed ? { seed: config.seed } : {}),
    ...(config.runnerKind ? { runnerKind: config.runnerKind } : {}),
    ...(config.instructionHost ? { instructionHost: config.instructionHost } : {}),
    timeoutMs: config.timeoutMs,
    configDigest: sha256(JSON.stringify(safeConfig)),
    secretEnvNames: [...config.secretEnvNames],
  };
}

function resolveRepositoryProvenance(repoRoot: string): RepositoryProvenance {
  let gitCommit: string;
  let gitDirty: boolean;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    gitDirty =
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0;
  } catch {
    throw new Error('Unable to resolve git repository provenance');
  }
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new Error(`Invalid git commit for eval provenance: ${gitCommit}`);
  }
  const corpus = loadCases(CASES_DIR)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((evalCase) => JSON.stringify(evalCase))
    .join('\n');
  return {
    gitCommit,
    gitDirty,
    flowguardVersion: PACKAGE_VERSION(),
    mandateDigest: computeMandatesDigest(),
    caseCorpusDigest: sha256(corpus),
  };
}

export function writeReports(
  config: RunnerConfig,
  executed: ExecutedEvalCase[],
  opts?: { redactionValues?: string[]; runId?: string; repoRoot?: string },
): string {
  const redactionValues = opts?.redactionValues ?? [];
  const ordered = [...executed].sort((a, b) => a.evalCase.id.localeCompare(b.evalCase.id));
  const id = opts?.runId ?? `run-${Date.now()}`;
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid eval run ID: ${id}`);
  const runDir = join(RESULTS_DIR, id);
  const casesDir = join(runDir, 'cases');
  mkdirSync(casesDir, { recursive: true });

  const caseResults = ordered.map((e) => e.result);
  const summary = EvalSummarySchema.parse(
    summarizeResults(
      toRunnerProvenance(config),
      resolveRepositoryProvenance(opts?.repoRoot ?? ROOT),
      caseResults,
    ),
  );
  const redactedSummary = redactSecrets(JSON.stringify(summary, null, 2), redactionValues);
  writeFileSync(join(runDir, 'summary.json'), redactedSummary + '\n');

  for (const e of ordered) {
    const caseDir = join(casesDir, e.evalCase.id);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'prompt.txt'), redactSecrets(e.evalCase.task + '\n', redactionValues));
    writeFileSync(join(caseDir, 'stdout.txt'), redactSecrets(e.outcome.stdout || '', redactionValues));
    writeFileSync(join(caseDir, 'stderr.txt'), redactSecrets(e.outcome.stderr || '', redactionValues));

    const runnerMetrics = extractRunnerCaseMetrics(e.outcome.stderr || '');
    if (runnerMetrics) {
      writeFileSync(
        join(caseDir, 'metrics.json'),
        redactSecrets(JSON.stringify(runnerMetrics, null, 2), redactionValues) + '\n',
      );
    }

    const outcomeSummary =
      e.outcome.status === 'completed'
        ? {
            status: 'completed' as const,
            exitCode: e.outcome.exitCode,
            durationMs: e.outcome.durationMs,
            instructionSurface: e.outcome.instructionSurface,
            ...(e.outcome.instructionHost ? { instructionHost: e.outcome.instructionHost } : {}),
          }
        : {
            status: 'runner_error' as const,
            errorKind: e.outcome.errorKind,
            message: e.outcome.message,
            ...(e.outcome.instructionSurface ? { instructionSurface: e.outcome.instructionSurface } : {}),
            ...(e.outcome.instructionHost ? { instructionHost: e.outcome.instructionHost } : {}),
          };

    writeFileSync(
      join(caseDir, 'outcome.json'),
      redactSecrets(JSON.stringify(outcomeSummary, null, 2), redactionValues) + '\n',
    );
    writeFileSync(
      join(caseDir, 'result.json'),
      redactSecrets(JSON.stringify(e.result, null, 2), redactionValues) + '\n',
    );
  }

  const mdLines = [
    `# Eval Run: ${summary.runner.name}`,
    '',
    `- Provider/model: ${summary.runner.provider}/${summary.runner.model} (${summary.runner.modelVersion})`,
    `- Runner version: ${summary.runner.runnerVersion}`,
    `- Seed: ${summary.runner.seed ?? 'unspecified'}`,
    `- Runner kind/host: ${summary.runner.runnerKind ?? 'unspecified'}/${summary.runner.instructionHost ?? 'unbound'}`,
    `- Effective timeout: ${summary.runner.timeoutMs} ms`,
    `- Runner config digest: ${summary.runner.configDigest}`,
    `- Git commit: ${summary.repository.gitCommit}`,
    `- Git dirty: ${summary.repository.gitDirty}`,
    `- FlowGuard version: ${summary.repository.flowguardVersion}`,
    `- Mandate digest: ${summary.repository.mandateDigest}`,
    `- Case corpus digest: ${summary.repository.caseCorpusDigest}`,
    '',
    '## By Instruction Surface',
    '',
    '| Surface | PASS | FAIL | RUNNER_ERROR |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(summary.byInstructionSurface).map(
      ([surface, counts]) =>
        `| ${surface} | ${counts.passed} | ${counts.failed} | ${counts.runnerErrors} |`,
    ),
    '',
    '## By Product Host',
    '',
    '| Host | PASS | FAIL | RUNNER_ERROR |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(summary.byInstructionHost).map(
      ([host, counts]) => `| ${host} | ${counts.passed} | ${counts.failed} | ${counts.runnerErrors} |`,
    ),
    '',
    ...summary.cases.map(
      (c) =>
        `- **${c.caseId}** (${c.instructionSurface}${c.instructionHost ? `/${c.instructionHost}` : ''}): ${c.verdict}`,
    ),
  ];
  writeFileSync(join(runDir, 'summary.md'), redactSecrets(mdLines.join('\n') + '\n', redactionValues));

  return runDir;
}
