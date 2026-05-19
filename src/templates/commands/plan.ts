 

import { GOVERNANCE_RULES } from './shared-rules.js';
import { SHARED_REVIEW_LOOP } from './shared-review-loop.js';

export const PLAN_COMMAND = `
---
description: Generate a plan with mandatory independent subagent review for the current task.
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Generate a comprehensive implementation plan for the current ticket, then obtain mandatory independent review.

## Steps

### Phase 1: Check State

1. Call \`flowguard_status\` to verify a session exists with a ticket in TICKET or PLAN phase.
   - If no session: call \`flowguard_hydrate\` first.
   - If no ticket: tell the user to run /ticket first and stop.
   - If phase does not allow /plan: report the current phase and stop.

### Phase 2: Generate Plan

2. Read the ticket text from the status response.
3. Write a detailed implementation plan in markdown with these 7 required sections:
   - \`## Objective\` — 1-3 sentences: what is being built and why.
   - \`## Approach\` — Technical strategy with specific patterns, libraries, or architecture decisions.
   - \`## Steps\` — Numbered list. Each step names at least one specific file path AND describes the concrete change.
   - \`## Files to Modify\` — Complete list of file paths to create, modify, or delete.
   - \`## Edge Cases\` — Numbered list: scenario + handling strategy.
   - \`## Validation Criteria\` — Numbered list of verifiable conditions.
   - \`## Verification Plan\` — Numbered list citing the command AND its Source (e.g., "Source: package.json:scripts.test"). State "NOT_VERIFIED" with recovery steps if no repo-native candidate is available.
4. Call \`flowguard_plan({ planText })\` with only planText set to the full plan markdown.
5. Read the response. The \`next\` field contains the review workflow instructions.

### Phase 3: Review Loop

6. Follow the \`next\` field instructions exactly:
${SHARED_REVIEW_LOOP({
  toolName: 'flowguard_plan',
  artifactName: 'plan',
  reviseParams: 'planText: <revised>',
  changesRequestedExtra: '',
  strictRecoveryCall: 'flowguard_plan({ planText: <same plan text> })',
  strictRecoveryVerb: 'Re-submit',
  strictRecoveryNoun: 're-submissions',
  iterationNote: '(max 3 iterations)',
  repeatStep: 6,
  subagentExtra: '',
  fallbackExtra: ', or infrastructure missing',
  unableDescription:
    'e.g., contradictory inputs, missing prerequisites, or scope ambiguity that prevents critique',
  unableRecoveryA: '/ticket the prerequisite work first',
  unableRecoveryB:
    'revise the plan substantially (new flowguard_plan({ planText }) submission, which starts a fresh review obligation)',
})}

## Rules

- Every plan step names a specific file path and concrete change (never "implement the feature").
- Always complete the independent review before proceeding (use plugin findings or the reviewer subagent).
- When revising a plan, include the COMPLETE plan text (not a diff).
- Cite Source for each verification check, or state NOT_VERIFIED with recovery steps.
- Use \`verificationCandidates\` from \`flowguard_status\` when available to populate the Verification Plan (prefer repo-native commands over generic ones).
- Follow profile rules from \`flowguard_status\` when writing the plan (they supplement governance mandates).
- Do not call implementation tools (write/edit/bash) during /plan — this command produces a plan only.
- Do not substitute self-review for independent review when subagent review is active.
- Do not auto-chain into /implement after plan approval — stop and let the user decide.

## Example (correct tool sequences)

Happy path:
1. \`flowguard_status\` → phase: TICKET, ticket present
2. \`flowguard_plan({ planText })\` → returns \`next: "INDEPENDENT_REVIEW_COMPLETED: ..."\`
3. \`flowguard_plan({ reviewVerdict: "approve" })\` → PLAN_REVIEW

Revision path (when review returns changes_requested):
1. \`flowguard_plan({ reviewVerdict: "changes_requested", planText: <revised> })\`
2. → new review starts, returns \`next: "INDEPENDENT_REVIEW_COMPLETED: ..."\`
3. \`flowguard_plan({ reviewVerdict: "approve" })\` → PLAN_REVIEW

${GOVERNANCE_RULES}
## Presentation

- If the response contains a \`reviewCard\` field, display its markdown verbatim — never summarize, truncate, or omit it.
- The reviewCard contains the formatted plan review with findings, verdict, and next actions.
- This is mandatory output: the user relies on it to make their review decision.

## Done-when

- Plan contains all 7 required sections.
- Verification Plan cites Source for each check OR states NOT_VERIFIED.
- Independent review loop has converged (approved or max 3 iterations).
- If \`reviewCard\` is present in the tool response, it is displayed verbatim in the output.
- Phase has advanced to PLAN_REVIEW.
- Response ends with \`Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.\`
`;
