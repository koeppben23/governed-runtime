import { GOVERNANCE_RULES } from './shared-rules.js';
import {
  SHARED_REVIEW_LOOP,
  DISCOVERY_REVIEW_CAPTURE,
  DISCOVERY_REVIEW_DONE_WHEN,
} from './shared-review-loop.js';

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
${DISCOVERY_REVIEW_CAPTURE}

### Phase 2: Generate Plan

2. Use the ticket already provided in this session as the source of truth for the task. (The ticket
   text is NOT included in the flowguard_status response — status only confirms \`hasTicket\` and
   the phase. If the ticket text is no longer available in this conversation context, run
   \`/help\` first to verify the session state and artifact digest, then call
   \`flowguard_help({ view: "context", includeArtifactContent: true })\` to retrieve the complete
   canonical ticket content. Use ONLY the returned content — do not reconstruct or infer task
   details from metadata alone.)
3. Write a detailed implementation plan in markdown using this structure:

   \`# Implementation Plan\` — The single top-level heading of the plan body. Use
   exactly one \`#\`; all other sections use \`##\` or deeper. When the plan is
   embedded in the Plan Review Card, FlowGuard automatically demotes these
   headings so they nest under the card — do not add extra \`#\` headings to
   compensate.

   \`> **Objective:** ... | **Scope:** ... | **Risk:** Low/Medium/High | **Version:** N\`
   — Single metadata line (blockquote). **Objective:** is 1-3 concise sentences
   stating what is being built and why. \`Version\` starts at 1 for the first
   submission. For revisions, increment the previously presented plan version
   by exactly 1. Do not derive version from unrelated artifact metadata.

   \`## Approach\` — 3-5 concise bullet points, each describing one architectural
   decision with its rationale or tradeoff. Keep the section compact.

   \`## Implementation\` — Each step as \`### N. Step Name\`. Every step includes:
    - \`**Files:**\` — comma-separated explicit repository-relative file paths.
      Do not use directories, glob patterns, ellipses, or categories as
      substitutes for file paths.
    - \`**Changes:**\` — concrete description of what changes.
    - \`**Edge cases:**\` — step-specific edge case handling.
    - \`**Validation:**\` — verifiable condition for this step.

    Prefer vertical tracer-bullet steps: each step should form a thin,
    end-to-end path through the affected layers and be independently verifiable.
    Avoid horizontal steps that build an entire layer without an executable or
    reviewable outcome. When a step introduces a module, prefer a deep module
    (small interface, substantial encapsulated implementation) over a shallow
    pass-through.

   \`## Change Inventory\` — Markdown table listing every affected file with
   an explicit repository-relative path:
   | Area | Files | Change |
   |---|---|---|
   The \`Change\` cell must begin with one of \`CREATE\`, \`MODIFY\`, \`DELETE\`,
   or \`RENAME\`. The union of all per-step \`**Files:**\` entries must match
   the files listed here. A table row may list multiple comma-separated
   explicit paths.

   \`## Acceptance Criteria\` — Checklist (\`- [ ]\`) of observable product or
   repository outcomes. Do not duplicate verification commands here — those
   belong in \`## Verification\`.

   \`## Verification\` — Numbered list citing the command AND its Source
   (e.g., \`Source: package.json#scripts.test\`). State \`NOT_VERIFIED\` with
   recovery steps if no repo-native candidate is available.
4. Derive the structured claim declarations for this plan version. Each claim names
   ONE falsifiable behavioral statement, the plan section that governs it, and the
   check expected to establish it after implementation:
   - \`claimId\`: fresh UUID.
   - \`statement\`: the behavior or forbidden state asserted.
   - \`critical\`: true when the change is unsafe to approve without this claim.
   - \`authoritySectionId\`: the governing \`## Implementation\` step or section.
   - \`expectedCheckId\`: the check kind that must pass (from \`activeChecks\` /
     \`verificationCandidates\`, e.g. \`build\`).
    - \`counterexampleRequirement\`: required for critical claims.
      Example: \`{ checkId: "test", assertion: { providerId: "junit", localId: "com.example.SecurityTest#verifyNoXss" } }\`.
      REQUIRED whenever \`critical\` is true — a critical claim without it can never
      become PROVEN and is rejected at submission. \`checkId\` MAY match
      \`expectedCheckId\`. Choose a counterexample check whose current verification
      candidate is structurally capable of producing and binding the required
      AssertionIdentity. Check-ID diversity is not an independence requirement.
      \`assertion.providerId\` and \`assertion.localId\` identify the specific test assertion
   Declare at least one claim per critical behavioral change. Do NOT invent claims
   that the plan does not actually assert.
5. Call \`flowguard_plan({ planText, claims })\` with the full plan markdown and the
   declarations from step 4.
6. Read the response. The \`next\` field contains the review workflow instructions.

Payload contract for \`flowguard_plan\`:
- Initial submission: the FIRST call MUST be \`flowguard_plan({ planText, claims })\`. NEVER include \`reviewVerdict\`, \`reviewFindings\`, or \`reviewerUnavailable\` in the first call — a prefilled verdict is a fabrication-of-convergence attempt and is rejected (the tool routes a verdict-bearing first call back to \`INDEPENDENT_REVIEW_REQUIRED\`).
- Claims are pre-evidence declarations, not proof. They are bound into the plan approval certificate and materialized as ProofGraph fact claims after implementation; a declaration without its expected check remains unproven and is reported as a coverage gap.
- Record the reviewer verdict after review: host_task_required mode calls \`flowguard_plan({ reviewVerdict })\` (verdict only — the plugin resolves the reviewer findings from captured evidence; do NOT submit or alter \`reviewFindings\`, not even an empty placeholder object); SDK/manual-attested modes also include the reviewer's exact \`reviewFindings\`. \`reviewVerdict: "accept"\` is the reviewer's acceptance, NOT user approval.
- Revision after review: host_task_required mode calls \`flowguard_plan({ reviewVerdict: "changes_requested", planText: <complete revised plan>, claims: <complete revised claims> })\`; SDK/manual-attested modes also include the exact reviewer output as \`reviewFindings\`.
- Never submit placeholder, diagnostic, or manually fabricated \`reviewFindings\`.
- Set \`reviewerUnavailable: true\` only after an actual Task/subagent spawn failure; never set it preemptively.
- After every FlowGuard call, stop and interpret \`phase\`, \`next\`, \`reviewInvocation\`, and any error code before constructing the next payload.

### Phase 3: Review Loop

7. Follow the \`next\` field instructions exactly:
${SHARED_REVIEW_LOOP({
  toolName: 'flowguard_plan',
  artifactName: 'plan',
  reviseParams: 'planText: <revised>, claims: <revised>',
  changesRequestedExtra: '',
  strictRecoveryCall: 'flowguard_plan({ planText: <same plan text>, claims: <same claims> })',
  strictRecoveryVerb: 'Re-submit',
  strictRecoveryNoun: 're-submissions',
  iterationNote: '(max 3 iterations)',
  repeatStep: 7,
  subagentExtra: '',
  fallbackExtra: ', or infrastructure missing',
  unableDescription:
    'e.g., contradictory inputs, missing prerequisites, or scope ambiguity that prevents critique',
  unableRecoveryA: '/ticket the prerequisite work first',
  unableRecoveryB:
    'revise the plan substantially (new flowguard_plan({ planText, claims }) submission, which starts a fresh review obligation)',
})}

## Planning discipline

- Resolve open questions that the repository can answer by exploring the codebase (use the explore agent or read/search tools) instead of asking the user. Reserve user questions for genuine product or intent decisions that the code cannot settle.
- Stress-test domain relationships and edge behavior with concrete scenarios before writing each step's \`**Edge cases:**\` field; a scenario that the plan cannot answer is a gap to resolve, not a detail to defer.
- Cross-check stated behavior against the actual code. When a claim in the request contradicts what the code does, surface the contradiction in the plan rather than planning on top of the unverified claim.

## Rules

- Every plan step names a specific file path and concrete change (never "implement the feature").
- Declare structured \`claims\` on every plan submission and revision; a plan that asserts critical behavior without a claim leaves the ProofGraph contract empty.
- Never declare a claim the plan does not assert, and never name a check that is not active in this session.
- A critical claim blocks the final evidence approval while its declared evidence is missing, stale, or contradicted. Declare \`critical: true\` only for behavior that genuinely must hold, and always with a structurally bindable counterexample check.
- Always complete the independent review before proceeding (use plugin findings or the reviewer subagent).
- When revising a plan, include the COMPLETE plan text (not a diff).
- Cite Source for each verification check, or state NOT_VERIFIED with recovery steps.
- Use \`verificationCandidates\` from \`flowguard_status\` when available to populate the \`## Verification\` section (prefer repo-native commands over generic ones).
- Follow profile rules from \`flowguard_status\` when writing the plan (they supplement governance mandates).
- Do not call implementation tools (write/edit/bash) during /plan — this command produces a plan only.
- Do not substitute self-review for independent review when subagent review is active.
- Do not auto-chain into /implement after plan approval — stop and let the user decide.

## Example (correct tool sequences)

Happy path:
1. \`flowguard_status\` → phase: TICKET, ticket present
2. \`flowguard_plan({ planText, claims })\` → returns \`next: "INDEPENDENT_REVIEW_COMPLETED: ..."\`
3. \`flowguard_plan({ reviewVerdict: "accept" })\` → PLAN_REVIEW (user gate — the USER approves via /review-decision; this call does NOT approve the plan)

Revision path (when review returns changes_requested):
1. \`flowguard_plan({ reviewVerdict: "changes_requested", planText: <revised>, claims: <revised> })\`
2. → new review starts, returns \`next: "INDEPENDENT_REVIEW_COMPLETED: ..."\`
3. \`flowguard_plan({ reviewVerdict: "accept" })\` → PLAN_REVIEW (user gate — the USER decides via /review-decision)

${GOVERNANCE_RULES}
## Presentation

- If \`presentation.markdown\` is present, display its markdown verbatim — never summarize, truncate, or omit it; do not append a second conclusion.
- Only when \`presentation.markdown\` is absent, display the legacy \`reviewCard\` field verbatim.
- This is mandatory output: the user relies on it to make their review decision. When phase is \`PLAN_REVIEW\`, stop after presenting the canonical presentation. Do not call \`flowguard_decision\`, \`/approve\`, \`/request-changes\`, or \`/reject\` yourself; only the user's next explicit command may decide the gate.

## Done-when

- Plan preserves all seven mandatory semantic dimensions across the structural sections.
- The \`## Verification\` section cites Source for each check OR states NOT_VERIFIED.
- Independent review loop has converged (approved or max 3 iterations).
${DISCOVERY_REVIEW_DONE_WHEN}
- If \`presentation.markdown\` is present, it is displayed verbatim; otherwise the legacy \`reviewCard\` is displayed verbatim.
- On the converged path: phase has advanced to PLAN_REVIEW. The reviewCard already
  ends with its rendered next-action conclusion (a \`## Decision required\` block
  listing \`/approve\`, \`/request-changes\`, \`/reject\`) — do NOT append a separate
  \`Next action:\` line; the rendered conclusion is the canonical next action.
- On a blocked path (review not converged, reviewer unavailable, or a FlowGuard error code): no \`/review-decision\` next action is emitted; the response surfaces the FlowGuard blocker and its recovery instead.
`;
