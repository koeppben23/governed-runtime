/**
 * Reproduce the original O(n²) outbox membership and measure the real linear
 * implementation exported from the built FlowGuard package.
 *
 * Run from the repository root:
 *   npm ci
 *   npm run build
 *   node scripts/perf/audit-outbox-order.mjs
 *
 * Prints median per-call latency and speedup. This is an isolated algorithmic
 * benchmark; it does not measure fsync, JSONL I/O or complete state commits.
 */
import { performance } from 'node:perf_hooks';
import { assertPreparedOrderMatchesPersisted } from '../../dist/integration/tools/audit-outbox-order.js';

function oldOrder(prepared, persisted, persistedById) {
  const commonIds = prepared
    .map((operation) => operation.operationId)
    .filter((id) => persistedById.has(id));
  const persistedCommonIds = persisted
    .map((operation) => operation.operationId)
    .filter((id) => commonIds.includes(id));
  if (
    commonIds.length !== persistedCommonIds.length ||
    commonIds.some((id, index) => id !== persistedCommonIds[index])
  ) {
    throw new Error('OUTBOX_ORDER_CONFLICT');
  }
}

function operation(index) {
  return { operationId: String(index).padStart(12, '0') };
}
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function sample(fn, data, rounds) {
  const { prepared, persisted, byId } = data;
  for (let i = 0; i < 3; i++) fn(prepared, persisted, byId);
  const timings = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    fn(prepared, persisted, byId);
    timings.push(performance.now() - start);
  }
  return median(timings);
}

console.log('Outbox order membership (median ms, Node.js).');
console.log('N\tBaseline O(n²)\tCurrent O(n)\tSpeedup');
let finalSpeedup = 0;
for (const count of [100, 1_000, 5_000, 10_000]) {
  const persisted = Array.from({ length: count }, (_, i) => operation(i));
  const prepared = [...persisted];
  const byId = new Map(persisted.map((entry) => [entry.operationId, entry]));
  const data = { prepared, persisted, byId };
  const baselineMs = sample(oldOrder, data, 9);
  const currentMs = sample(assertPreparedOrderMatchesPersisted, data, 9);
  const speedup = baselineMs / currentMs;
  console.log(`${count}\t${baselineMs.toFixed(3)}\t${currentMs.toFixed(3)}\t${speedup.toFixed(2)}x`);
  if (count === 10_000) finalSpeedup = speedup;
}
if (finalSpeedup < 3) {
  console.error(`NOT_VERIFIED: 3x target not met; measured ${finalSpeedup.toFixed(2)}x`);
  process.exitCode = 1;
}
