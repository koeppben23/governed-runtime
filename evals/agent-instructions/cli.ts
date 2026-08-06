#!/usr/bin/env node

/**
 * cli.ts
 *
 * CLI entry point for the agent instruction eval runner.
 *
 * Usage:
 *   npx tsx evals/agent-instructions/cli.ts --config runner.json [--advisory] [--case case-id] [--timeout-ms N]
 *
 * Runner config (JSON):
 *   {
 *     "name": "example-host",
 *     "command": "agent-command",
 *     "promptTransport": "stdin",
 *     "args": ["run"],
 *     "timeoutMs": 600000,
 *     "staticEnv": { "CI": "true" },
 *     "secretEnvNames": ["OPENAI_API_KEY"]
 *   }
 *
 * Exit codes:
 *   0 — all PASS (or FAIL in advisory mode)
 *   1 — at least one FAIL (normal mode only)
 *   2 — framework error or RUNNER_ERROR
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RunnerConfigSchema } from './schema.js';
import { runEval, writeReports } from './run.js';
import { determineExitCode } from './exit-code.js';
import { renderGitHubSummary } from './github-summary.js';

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      advisory: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      'timeout-ms': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.config) {
    console.error('Usage: npx tsx evals/agent-instructions/cli.ts --config <runner.json> [--advisory] [--case id] [--timeout-ms N]');
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

  // Apply timeout override
  if (values['timeout-ms']) {
    const ms = Number(values['timeout-ms']);
    if (!Number.isInteger(ms) || ms < 1) {
      console.error('--timeout-ms must be a positive integer');
      process.exit(2);
    }
    config.timeoutMs = ms;
  }

  const { executed, redactionValues } = await runEval(config, REPO_ROOT, values.case);
  const runDir = writeReports(config.name, executed, { redactionValues });

  // GitHub Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      renderGitHubSummary(config.name, executed),
    );
  }

  console.log(`Results written to: ${runDir}`);
  for (const e of executed) {
    console.log(`  ${e.evalCase.id}: ${e.result.verdict}`);
  }

  process.exit(determineExitCode(executed, values.advisory));
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(2);
});
