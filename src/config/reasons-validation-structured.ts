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
      'The reviewer execution mode conflicts with the host-required structured-output transport. Independent review cannot be authorized.',
    recoverySteps: [
      `Configure the ${REVIEWER_SUBAGENT_TYPE} agent with reasoningEffort: none for OpenCode structured review`,
      'Re-run the originating FlowGuard command after the compatible execution mode is installed',
      'Do NOT retry the same thinking-mode request or fabricate findings',
    ],
  },
  {
    code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'The configured reviewer model does not support required structured output. Independent review cannot be authorized.',
    recoverySteps: [
      `Configure the ${REVIEWER_SUBAGENT_TYPE} agent to use a structured-output-capable model`,
      'Re-run the originating FlowGuard command after the model capability is corrected',
      'Do NOT fabricate findings or submit a guessed verdict',
    ],
  },
  {
    code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    category: 'state',
    messageTemplate:
      'The host did not deliver required structured output for the reviewer child session. Only the host-observed structured result can authorize the review.',
    recoverySteps: [
      'Ensure the host supports session.prompt with format: json_schema for the reviewer child session',
      'Re-run the originating FlowGuard command to authorize a fresh reviewer dispatch',
      'Do NOT reconstruct reviewer findings from text output or submit copied findings',
    ],
  },
  {
    code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    category: 'state',
    messageTemplate:
      'The host structured output for the reviewer child session violates the reviewer findings contract. The evidence cannot be accepted.',
    recoverySteps: [
      'Re-run the originating FlowGuard command to authorize a fresh reviewer attempt',
      'Inspect the structured output contract failure before the next attempt',
      'Do NOT accept or repair the reviewer findings outside the host-observed transaction',
    ],
  },
] as const satisfies readonly BlockedReason[];
