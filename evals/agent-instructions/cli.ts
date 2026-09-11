#!/usr/bin/env node

/**
 * CLI entry point for the agent instruction eval runner.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { determineExitCode } from './exit-code.js';
import { renderGitHubSummary } from './github-summary.js';
import { writeMetricsAndComparison } from './non-inferiority.js';
import { runEval, writeReports } from './run.js';
import { RunnerConfigSchema } from './schema.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      advisory: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      'timeout-ms': { type: 'string' },
      'require-live-host': { type: 'boolean', default: false },
      'baseline-summary': { type: 'string' },
      'require-non-inferiority': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.config) {
    console.error(
      'Usage: npx tsx evals/agent-instructions/cli.ts --config <runner.json> [--advisory] [--case id] [--timeout-ms N] [--require-live-host] [--baseline-summary summary.json] [--require-non-inferiority]',
    );
    process.exit(2);
  }

  if (values['require-non-inferiority'] && !values['baseline-summary']) {
    console.error('--require-non-inferiority requires --baseline-summary <summary.json>');
    process.exit(2);
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(resolve(values.config), 'utf-8'));
  } catch (err) {
    console.error(`Failed to read config: ${(err as Error).message}`);
    process.exit(2);
  }

  const parsed = RunnerConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    console.error('Invalid runner config:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(2);
  }

  const config = parsed.data;

  if (values['timeout-ms']) {
    const ms = Number(values['timeout-ms']);
    if (!Number.isInteger(ms) || ms < 1) {
      console.error('--timeout-ms must be a positive integer');
      process.exit(2);
    }
    config.timeoutMs = ms;
  }

  const requireNonInferiority = values['require-non-inferiority'] === true;
  // A required non-inferiority verdict is assurance evidence, so it must never be
  // satisfied by synthetic plumbing. Explicit --require-live-host remains useful
  // for live runs that do not compare against a baseline.
  const requireLiveHost = values['require-live-host'] === true || requireNonInferiority;
  if (requireLiveHost) {
    if (config.runnerKind !== 'live-host') {
      console.error('assurance evaluation requires runnerKind="live-host" in the runner config');
      process.exit(2);
    }
    if (!config.instructionHost) {
      console.error('assurance evaluation requires an explicit instructionHost in the runner config');
      process.exit(2);
    }
    if (config.provider.toLowerCase() === 'synthetic') {
      console.error('assurance evaluation rejects synthetic providers');
      process.exit(2);
    }
  }
  if (requireNonInferiority && !config.seed) {
    console.error('--require-non-inferiority requires a deterministic runner seed');
    process.exit(2);
  }

  const { executed, redactionValues } = await runEval(config, REPO_ROOT, values.case, {
    requireLiveHost,
  });
  const runDir = writeReports(config, executed, { redactionValues, repoRoot: REPO_ROOT });
  const comparison = writeMetricsAndComparison(
    runDir,
    values['baseline-summary'] ? resolve(values['baseline-summary']) : undefined,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderGitHubSummary(config.name, executed));
  }

  console.log(`Results written to: ${runDir}`);
  for (const e of executed) {
    console.log(`  ${e.evalCase.id}: ${e.result.verdict}`);
  }
  if (comparison) {
    console.log(`Non-inferiority: ${comparison.verdict}`);
    for (const regression of comparison.regressions) console.log(`  regression: ${regression}`);
    for (const blocker of comparison.blockers) console.log(`  NOT_VERIFIED: ${blocker}`);
  }

  let exitCode = determineExitCode(executed, values.advisory);
  if (requireNonInferiority && comparison?.verdict !== 'PASS') exitCode = 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(2);
});
