export const REVIEW_DECISION_COMMAND = `
---
description: Submit a human review decision (approve, changes_requested, reject) at a User Gate.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a human review decision for the current User Gate.

Decision: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify:
   - A session exists.
   - The current phase is PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW (a User Gate).
   - If the phase is NOT a User Gate, report this to the user and stop.

2. Parse the decision from \`$ARGUMENTS\`:
   - Expected format: one of \`approve\`, \`changes_requested\`, \`reject\`
   - Optionally followed by a rationale (e.g., \`approve looks good\` or \`changes_requested missing error handling\`)
   - The first word is the verdict. Everything after is the rationale.
   - If \`$ARGUMENTS\` is empty or unclear, ask the user for their decision. DO NOT guess.

3. Call \`flowguard_decision\` with:
   - \`verdict\`: The parsed verdict (exactly one of: "approve", "changes_requested", "reject")
   - \`rationale\`: The parsed rationale, or empty string if none provided.

4. Read the returned JSON and report:
   - **approve**: Confirm advancement and show the new phase.
   - **changes_requested**: Explain that the workflow returns to the revision phase. State what needs to happen next.
    - **reject**: Explain that the workflow returns to the revision start. At PLAN_REVIEW or EVIDENCE_REVIEW, reject returns to TICKET and clears plan/implementation evidence. At ARCH_REVIEW, reject returns to READY and clears ADR evidence.

## Constraints

- DO NOT fabricate a verdict. Use exactly what the user provided.
- If the arguments are ambiguous (e.g., "maybe" or "not sure"), ask the user to clarify.
- DO NOT call this tool if the current phase is not PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW.
- Valid verdicts are ONLY: approve, changes_requested, reject. Nothing else.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after the decision is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "approve", "go", "weiter", "looks good", "ship it", or "reject" sent WITHOUT the /review-decision prefix are NOT command invocations. Only an explicit \`/review-decision\` triggers this command. If the user sends free-text implying a decision, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line stating the next workflow step based on the verdict and phase.

## Done-when

- User verdict (approve, changes_requested, or reject) is recorded via flowguard_decision.
- Phase transition is reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
