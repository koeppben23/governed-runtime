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
3. For each kind in \`activeChecks\` (or \`remainingChecks\`), call \`flowguard_run_check({ kind: "<kind>" })\` sequentially. Never run two state-mutating checks concurrently.
    - FlowGuard executes the discovered command and returns execution evidence.
    - You may also call \`flowguard_run_check({ kind: "<kind>" })\` directly for any kind in \`verificationCandidates\`; it validates the kind against canonical state, not against the status output.
    - If the response does not transition to a stop phase, call \`flowguard_status\` again before selecting the next check. Treat the status projection, not an earlier check response, as authoritative after another mutation may have run.
4. For a response that transitions to a stop phase, inspect that \`flowguard_run_check\` response before calling any other tool:
   - If its phase is \`IMPLEMENTATION\`: report the passed checks and the rendered next action, then STOP. Do not call \`read\`, \`glob\`, \`grep\`, \`bash\`, \`write\`, \`edit\`, \`flowguard_implement\`, or any implementation-review tool. Only a new, explicit user \`/implement\` command may start implementation.
   - If its phase is \`PLAN\` or \`IMPL_VALIDATION\`: report the check result and stop. Do not retry or advance without a new explicit user command.
   - If its phase is \`IMPL_REVIEW\`, immediately complete the mandatory independent implementation review before reporting completion:
      1. Invoke the \`${REVIEWER_SUBAGENT_TYPE}\` via the Task tool. When FlowGuard provides a \`reviewerTaskPrompt\`, call Task only with \`subagent_type: "${REVIEWER_SUBAGENT_TYPE}"\`; FlowGuard injects the canonical host-issued prompt at the Task boundary. Do not append or modify reviewer instructions. Otherwise give the reviewer the implementation diff, executed verification evidence, and the response's \`requiredReviewAttestation\`. The reviewer MUST NOT call FlowGuard tools and MUST return its structured verdict.
      2. If the Task returns a structured verdict, call \`flowguard_review_implementation({ reviewVerdict })\` with only that verdict. Do not submit, copy, or fabricate \`reviewFindings\`; the host-task plugin binds the reviewer evidence.
      3. If the Task cannot spawn the reviewer, follow the policy-specific recovery in the FlowGuard response: required stops blocked; preferred reports the actual transport failure with \`flowguard_review_implementation({ reviewerUnavailable: true })\` only, without a verdict or findings, so FlowGuard can use the configured SDK transport. Never fabricate findings or make the subsequent human approval decision.
      4. Present the returned review card or recovery. Never make the subsequent human approval decision.
5. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- If both \`activeChecks\` and \`verificationCandidates\` are empty: report no active checks.
- All active checks executed via flowguard_run_check.
- When checks advance to \`IMPL_REVIEW\`, the independent \`${REVIEWER_SUBAGENT_TYPE}\` has run and its verdict has been submitted through \`flowguard_review_implementation\`.
- When checks advance to \`IMPLEMENTATION\`, the result was reported and the command stopped without implementation work.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
