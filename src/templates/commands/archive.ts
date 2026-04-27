export const ARCHIVE_COMMAND = `
---
description: Archive a completed FlowGuard session as a compressed tar.gz file.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Archive the current (or a specified) completed FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
   - If no session exists, report "No session to archive" and stop.

2. Call \`flowguard_archive\` with no arguments.
   - The tool archives the current session if it is in a terminal phase (COMPLETE, ARCH_COMPLETE, or REVIEW_COMPLETE).
   - The archive is stored in the workspace sessions/archive/ directory.

3. Read the response and report:
   - The archive file path.
   - Confirmation that the session data was archived successfully.

## Constraints

- Only terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) can be archived.
- If the session is not in a terminal phase, report the current phase and tell the user to complete or abort the session first.
- DO NOT modify any FlowGuard state.
- DO NOT auto-chain to other FlowGuard commands after archiving.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "archive", "save", "compress", or "backup" are NOT command invocations. Only an explicit \`/archive\` triggers this command. If the user sends free-text implying archiving, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful archive: \`Next action: run /hydrate to start a new session.\`

## Done-when

- Session archive is created as tar.gz file.
- Archive file path is reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
