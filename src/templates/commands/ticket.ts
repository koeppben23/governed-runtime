export const TICKET_COMMAND = `
---
description: Record a task or ticket for the FlowGuard session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record the following task/ticket in the FlowGuard session:

$ARGUMENTS

## Steps

1. Call \`flowguard_status\` to check the current phase.
   - If no session exists, call \`flowguard_hydrate\` first.
   - If the phase is not READY or TICKET, report that /ticket is only allowed in READY or TICKET phase.

2. **External Reference Resolution (URLs, ticket IDs, issue links)**:
   If the user provides a URL (Jira, ADOS, GitHub Issue, Confluence, Figma, etc.) or ticket ID:
   - Use \`webfetch\` to extract the ticket title and description from the URL.
   - If extraction succeeds:
     - Build \`references\` array with \`ExternalReference\` objects:
       - \`ref\`: the original URL or ticket ID
       - \`type\`: infer type — \`ticket\` for Jira/ADOS, \`issue\` for GitHub/GitLab issues, \`doc\` for Confluence/Google Docs, \`url\` for generic
       - \`title\`: extracted ticket/spec title
       - \`source\`: platform name (jira, ados, github, gitlab, confluence, figma, etc.)
       - \`extractedAt\`: ISO timestamp (only when content was actually extracted)
     - Set \`inputOrigin\` to \`"external_reference"\`.
   - If extraction fails or \`webfetch\` is unavailable:
     - Set \`text\` to a clear placeholder: \`"Content could not be extracted from: <URL>"\`
     - Still add the \`ExternalReference\` with \`ref\`, \`type\`, and \`source\` — but do NOT set \`extractedAt\` (content was not actually extracted).
     - Set \`inputOrigin\` to \`"external_reference"\`.
   - If the user provides BOTH manual text AND a URL:
     - Use the manual text as \`text\`, add URLs as \`references\`.
     - Set \`inputOrigin\` to \`"mixed"\`.
   - If the user provides only text (no URL/ticket ID):
     - Set \`inputOrigin\` to \`"manual_text"\`.
     - Do not include \`references\` (or omit it).

3. Call \`flowguard_ticket\` with:
   - \`text\`: The ticket description (extracted or user-provided). If \`$ARGUMENTS\` is empty, ask the user to provide a task description.
   - \`source\` and \`inputOrigin\` must be set consistently:
     | Scenario | source | inputOrigin |
     |----------|--------|-------------|
     | User typed text manually, no URL | \`"user"\` | \`"manual_text"\` |
     | Text extracted from Jira/ADO/GitHub | \`"external"\` | \`"external_reference"\` |
     | User typed text AND provided URL | \`"external"\` | \`"mixed"\` |
     | Extraction attempted but failed | \`"external"\` | \`"external_reference"\` |
   - \`references\`: Array of \`ExternalReference\` objects as described above (omit if no references).

4. Read the returned JSON.

5. Report the result to the user: confirm the ticket was recorded, show the current phase, and the next action.

## Constraints

- DO NOT invent or modify the ticket text. Use exactly what the user provided, or what was extracted from the URL.
- If no arguments were provided, ask the user for the task description. DO NOT proceed without it.
- DO NOT call flowguard_plan or any other workflow-advancing tool.
- DO NOT use the \`question\` tool or present selectable choices (except to ask for missing ticket text via plain text).
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /plan, /continue, /review, or /review-decision after the ticket is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "go", "weiter", "proceed", "start working", or task descriptions sent without the /ticket prefix are NOT command invocations. Only an explicit \`/ticket\` triggers this command. If the user sends free-text describing a task, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.

## ExternalReference Format

Each reference in the \`references\` array has:
- \`ref\` (required): URL, ticket ID, or reference string
- \`type\` (optional): \`ticket\` | \`issue\` | \`pr\` | \`branch\` | \`commit\` | \`url\` | \`doc\` | \`other\`
- \`title\` (optional): Human-readable title extracted from the reference
- \`source\` (optional): Platform identifier (jira, ados, github, gitlab, confluence, figma, etc.)
- \`extractedAt\` (optional): ISO timestamp — ONLY set if content was actually extracted. Leave unset if extraction failed.

## Done-when

- Ticket text is recorded in FlowGuard session via flowguard_ticket.
- External references are captured with full audit provenance.
- Current phase and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line. After successful ticket: \`Next action: run /plan to generate an implementation plan.\`
`;
