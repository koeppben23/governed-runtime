/**
 * @module demos/lib/results
 * @description Shared demo result taxonomy (F10). A correctly refused negative
 * control is CONTROL_PASSED, never COMPLETE; FAILED outranks NOT_VERIFIED.
 *
 * @version v1
 */

export const RESULT = Object.freeze({
  COMPLETE: 'COMPLETE',
  CONTROL_PASSED: 'CONTROL_PASSED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  FAILED: 'FAILED',
});

export function summarizeResults(records) {
  const summary = {
    total: records.length,
    COMPLETE: 0,
    CONTROL_PASSED: 0,
    NOT_VERIFIED: 0,
    FAILED: 0,
  };
  for (const record of records) {
    const result = record?.result;
    if (
      result === RESULT.COMPLETE ||
      result === RESULT.CONTROL_PASSED ||
      result === RESULT.NOT_VERIFIED
    ) {
      summary[result] += 1;
    } else {
      summary.FAILED += 1;
    }
  }
  return summary;
}

export function resultLine(records, label = 'RESULT') {
  const summary = summarizeResults(records);
  return (
    `${label}: ${summary.COMPLETE} COMPLETE, ${summary.CONTROL_PASSED} CONTROL_PASSED, ` +
    `${summary.NOT_VERIFIED} NOT_VERIFIED, ${summary.FAILED} FAILED / ${summary.total}`
  );
}

/** Exit 1 for contract violations, 2 for unreached proofs, 0 for completed evidence. */
export function exitCodeForResults(records) {
  const summary = summarizeResults(records);
  if (summary.FAILED > 0) return 1;
  if (summary.NOT_VERIFIED > 0) return 2;
  return 0;
}

/** A persist failure that must not be re-labelled as a contract violation. */
export class DemoNotVerifiedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoNotVerifiedError';
    this.code = 'DEMO_NOT_VERIFIED';
  }
}
