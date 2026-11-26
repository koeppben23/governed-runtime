import { renderCommandGovernanceRules } from '../mandates.js';

export const HYDRATE_COMMAND = `---
description: FlowGuard — Reload an already authorized session; does not activate governance.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Reload the existing FlowGuard session for this project. Only explicit \`/start\`
or an authorized \`StartGovernance\` request activates OpenCode governance.

## Steps

1. If governance is not active, recommend explicit \`/start\` and stop. Do not activate governance automatically.
   Otherwise call \`flowguard_hydrate\` with no arguments. If authority is missing, damaged or unavailable,
   report the block and stop; neither hydrate nor a repeated start may recreate that authority.
2. If \`presentation.markdown\` is present, print it verbatim — do not reformat, summarize, or
   append a separate \`Next action:\` line. Its rendered conclusion is authoritative.
3. If \`presentation.markdown\` is NOT present:
   - If the response is blocked or contains an error: report its code, message, and recovery, then stop.
   - Otherwise report the returned session state and render exactly one fallback action from
     \`directive\`.

## Rules

- Only when governance is already active and authority is available, call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /hydrate.
- In an existing terminal session hydrate is a read-only reload, not a restart. For new work use a distinct host-session id and explicit \`/start\`; when recovering implementation evidence, independently prepare a trustworthy pre-change worktree first. Verify the distinct FlowGuard identity and READY phase. Repeating \`/start\` in an ACTIVE session reuses its binding, not a new baseline.
${renderCommandGovernanceRules()}
## Done-when

- Existing authorized FlowGuard session was loaded, or the activation/authority block was reported without creating a session.
- A presentation conclusion was rendered verbatim, or one product-derived fallback action was reported.
`;
