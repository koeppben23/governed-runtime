/**
 * @module integration/tools/error-format
 * @description Tool-boundary error formatting.
 *
 * Owns how a thrown error becomes a structured, agent-consumable tool result.
 * Extracted from helpers.ts so the boundary contract has one place to change
 * and helpers.ts stays within its size budget.
 *
 * @version v1
 */

import { ZodError } from 'zod';
import { formatBlocked } from './helpers.js';

/** Upper bound on issues echoed to the agent, so one bad artifact cannot flood the context. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Condense a schema failure into a bounded, path-anchored summary.
 *
 * The raw `ZodError.message` is a multi-kilobyte JSON dump of every issue with
 * its union branches. Emitting it verbatim gave the agent no actionable field
 * while consuming the response.
 */
function summarizeSchemaIssues(err: ZodError): string {
  const issues = err.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
  const omitted = err.issues.length - issues.length;
  return omitted > 0 ? `${issues.join('; ')} (+${omitted} more)` : issues.join('; ');
}

/**
 * Wrap any thrown error into a structured JSON string via the reason registry.
 *
 * A schema violation is reported under its own code instead of `INTERNAL_ERROR`:
 * it is a deterministic contract failure with a known offending field, not an
 * unclassifiable crash, and the recovery for the two differs.
 */
export function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    return formatBlocked('ARTIFACT_SCHEMA_VALIDATION_FAILED', {
      issues: summarizeSchemaIssues(err),
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'INTERNAL_ERROR';
  // Pass `reason` alongside `message` so templates using a `{reason}`
  // placeholder render the underlying cause instead of leaking the literal.
  return formatBlocked(code, { message, reason: message });
}
