import { GOVERNANCE_RULES } from './shared-rules.js';

export const IMPLEMENT_COMMAND = `
---
description: Implement the approved plan and review the implementation.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Implement the approved plan and obtain mandatory independent implementation review.

## Steps

### Phase 1: Check State

1. Call \`flowguard_status\` to verify the session is in IMPLEMENTATION phase with a ticket, approved plan, and passed validation.
   - If any precondition is not met: report it and stop.

### Phase 2: Implement

2. Read the plan from the status response. Identify the numbered steps and files to modify.
3. Execute each step in order:
   - Use \`read\` to examine existing files before modifying.
   - Use \`write\` or \`edit\` to create or modify files.
   - Use \`bash\` for commands (install dependencies, run formatters, etc.).
   - Follow the plan steps exactly — add nothing beyond what the plan specifies.
4. After completing ALL plan steps, call \`flowguard_implement({})\` with no arguments.
   - The tool auto-detects changed files via git and records evidence.

### Phase 3: Record Verification Evidence

5. Write a \`## Verification Evidence\` section distinguishing:
   - **Planned checks**: Each check from the plan's Verification Plan.
   - **Executed checks**: Only checks actually run. Mark unexecuted checks as NOT_VERIFIED.

### Phase 4: Implementation Review Loop

6. Read the \`next\` field from the tool response and follow its instructions exactly:
   - When \`next\` starts with "INDEPENDENT_REVIEW_COMPLETED": Read \`overallVerdict\` from \`pluginReviewFindings\` in the response. Pass the entire \`pluginReviewFindings\` object as \`reviewFindings\`:
     - "approve": Call \`flowguard_implement({ reviewVerdict: "approve", reviewFindings: <pluginReviewFindings> })\`.
     - "changes_requested": Call \`flowguard_implement({ reviewVerdict: "changes_requested", reviewFindings: <pluginReviewFindings> })\`, then make the code changes, then call \`flowguard_implement({})\` again to re-record.
   - When \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED": Call the flowguard-reviewer subagent, then submit verdict with reviewFindings.
   - If review converged: Report the final status.
   - If another iteration is needed: Repeat from step 6 (max 3 iterations).

## Rules

- Follow the approved plan exactly — no deviations or additions.
- Always record evidence (Mode A, no reviewVerdict) before submitting review verdict (Mode B, with reviewVerdict).
- Always complete the independent review (plugin findings or reviewer subagent).
- When changes are requested: make the actual code changes, then re-record with flowguard_implement({}).
- In Verification Evidence, list only checks that were actually executed. Mark all others as NOT_VERIFIED.
- Follow profile rules from \`flowguard_status\` when implementing.
- Do not call flowguard_plan during /implement — planning is complete.
- Do not auto-chain into /review-decision after implementation — the user decides.

## Example (correct tool sequences)

Happy path:
1. \`flowguard_status\` → phase: IMPLEMENTATION, plan approved
2. (execute plan steps: read/write/edit/bash)
3. \`flowguard_implement({})\` → records evidence, returns \`next: "INDEPENDENT_REVIEW_COMPLETED: ..."\`
4. \`flowguard_implement({ reviewVerdict: "approve", reviewFindings: <pluginReviewFindings> })\` → EVIDENCE_REVIEW

Revision path (when review returns changes_requested):
1. \`flowguard_implement({ reviewVerdict: "changes_requested", reviewFindings: <pluginReviewFindings> })\`
2. (fix code based on blockingIssues)
3. \`flowguard_implement({})\` → re-records evidence, new review starts
4. \`flowguard_implement({ reviewVerdict: "approve", reviewFindings: <new pluginReviewFindings> })\` → EVIDENCE_REVIEW

${GOVERNANCE_RULES}
## Done-when

- All plan steps are implemented as code changes.
- Verification Evidence distinguishes Planned from Executed checks.
- Implementation evidence is recorded via flowguard_implement.
- Independent review loop has converged.
- Phase has advanced to EVIDENCE_REVIEW.
- Response ends with \`Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.\`
`;
