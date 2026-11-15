/**
 * Real-repository V2 bootstrap benchmark.
 *
 * npm run build && node scripts/perf/runtime-bootstrap.mjs
 *
 * Baseline: fresh canonical session authority followed by a redundant
 * diagnostic fingerprint Git probe. Optimized: fresh canonical authority,
 * reusing only its verified fingerprint for this invocation's logging metadata.
 * Neither arm caches authority across calls. This measures the complete
 * invocation-local bootstrap (not other plugin hooks).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolveSessionAuthority } from '../../dist/adapters/session-authority.js';
import { createWorkspace } from '../../dist/integration/plugin-workspace.js';

const root = process.cwd();
const sessionId = randomUUID();
const rounds = 15;

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
  return {
    n: sorted.length,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
  };
}

async function resolveFreshAuthority() {
  const authority = await resolveSessionAuthority({
    root,
    sessionId,
    deadlineMs: 4_000,
  });
  if (authority.status === 'unavailable') {
    throw new Error(`Canonical Git authority unavailable: ${authority.code}: ${authority.reason}`);
  }
  return authority;
}

async function baseline() {
  const authority = await resolveFreshAuthority();
  const ws = createWorkspace({ auditWorktree: authority.worktreeRoot });
  const diagnostic = await ws.resolveFingerprint();
  if (diagnostic !== authority.fingerprint) {
    throw new Error('Baseline diagnostic fingerprint disagreed with verified authority');
  }
}

async function optimized() {
  const authority = await resolveFreshAuthority();
  const ws = createWorkspace({
    auditWorktree: authority.worktreeRoot,
    diagnosticBootstrapFingerprint: authority.fingerprint,
  });
  const diagnostic = await ws.resolveFingerprint();
  if (diagnostic !== authority.fingerprint) {
    throw new Error('Optimized diagnostic fingerprint disagreed with verified authority');
  }
}

async function time(operation) {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

// Warm up both paths. Alternate order to reduce persistent warm-cache bias.
for (let i = 0; i < 2; i++) {
  await baseline();
  await optimized();
}
const originalTimes = [];
const optimizedTimes = [];
for (let i = 0; i < rounds; i++) {
  if (i % 2 === 0) {
    originalTimes.push(await time(baseline));
    optimizedTimes.push(await time(optimized));
  } else {
    optimizedTimes.push(await time(optimized));
    originalTimes.push(await time(baseline));
  }
}
const before = distribution(originalTimes);
const after = distribution(optimizedTimes);
const speedup = before.p50 / after.p50;
console.log(
  JSON.stringify(
    {
      benchmark: 'same-invocation-v2-runtime-bootstrap',
      worktree: root,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      units: 'ms',
      baseline: before,
      optimized: after,
      speedupP50: speedup,
      result: speedup > 1 ? 'IMPROVED' : 'NO_MEASURED_IMPROVEMENT',
      scope: 'runtime bootstrap only; canonical authority resolves for both paths',
    },
    null,
    2,
  ),
);
