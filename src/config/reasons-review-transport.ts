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
      'Use a host/adapter version that exposes one transport with structured findings, parent-visible execution, navigable transcript, isolated reviewer identity, and permission isolation',
      'Do not bypass the gate with a transport that satisfies only a subset of the required capabilities',
      'Inspect the platform trust report for the exact advertised review transport capabilities',
    ],
  },
  {
    code: 'NATIVE_REVIEW_TASK_REQUIRED',
    category: 'adapter',
    messageTemplate:
      'Independent review must be dispatched through the parent host Task surface so the reviewer child is visible and navigable.',
    recoverySteps: [
      'Invoke the host Task tool with subagent_type flowguard-reviewer from the parent session',
      'Allow FlowGuard to inject the canonical frozen reviewer prompt at the Task before-hook',
      'Use the child session returned by native Task metadata for the schema-constrained structured follow-up',
    ],
  },
];
