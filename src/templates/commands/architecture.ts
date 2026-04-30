export const ARCHITECTURE_COMMAND = `
---
description: Create or revise an Architecture Decision Record (ADR) in MADR format.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create or revise an Architecture Decision Record (ADR) for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists and is in READY or ARCHITECTURE phase.
   - If no session exists, report this and stop.
   - If the session is not in READY or ARCHITECTURE phase, report the current phase and stop.

2. If in READY phase (new ADR):
   - Gather the architecture decision context from the user's request.
   - Generate an ADR in MADR format with these mandatory sections: \`## Context\`, \`## Decision\`, \`## Consequences\`.
   - Call \`flowguard_architecture\` with \`id\` (format: ADR-<number>), \`title\`, and \`adrText\`.

3. If in ARCHITECTURE phase (revision after changes_requested):
   - Read the review feedback from the session state.
   - Revise the ADR based on the feedback.
   - Call \`flowguard_architecture\` with the updated \`id\`, \`title\`, and \`adrText\`.

4. The tool will run the ADR review loop automatically. If it returns in ARCH_REVIEW phase, the ADR is ready for human review.

5. Report the result to the user:
   - Show the ADR title and ID.
   - Show the current phase.
   - Indicate whether human review is needed.

## Constraints

- The ADR MUST include \`## Context\`, \`## Decision\`, and \`## Consequences\` sections.
- The ADR ID MUST match the format \`ADR-<number>\` (e.g., ADR-1, ADR-42).
- DO NOT skip the flowguard_architecture tool call.
- DO NOT ask the user anything. Do not use the \`question\` tool or present selectable choices.
- DO NOT explain what you are about to do. Just call the tool.
- DO NOT auto-chain to /review-decision or any other FlowGuard command after the architecture tool completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "write an ADR", "architecture decision", or "design doc" are NOT command invocations. Only an explicit \`/architecture\` triggers this command.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with a \`Next action:\` line based on the current phase.

## Done-when

- ADR is created or revised with Context, Decision, and Consequences sections.
- ADR review loop has converged.
- Phase has reached ARCH_REVIEW (ready for human review).
- Response ends with a \`Next action:\` line.
`;
