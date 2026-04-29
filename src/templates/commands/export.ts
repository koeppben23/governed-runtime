export const EXPORT_COMMAND = `
---
description: Export a verifiable audit package for the completed session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create a verifiable audit package for the current session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.

2. Call \`flowguard_archive\` with no arguments. The tool creates the audit package and runs integrity verification.

3. Read the returned JSON and report:
   - The archive status (created, verified, or failed).
   - The archive location and integrity verification result.
   - The next action.

## Constraints

- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after the archive is created.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful export: \`Next action: run /start to begin a new governed session.\`

## Done-when

- Audit package is created via flowguard_archive.
- Archive verification result and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
