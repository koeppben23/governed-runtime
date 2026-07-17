import { GOVERNANCE_RULES } from './shared-rules.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

export const CHECK_COMMAND = `
---
description: Run verification checks on the current implementation evidence.
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated verification checks for the current implementation.

## Steps

1. Call \`flowguard_status\` with NO focused flags (no whyBlocked/evidence/context/readiness) so the full projection is returned, then read \`activeChecks\` (equivalently \`remainingChecks\` in VALIDATION) and \`verificationCandidates\`.
2. If \`activeChecks\` is empty AND \`verificationCandidates\` is empty, report that no verification checks are active (no discoverable commands).
3. For each kind in \`activeChecks\` (or \`remainingChecks\`), call \`flowguard_run_check({ kind: "<kind>" })\`.
   - FlowGuard executes the discovered command and returns execution evidence.
   - You may also call \`flowguard_run_check({ kind: "<kind>" })\` directly for any kind in \`verificationCandidates\`; it validates the kind against canonical state, not against the status output.
4. If the final \`flowguard_run_check\` response has phase \`IMPL_REVIEW\`, immediately complete the mandatory independent implementation review before reporting completion:
   1. Invoke the \`${REVIEWER_SUBAGENT_TYPE}\` via the Task tool. If the response includes a \`reviewerTaskPrompt\` field, pass it VERBATIM as the Task tool "prompt" argument and append the implementation diff, executed verification evidence, and Discovery context below it — the canonical prompt already carries the required review context and attestation, so the first Task attempt is not blocked with \`SUBAGENT_PROMPT_MISSING_CONTEXT\`. Otherwise give it the implementation diff, executed verification evidence, and the response's \`requiredReviewAttestation\`. The reviewer MUST NOT call FlowGuard tools and MUST return its structured verdict.
   2. Call \`flowguard_review_implementation({ reviewVerdict })\` with only the verdict returned by the reviewer. Do not submit, copy, or fabricate \`reviewFindings\`; the host-task plugin binds the reviewer evidence.
   3. Present the returned review card or recovery. Never make the subsequent human approval decision.
5. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- If both \`activeChecks\` and \`verificationCandidates\` are empty: report no active checks.
- All active checks executed via flowguard_run_check.
- When checks advance to \`IMPL_REVIEW\`, the independent \`${REVIEWER_SUBAGENT_TYPE}\` has run and its verdict has been submitted through \`flowguard_review_implementation\`.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
