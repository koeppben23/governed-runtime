import { GOVERNANCE_RULES } from './shared-rules.js';

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
   - If no session: call \`flowguard_hydrate\` first.
   - If phase is not READY or TICKET: report that /ticket is only allowed in READY or TICKET phase.

2. **External Reference Resolution** (URLs, ticket IDs, issue links):
   If the user provides a URL (Jira, ADOS, GitHub Issue, Confluence, Figma, etc.) or ticket ID:
   - Extract the ticket title and description using the \`webfetch\` agent tool (you extract, then pass text to FlowGuard — FlowGuard itself never fetches URLs).
   - Build \`references\` array with \`ExternalReference\` objects:
     - \`ref\`: original URL or ticket ID
     - \`type\`: \`ticket\` | \`issue\` | \`doc\` | \`url\` (inferred from source)
     - \`title\`: extracted title
     - \`source\`: platform name (jira, ados, github, gitlab, confluence, figma)
     - \`extractedAt\`: ISO timestamp (only when content was actually extracted)
   - Set \`inputOrigin\` based on scenario:
     | Scenario | source | inputOrigin |
     |----------|--------|-------------|
     | User typed text, no URL | \`"user"\` | \`"manual_text"\` |
     | Extracted from Jira/ADO/GitHub | \`"external"\` | \`"external_reference"\` |
     | User text AND URL | \`"external"\` | \`"mixed"\` |
     | Extraction failed | \`"external"\` | \`"external_reference"\` |
   - On extraction failure: use placeholder text, still add reference (without \`extractedAt\`).

3. Call \`flowguard_ticket\` with:
   - \`text\`: Ticket description (extracted or user-provided). If \`$ARGUMENTS\` is empty, ask the user for a description first.
   - \`source\` and \`inputOrigin\` per the table above.
   - \`references\` (optional): Array of ExternalReference objects.

4. Report: confirm ticket recorded, show current phase and next action.

## Rules

- Use exactly what the user provided or what was extracted — never invent ticket text.
- Preserve original URLs/references — never lose the source.
- If no arguments provided: ask the user for their task description before proceeding.
${GOVERNANCE_RULES}
## Done-when

- Ticket text recorded via flowguard_ticket.
- External references captured with full audit provenance.
- Response ends with \`Next action: run /plan to generate an implementation plan.\`
`;
