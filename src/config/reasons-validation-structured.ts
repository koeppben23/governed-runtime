/**
 * @module config/reasons-validation-structured
 * @description Reason codes for host-observed structured reviewer output.
 *
 * Independent review is authorized exclusively by a host-observed structured
 * child-session result. These codes cover capability mismatch, missing host
 * structured output, and contract violations.
 */

import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

export const STRUCTURED_REVIEW_REASONS = [
  {
    code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
    category: 'state',
    messageTemplate:
      'The host/provider rejected the selected reviewer execution mode. Independent review cannot be authorized.',
    recoverySteps: [
      `Correct the explicit ${REVIEWER_SUBAGENT_TYPE} model options using supported OpenCode configuration`,
      'Restart OpenCode after changing agent configuration, then re-run the originating command',
      'Do NOT automatically retry the same rejected configuration or fabricate findings',
    ],
  },
  {
    code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'The isolated reviewer agent or a required agent capability is unavailable. Independent review cannot be authorized.',
    recoverySteps: [
      `Verify the ${REVIEWER_SUBAGENT_TYPE} agent and the provider capability reported by the host`,
      'Re-run the originating FlowGuard command after the model capability is corrected',
      'Do NOT fabricate findings or submit a guessed verdict',
    ],
  },
  {
    code: 'REVIEWER_OUTPUT_CAP_INVALID',
    category: 'config',
    messageTemplate:
      'The configured reviewer output cap cannot be applied to this reviewer model: {reason}',
    recoverySteps: [
      'Set reviewer.outputTokenMax in flowguard.json to at most the model output limit reported in the reason, or select a model that supports the configured cap',
      'Restart OpenCode so the FlowGuard plugin reloads the resolved configuration',
      'Re-run the originating FlowGuard command after correcting the cap; do not re-arm the reviewer with the same invalid configuration',
    ],
  },
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
  {
    code: 'REVIEWER_HOST_MESSAGE_ENCODING_FAILED',
    category: 'state',
    messageTemplate:
      'OpenCode cannot encode persisted formatted messages. Required reviewer history is unavailable.',
    recoverySteps: [
      'Track OpenCode issues #40169 and #26929 and use an official corrected host',
      'Preserve the affected session; FlowGuard does not rewrite or delete its history',
      'Do not claim review approval when required provenance cannot be read',
    ],
  },
] as const satisfies readonly BlockedReason[];
