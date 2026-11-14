/** Embedded OpenCode Desktop GUI transport adapter.
 * Public TypeScript port: src/integration/gui-rpc-client-contract.ts.
 * No reverse dependency from templates to integration.
 */
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
    getPresentation: (after) => invoke('GetPresentation', {
      sessionID: session.id,
      ...(after ? { after: after } : {}),
    }),
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
