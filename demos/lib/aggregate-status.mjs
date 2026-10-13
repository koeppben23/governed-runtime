#!/usr/bin/env node
/**
 * @module demos/lib/aggregate-status
 * @description Exit-code aggregation for the demo wrapper: 0 is success, 2 is
 * NOT_VERIFIED, and every other code (127, 137, signals, ...) is FAILED.
 * FAILED outranks NOT_VERIFIED regardless of order.
 *
 * Usage: node demos/lib/aggregate-status.mjs <current> <code>
 *
 * @version v1
 */

export function aggregateStatus(current, code) {
  const normalizedCurrent = Number(current);
  const normalizedCode = Number(code);
  if (normalizedCode === 0) return normalizedCurrent === 1 ? 1 : normalizedCurrent;
  if (normalizedCode === 2) {
    if (normalizedCurrent === 1) return 1;
    return 2;
  }
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , current, code] = process.argv;
  process.stdout.write(String(aggregateStatus(current, code)));
}
