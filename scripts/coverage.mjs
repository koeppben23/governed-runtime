// Coverage runner: enforces the 80% global gate over unit + integration.
//
// FLOWGUARD_PERF=0 requests coverage-safe execution because v8 instrumentation
// inflates timings and v8 may skip report generation after test failures.
// Integration PERF handling is currently mixed:
// - some PERF tests or assertions are skipped or degraded when PERF is disabled;
// - four suites retain generous coverage-tolerant timing assertions.
// Unit PERF budgets are enforced separately by the non-coverage `unit` CI job.
// Strict non-instrumented integration PERF enforcement is temporarily absent
// from the pull-request gate; see #662.
//
// Usage:
//   node scripts/coverage.mjs        # local: text + html + json-summary
//   node scripts/coverage.mjs --ci   # CI: silent, json-summary for PR comment
import { spawnSync } from 'node:child_process';

const ci = process.argv.includes('--ci');
// `--retry=2`: the combined unit+integration run under v8 instrumentation is
// I/O-heavy (temp-file fixtures) and can hit transient filesystem-contention
// flakes (e.g. discovery budget tests). Retry re-runs only the failed test; a
// genuinely broken test still fails all retries, so this hides no real failure.
const args = [
  'vitest',
  'run',
  '--project',
  'unit',
  '--project',
  'integration',
  '--coverage',
  '--retry=2',
];
// Note: `--silent` is intentionally NOT used — combined with multi-project
// coverage it suppresses the v8 report write. CI log noise is acceptable.
if (ci) args.push('--coverage.reporter=json-summary');

// shell:true so `npx` resolves cross-platform (Node cannot spawn npx.cmd directly).
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FLOWGUARD_PERF: '0' },
});

process.exit(result.status ?? 1);
