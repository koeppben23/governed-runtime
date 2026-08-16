/**
 * github-summary.ts
 *
 * Renders a GitHub Step Summary markdown table from eval results.
 * Does not write to disk — callers use $GITHUB_STEP_SUMMARY.
 */

import type { ExecutedEvalCase } from './schema.js';

function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

export function renderGitHubSummary(
  runnerName: string,
  executed: ExecutedEvalCase[],
): string {
  const safeRunner = escapeCell(runnerName);
  const lines = [
    `## Agent Instruction Eval: ${safeRunner}`,
    '',
    '| Case | Verdict | Hard Failures | Advisory Failures |',
    '| --- | --- | ---: | ---: |',
  ];

  for (const e of executed) {
    const hard = e.result.assertionResults.filter(
      (r) => r.severity === 'hard' && !r.passed,
    ).length;
    const advisory = e.result.assertionResults.filter(
      (r) => r.severity === 'advisory' && !r.passed,
    ).length;
    lines.push(
      `| ${escapeCell(e.evalCase.id)} | ${e.result.verdict} | ${hard} | ${advisory} |`,
    );
  }

  lines.push('');

  return lines.join('\n');
}
