export const ABORT_COMMAND = `
---
description: Emergency termination of the FlowGuard session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Abort the FlowGuard session.

Reason: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify a session exists.
   - If no session exists, report "No session to abort" and stop.
   - If the session is already COMPLETE, report it is already terminal and stop.

2. Confirm with the user:
   - Report the current phase and any work that will be preserved (all evidence remains in state).
   - The session will be marked as ABORTED at COMPLETE phase.
   - This is irreversible — a new session must be started with /hydrate.

3. Call \`flowguard_abort_session\` with:
   - \`reason\`: The reason from \`$ARGUMENTS\`, or "Session aborted by user" if no reason was provided.

4. Report the result: confirm the session has been terminated and that /hydrate can start a new one.

## Constraints

- DO NOT abort without informing the user of the consequences.
- If no reason is provided in $ARGUMENTS, use "Session aborted by user" as the default reason.
- After aborting, DO NOT attempt any further FlowGuard workflow actions. The session is terminal.
- DO NOT auto-chain to /hydrate or any other FlowGuard command after abort completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "stop", "cancel", "nevermind", or "forget it" are NOT command invocations. Only an explicit \`/abort\` triggers this command. If the user sends free-text implying cancellation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful abort: \`Next action: run /hydrate to start a new session, or /review to inspect the aborted session.\`

## Done-when

- User is informed of consequences before abort.
- Session is terminated via flowguard_abort_session.
- Session is marked COMPLETE with ABORTED error.
- Response ends with exactly one \`Next action:\` line.
`;
