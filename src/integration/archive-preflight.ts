/**
 * @module integration/archive-preflight
 * @description Read-only state preflight shared by archive execution and projections.
 */

import type { SessionState } from '../state/schema.js';
import { TERMINAL } from '../machine/topology.js';

export type CommandPreflightReason =
  | 'SESSION_REQUIRED'
  | 'TERMINAL_PHASE_REQUIRED'
  | 'ABORTED_SESSION'
  | 'WORKFLOW_COMMAND_NOT_ALLOWED'
  | 'CONTINUE_AMBIGUOUS'
  | 'NOT_APPLICABLE_TO_ACTIVE_FLOW';

export type CommandPreflight =
  | Readonly<{ status: 'available'; guarantee: 'eligible_to_attempt' | 'read_only_available' }>
  | Readonly<{
      status: 'blocked' | 'not_applicable';
      guarantee: 'eligible_to_attempt';
      reasonCode: CommandPreflightReason;
      message: string;
      recovery: string;
    }>;

/**
 * State-only archive eligibility. It deliberately does not promise archive I/O,
 * integrity verification, or host capability success.
 */
export function evaluateArchivePreflight(state: SessionState | null): CommandPreflight {
  if (!state) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'SESSION_REQUIRED',
      message: 'An audit package requires a FlowGuard session.',
      recovery: 'Run /hydrate to initialize a session.',
    };
  }
  if (!TERMINAL.has(state.phase)) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'TERMINAL_PHASE_REQUIRED',
      message: 'An audit package can be created after the workflow completes.',
      recovery: 'Complete the workflow, then run /export.',
    };
  }
  if (state.error?.code === 'ABORTED') {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'ABORTED_SESSION',
      message: 'An aborted session is not exportable as a verifiable audit package.',
      recovery: 'Inspect the preserved session with /status.',
    };
  }
  return { status: 'available', guarantee: 'eligible_to_attempt' };
}
