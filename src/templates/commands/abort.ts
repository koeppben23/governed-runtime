import { GOVERNANCE_RULES } from './shared-rules.js';

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
   - If no session: report "No session to abort" and stop.
   - If already COMPLETE: report it is already terminal and stop.

2. Inform the user of consequences:
   - Report current phase and that all evidence remains preserved in state.
   - The session will be marked ABORTED at COMPLETE phase.
   - This is irreversible — a new session requires /hydrate.

3. Call \`flowguard_abort_session({ reason })\` using \`$ARGUMENTS\`, or "Session aborted by user" if none provided.

4. Confirm termination and that /hydrate can start a new session.

## Rules

- Always inform the user of consequences before aborting.
- After abort: the session is terminal — no further workflow actions apply.
${GOVERNANCE_RULES}
## Done-when

- User informed of consequences.
- Session terminated via flowguard_abort_session.
- Response ends with \`Next action: run /hydrate to start a new session, or /review to inspect the aborted session.\`
`;
