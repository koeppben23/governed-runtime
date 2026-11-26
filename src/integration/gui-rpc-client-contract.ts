/** Canonically typed GUI client port. The OpenCode Desktop template supplies
 * the runtime transport adapter; governance remains server-authoritative.
 */
import type { NextActionResult } from './status/next-action-projection.js';
import type { WorkbenchReviewResult } from './status/workbench-review-projection.js';
import type { WorkbenchDiagnosticsResult } from './status/workbench-diagnostics-projection.js';
import type {
  NextActionDecisionRequest,
  NextActionDecisionResult,
  PresentationResult,
} from './opencode-governance-rpc.js';

export interface FlowGuardGuiRpcClient {
  getNextAction(): Promise<NextActionResult>;
  getWorkbenchReview(): Promise<WorkbenchReviewResult>;
  getWorkbenchDiagnostics(): Promise<WorkbenchDiagnosticsResult>;
  /** Ephemeral, non-authoritative presentation page for one session. */
  getPresentation(after?: string): Promise<PresentationResult>;
  /** The host session supplies sessionID; the UI cannot override it. */
  submitDecision(
    decision: Omit<NextActionDecisionRequest, 'sessionID'>,
  ): Promise<NextActionDecisionResult>;
}
