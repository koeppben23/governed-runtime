import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCases } from './load-cases.js';
import { runProcess } from './runners/process-runner.js';
import { evaluateAllAssertions, type AssertionContext } from './assertions.js';
import { scoreCase, summarizeResults } from './score.js';
import { redactSecrets } from './redact.js';
import type { RunnerConfig, ExecutedEvalCase, EvalCaseResult } from './schema.js';

// ── Environment resolution ──────────────────────────────────────────

export interface ResolvedEnv {
  childEnv: NodeJS.ProcessEnv;
  redactionValues: string[];
}

export function resolveRunnerEnv(config: RunnerConfig): ResolvedEnv {
  const redactionValues: string[] = [];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.staticEnv ?? {}),
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');
const RESULTS_DIR = join(ROOT, 'eval-results');

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
): Promise<{ executed: ExecutedEvalCase[]; redactionValues: string[] }> {
  const env = resolveRunnerEnv(config);

  let cases = loadCases(CASES_DIR).sort((a, b) => a.id.localeCompare(b.id));

  if (caseIds && caseIds.length > 0) {
    const requestedIds = [...new Set(caseIds)];
    const idSet = new Set(requestedIds);
    const unknown = requestedIds.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) {
      throw new Error(`Unknown case ID(s): ${unknown.join(', ')}`);
    }
    cases = cases.filter((c) => idSet.has(c.id));
    if (cases.length === 0) {
      throw new Error('No matching cases found');
    }
  }

  const results: ExecutedEvalCase[] = [];

  for (const evalCase of cases) {
    const startMs = Date.now();
    const forceCopy = evalCase.mode === 'workspace';

    let fixtureRoot: string;
    let cleanupTemp: (() => void) | undefined;

    if (evalCase.mode === 'workspace') {
      fixtureRoot = join(CASES_DIR, evalCase.id, 'fixture');
    } else {
      const empty = makeEmptyDir();
      fixtureRoot = empty.dir;
      cleanupTemp = empty.cleanup;
    }

    const outcome = await runProcess(config, fixtureRoot, evalCase.task, forceCopy, repoRoot, env.childEnv);

    if (cleanupTemp) {
      cleanupTemp();
    }

    if (outcome.status === 'runner_error') {
      const er = scoreCase(evalCase.id, [], Date.now() - startMs, outcome.message);
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
      assertionResults,
      Date.now() - startMs,
      undefined,
      snapshotSummary,
    );

    results.push({ evalCase, result, outcome });
  }

  return { executed: results, redactionValues: env.redactionValues };
}

// ── Report persistence ────────────────────────────────────────────────

export function writeReports(
  runnerName: string,
  executed: ExecutedEvalCase[],
  opts?: { redactionValues?: string[]; runId?: string },
): string {
  const redactionValues = opts?.redactionValues ?? [];
  const ordered = [...executed].sort((a, b) =>
    a.evalCase.id.localeCompare(b.evalCase.id),
  );
  const id = opts?.runId ?? `run-${Date.now()}`;
  const runDir = join(RESULTS_DIR, id);
  const casesDir = join(runDir, 'cases');
  mkdirSync(casesDir, { recursive: true });

  const caseResults = ordered.map((e) => e.result);
  const summary = summarizeResults(runnerName, caseResults);
  const redactedSummary = redactSecrets(JSON.stringify(summary), redactionValues);
  writeFileSync(join(runDir, 'summary.json'), redactedSummary + '\n');

  for (const e of ordered) {
    const caseDir = join(casesDir, e.evalCase.id);
    mkdirSync(caseDir, { recursive: true });

    writeFileSync(join(caseDir, 'prompt.txt'), redactSecrets(e.evalCase.task + '\n', redactionValues));

    if (e.outcome.status === 'completed' || e.outcome.status === 'runner_error') {
      writeFileSync(
        join(caseDir, 'stdout.txt'),
        redactSecrets(e.outcome.stdout || '', redactionValues),
      );
      writeFileSync(
        join(caseDir, 'stderr.txt'),
        redactSecrets(e.outcome.stderr || '', redactionValues),
      );
    }

    const outcomeSummary =
      e.outcome.status === 'completed'
        ? {
            status: 'completed' as const,
            exitCode: e.outcome.exitCode,
            durationMs: e.outcome.durationMs,
          }
        : {
            status: 'runner_error' as const,
            errorKind: e.outcome.errorKind,
            message: e.outcome.message,
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
    `# Eval Run: ${runnerName}`,
    '',
    `| Verdict | Count |`,
    `| --- | --- |`,
    `| PASS | ${summary.passed} |`,
    `| FAIL | ${summary.failed} |`,
    `| RUNNER_ERROR | ${summary.runnerErrors} |`,
    '',
    ...summary.cases.map((c) => `- **${c.caseId}**: ${c.verdict}`),
  ];
  writeFileSync(join(runDir, 'summary.md'), redactSecrets(mdLines.join('\n') + '\n', redactionValues));

  return runDir;
}
