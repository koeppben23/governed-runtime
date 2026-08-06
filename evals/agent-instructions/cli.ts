#!/usr/bin/env node

/**
 * cli.ts
 *
 * CLI entry point for the agent instruction eval runner.
 *
 * Usage:
 *   npx tsx evals/agent-instructions/cli.ts --config runner.json
 *
 * Runner config (JSON):
 *   {
 *     "name": "example-host",
 *     "command": "agent-command",
 *     "args": ["run"],
 *     "timeoutMs": 600000
 *   }
 *
 * Exit codes:
 *   0 — all cases PASS
 *   1 — at least one case FAIL
 *   2 — framework error or RUNNER_ERROR
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RunnerConfigSchema } from './schema.js';
import { runEval, writeReports } from './run.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.config) {
    console.error('Usage: npx tsx evals/agent-instructions/cli.ts --config <runner.json>');
    process.exit(2);
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(resolve(values.config), 'utf-8'));
  } catch (err) {
    console.error(`Failed to read config: ${(err as Error).message}`);
    process.exit(2);
  }

  const parsed = RunnerConfigSchema.safeParse(config);
  if (!parsed.success) {
    console.error('Invalid runner config:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(2);
  }

  const executed = await runEval(parsed.data);
  const runDir = writeReports(parsed.data.name, executed);

  const hasFail = executed.some((e) => e.result.verdict === 'FAIL');
  const hasRunnerError = executed.some((e) => e.result.verdict === 'RUNNER_ERROR');

  console.log(`Results written to: ${runDir}`);
  for (const e of executed) {
    console.log(`  ${e.evalCase.id}: ${e.result.verdict}`);
  }

  if (hasRunnerError) {
    process.exit(2);
  } else if (hasFail) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(2);
});
