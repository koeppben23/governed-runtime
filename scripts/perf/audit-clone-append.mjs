/**
 * Actual same-filesystem durability benchmark. No simulated reflink timings.
 *
 * npm ci && npm run build && node scripts/perf/audit-clone-append.mjs
 *
 * Measures only snapshot publication cost, not chain parsing/verification,
 * session locking, or state reconciliation. A clone-unsupported filesystem
 * is reported explicitly and does NOT establish the factor-3 claim.
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as persistence from '../../dist/adapters/persistence.js';
import * as auditClone from '../../dist/adapters/persistence-audit-clone.js';

const dir = await fs.mkdtemp(join(tmpdir(), 'fg-reflink-benchmark-'));
const baselinePath = join(dir, 'rewrite.jsonl');
const clonePath = join(dir, 'clone.jsonl');
const line = JSON.stringify({ id: randomUUID(), event: 'benchmark' }) + '\n';

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function sample(fn, rounds = 7) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

try {
  const repeats = Math.ceil((8 * 1024 * 1024) / Buffer.byteLength(line));
  const data = line.repeat(repeats);
  await fs.writeFile(baselinePath, data);
  await fs.writeFile(clonePath, data);
  const probe = join(dir, 'reflink-probe');
  let supported = false;
  try {
    const cloneFlags = constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL;
    await fs.copyFile(clonePath, probe, cloneFlags);
    supported = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`NOT_VERIFIED: filesystem has no forced CoW clone: ${reason}`);
  } finally {
    await fs.rm(probe, { force: true });
  }
  if (supported) {
    let baselineContent = data;
    let clonedContent = data;
    const baselineMs = await sample(async () => {
      baselineContent += line;
      await persistence.durableAtomicWrite(baselinePath, baselineContent);
    });
    const optimizedMs = await sample(async () => {
      clonedContent += line;
      await auditClone.durableAtomicCloneAppend(clonePath, line, clonedContent);
    });
    const baselineBytes = await fs.readFile(baselinePath);
    const cloneBytes = await fs.readFile(clonePath);
    if (!baselineBytes.equals(cloneBytes)) {
      throw new Error('Clone benchmark output differs from durable rewrite output');
    }
    const speedup = baselineMs / optimizedMs;
    console.log(`Baseline full rewrite: ${baselineMs.toFixed(2)} ms`);
    console.log(`Clone+append+fsync: ${optimizedMs.toFixed(2)} ms`);
    console.log(`Speedup: ${speedup.toFixed(2)}x`);
    if (speedup < 3) process.exitCode = 1;
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
