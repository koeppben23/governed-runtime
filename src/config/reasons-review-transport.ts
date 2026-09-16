/**
 * Reason codes for independent-review transport capability failures.
 *
 * These are separate from reviewer verdicts: an unavailable host transport is
 * an infrastructure/capability failure and must never be represented as a
 * reviewer-authored unable_to_review verdict.
 *
 * @internal — use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const REVIEW_TRANSPORT_REASONS: readonly BlockedReason[] = [
  {
    code: 'VISIBLE_REVIEW_TRANSPORT_UNAVAILABLE',
    category: 'adapter',
    messageTemplate:
      'No single host review transport satisfies FlowGuard independent-review requirements for structured output and parent-visible execution.',
    recoverySteps: [
      'Use a host/adapter version that exposes one transport with both structured findings and parent-visible reviewer execution',
      'Do not bypass this gate with an invisible SDK reviewer or an unstructured native Task reviewer',
      'Inspect the platform trust report for the exact advertised review transport capabilities',
    ],
  },
];
