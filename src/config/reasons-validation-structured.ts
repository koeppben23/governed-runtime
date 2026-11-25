/**
 * @module config/reasons-validation-structured
 * @description Reason codes for host-observed structured reviewer output.
 *
 * Independent review is authorized exclusively by a host-observed structured
 * child-session result. These codes cover missing host structured output,
 * contract violations and invalid capture provenance.
 */

import type { BlockedReason } from './reasons-types.js';

export const STRUCTURED_REVIEW_REASONS = [
  {
    code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    category: 'state',
    messageTemplate:
      'The correlated reviewer message did not contain exactly one complete strict JSON findings object.',
    recoverySteps: [
      'Inspect the JSON contract diagnostic; the normal reviewer prompt does not require host StructuredOutput',
      'Re-run the originating FlowGuard command to authorize a fresh reviewer dispatch',
      'Do NOT extract JSON from arbitrary prose, reconstruct findings, or submit copied findings',
    ],
  },
  {
    code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    category: 'state',
    messageTemplate:
      'The correlated reviewer JSON violates ReviewerFindingsInput. The evidence cannot be accepted.',
    recoverySteps: [
      'Re-run the originating FlowGuard command to authorize a fresh reviewer attempt',
      'Inspect the structured output contract failure before the next attempt',
      'Do NOT accept or repair the reviewer findings outside the host-observed transaction',
    ],
  },
  {
    code: 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
    category: 'state',
    messageTemplate:
      'Reviewer capture lacks exact, successful, tool-free request provenance. No evidence was accepted: {reason}',
    recoverySteps: [
      'Inspect request/response identity, model selection, concurrent messages, and serialization tool violations',
      'Resolve the host execution outcome before issuing a new review command',
      'Do not reuse the rejected message or bypass the capture fence',
    ],
  },
] as const satisfies readonly BlockedReason[];
