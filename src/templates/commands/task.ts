import { renderCommandGovernanceRules } from '../mandates.js';

export const TASK_COMMAND = `---
description: FlowGuard — Capture a governed task description with optional external references.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a governed task description for the Ticket flow.

Task description: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify a session exists in READY or TICKET phase.
   - If phase does not allow task capture: report this and stop.

2. Resolve exactly ONE canonical content source; never combine them:
   - **Repository file** (\`--file <path>\` or an explicit single-file task source): call
     \`flowguard_ticket({ ticketSource: { kind: "repository_file", path: "<path>" }, source: "user" })\`
     with NO \`text\`. FlowGuard reads the file itself and binds its content digest.
   - **External reference** (\`--ref\`): extract the referenced content first (webfetch or the
     content the user provided), then pass the COMPLETE extracted content as \`text\` with
     \`inputOrigin: "external_reference"\` and \`references\`. Never pass a bare URL, ticket ID, or
     branch name as \`text\`.
   - **Plain text**: pass the user's complete description as \`text\`.
   If \`$ARGUMENTS\` is empty: ask the user to describe their task (never invent content).

3. Call \`flowguard_ticket\` with exactly one of \`text\` or \`ticketSource\` (both together are
   rejected with \`TICKET_SOURCE_CONFLICT\`).

4. Report the confirmed task, current phase, and next action.

## Rules

- Use exactly what the user provided or the adopted file/extracted content — never fabricate task content.
- A file path or URL is a REFERENCE, not ticket content: adopt repository files via
  \`ticketSource\` and external content via explicit \`text\`; a bare reference is rejected with
  \`TICKET_REFERENCE_WITHOUT_CONTENT\`.
- Only call flowguard_ticket when phase allows it (READY or TICKET).
${renderCommandGovernanceRules()}
## Done-when

- Task recorded via flowguard_ticket.
- Phase and next action reported.
- If \`presentation.markdown\` is present, render it verbatim and do not append a separate \`Next action:\` line.
- Otherwise, render the canonical \`directive\` as the single fallback conclusion.
`;
