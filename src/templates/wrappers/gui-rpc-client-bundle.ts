/** Typed, host-neutral contract for the optional Desktop GUI RPC projection.
 * The installed GUI is a CommonJS string template. Its runtime bridge below is
 * tested against this contract; types do not confer governance authority.
 */
import type { NextActionResult } from '../../integration/status/next-action-projection.js';
import type { WorkbenchReviewResult } from '../../integration/status/workbench-review-projection.js';
import type { WorkbenchDiagnosticsResult } from '../../integration/status/workbench-diagnostics-projection.js';
import type {
  NextActionDecisionRequest,
  NextActionDecisionResult,
} from '../../integration/opencode-governance-rpc.js';

export interface FlowGuardGuiRpcClient {
  getNextAction(): Promise<NextActionResult>;
  getWorkbenchReview(): Promise<WorkbenchReviewResult>;
  getWorkbenchDiagnostics(): Promise<WorkbenchDiagnosticsResult>;
  /** The host session supplies sessionID; the UI cannot override it. */
  submitDecision(
    decision: Omit<NextActionDecisionRequest, 'sessionID'>,
  ): Promise<NextActionDecisionResult>;
}

/** Only this bridge knows the RPC ID, method names and native client shape. */
export const GUI_RPC_CLIENT_BUNDLE = `
const FLOWGUARD_GUI_RPC_ID = 'flowguard-governance';

function flowguardGuiRpcClient(session) {
  const directory = session.location && session.location.directory;
  const location = directory ? { directory: directory } : undefined;
  const invoke = async (method, input) => {
    const response = await session.server.client.rpc.call({
      rpcID: FLOWGUARD_GUI_RPC_ID,
      method: method,
      location: location,
      input: input,
    });
    return response.output;
  };
  return {
    getNextAction: () => invoke('GetNextAction', { sessionID: session.id }),
    getWorkbenchReview: () => invoke('GetWorkbenchReview', { sessionID: session.id }),
    getWorkbenchDiagnostics: () => invoke('GetWorkbenchDiagnostics', { sessionID: session.id }),
    submitDecision: (decision) => invoke('SubmitDecision', {
      ...decision,
      sessionID: session.id,
    }),
  };
}

function getView(session) {
  return flowguardGuiRpcClient(session).getNextAction();
}
`;
