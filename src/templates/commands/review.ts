export const REVIEW_COMMAND = `
---
description: Start the standalone compliance review flow (READY → REVIEW → REVIEW_COMPLETE).
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Start the compliance review flow for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists and is in the READY phase.
   - If no session exists, report this and stop.
   - If the session is not in READY phase, report the current phase and stop.

2. Call \`flowguard_review\` with no arguments.
   - The tool transitions the session from READY → REVIEW → REVIEW_COMPLETE and generates a compliance report.

3. Read the response and present the report to the user:
   - **Overall status**: clean, warnings, or issues.
   - **Findings**: List each finding with severity (info/warning/error), category, and message.
   - **Validation summary**: Show which checks passed or failed.
   - **Current phase**: Should be REVIEW_COMPLETE.

4. If there are warnings or issues, explain what actions could address them.

## Verification Review Check

When reviewing implementation evidence or plan verification, check:

- Were verificationCandidates from flowguard_status used when available?
- Were generic commands (e.g., "npm test") suggested despite more specific repo-native candidates existing?
- Were executed checks clearly distinguished from planned checks?
- Are unexecuted checks marked as NOT_VERIFIED?

If generic commands are used when specific candidates exist, flag this as a defect in the report.

## Constraints

- This command starts a standalone flow. It transitions the session through READY → REVIEW → REVIEW_COMPLETE.
- This command is only available in the READY phase.
- DO NOT modify any FlowGuard state or files other than the report.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- DO NOT auto-chain to any other FlowGuard command after generating the report.
- Present the report clearly and concisely.
- Natural-language prompts like "review it", "check the status", "how does it look", or "is it ready" are NOT command invocations. Only an explicit \`/review\` triggers this command. If the user sends free-text implying a review, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with a \`Next action:\` line based on the current phase and report findings.

## Done-when

- Compliance report is generated and presented to the user.
- Verification review checked for repo-native candidates vs generic command mismatches.
- Findings and actionable recommendations are shown.
- Phase has reached REVIEW_COMPLETE.
- Response ends with a \`Next action:\` line.
`;
