import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCases } from './load-cases.js';
import { runProcess } from './runners/process-runner.js';
import { evaluateAllAssertions, type AssertionContext } from './assertions.js';
import { scoreCase, summarizeResults } from './score.js';
import type { RunnerConfig, EvalCaseResult } from './schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');
const RESULTS_DIR = join(ROOT, 'eval-results');

// ── Output-only fixture (empty dir) ───────────────────────────────────

function emptyFixtureDir(): string {
  const dir = join(tmpdir(), `eval-empty-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Main entry ────────────────────────────────────────────────────────

export async function runEval(config: RunnerConfig): Promise<EvalCaseResult[]> {
  const cases = loadCases(CASES_DIR).sort((a, b) => a.id.localeCompare(b.id));
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    const startMs = Date.now();

    const fixtureRoot =
      evalCase.mode === 'workspace'
        ? join(CASES_DIR, evalCase.id, 'fixture')
        : emptyFixtureDir();

    const outcome = await runProcess(config, fixtureRoot);

    if (outcome.status === 'runner_error') {
      results.push(
        scoreCase(evalCase.id, [], Date.now() - startMs, outcome.message),
      );
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
            changed: Array.from(outcome.afterSnapshot.keys()).filter((k) => {
              const b = outcome.beforeSnapshot.get(k);
              const a = outcome.afterSnapshot.get(k);
              return !b || !a ? b !== a : b.sha256 !== a.sha256;
            }),
          }
        : undefined;

    results.push(
      scoreCase(evalCase.id, assertionResults, Date.now() - startMs, undefined, snapshotSummary),
    );
  }

  return results;
}

// ── Report persistence ────────────────────────────────────────────────

export function writeReports(
  runnerName: string,
  results: EvalCaseResult[],
  runId?: string,
): string {
  const id = runId ?? `run-${Date.now()}`;
  const runDir = join(RESULTS_DIR, id);
  const casesDir = join(runDir, 'cases');
  mkdirSync(casesDir, { recursive: true });

  const summary = summarizeResults(runnerName, results);
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  for (const r of results) {
    const caseDir = join(casesDir, r.caseId);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'result.json'), JSON.stringify(r, null, 2));
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
  writeFileSync(join(runDir, 'summary.md'), mdLines.join('\n') + '\n');

  return runDir;
}
