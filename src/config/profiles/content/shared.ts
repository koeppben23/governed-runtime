/**
 * @module config/profiles/content/shared
 * @description Shared template strings used across all stack-specific profile content files.
 *
 * Eliminates duplication of DETECTED_STACK_INSTRUCTION and NEGATIVE_TEST_MATRIX
 * templates that were previously copied identically across 4 profile files.
 *
 * @version v1
 */

/** Common instruction for using detected stack metadata in verification planning. */
export const DETECTED_STACK_INSTRUCTION = `\
## Detected Stack

Use flowguard_status.detectedStack when present. Prefer detected tools,
frameworks, runtimes, and versions over generic defaults.
When choosing verification commands, prefer
flowguard_status.verificationCandidates when present. They are advisory
planning hints, not executed checks.
Do not make version-specific claims without repository evidence; mark
unsupported claims as NOT_VERIFIED.`;

/**
 * Build a NEGATIVE_TEST_MATRIX template with the given table rows injected.
 *
 * The header ("## Minimum Negative Tests per Change Type") and table head
 * are shared across all profiles; only the stack-specific rows differ.
 *
 * @param rows - Stack-specific table rows (e.g. "| Function/Module | ... |")
 */
export function buildNegativeTestMatrix(rows: string): string {
  return `\
## Minimum Negative Tests per Change Type

For every change, the following negative-path tests MUST exist:

| Change Type | MUST Test (negative path) |
|---|---|
${rows}`;
}
