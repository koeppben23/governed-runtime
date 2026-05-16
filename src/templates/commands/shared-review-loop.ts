/**
 * @module templates/commands/shared-review-loop
 * @description Shared review-loop instructions extracted from plan, implement,
 * and architecture command templates to eliminate ~120 lines of near-identical
 * duplication. Each conditional branch is one bullet with numbered sub-steps.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

export interface ReviewLoopParams {
  /** Full tool name, e.g. `flowguard_plan`. */
  toolName: string;
  /** Artifact noun (lowercase), e.g. `plan`, `implementation`, `ADR`. */
  artifactName: string;
  /** The `changes_requested` revise-and-resubmit parameters string,
   *  e.g. `planText: <revised>` for plan or `adrText: <revised>` for architecture.
   *  Pass an empty string for implement (3-step recovery). */
  reviseParams: string;
  /** Extra steps after changes_requested before re-recording (implement only). */
  changesRequestedExtra: string;
  /** The tool call to recover from STRICT_REVIEW_ORCHESTRATION_FAILED,
   *  e.g. `flowguard_plan({ planText: <same plan text> })`. */
  strictRecoveryCall: string;
  /** Verb for the strict-recovery action, e.g. `Re-submit` or `Re-record`. */
  strictRecoveryVerb: string;
  /** Noun for the strict-recovery action, e.g. `re-submissions` or `re-recordings`. */
  strictRecoveryNoun: string;
  /** Iteration limit note, e.g. `(max 3 iterations)`. */
  iterationNote: string;
  /** Step number to return to for the next iteration. */
  repeatStep: number;
  /** Extra subagent invocation context (architecture only). */
  subagentExtra: string;
  /** FALLBACK extra wording (plan: includes "infrastructure missing"). */
  fallbackExtra: string;
  /** Unable-to-review description: what makes the artifact unreviewable. */
  unableDescription: string;
  /** Unable-to-review recovery option A. */
  unableRecoveryA: string;
  /** Unable-to-review recovery option B. */
  unableRecoveryB: string;
}

/**
 * Generate the shared review-loop section for command templates.
 *
 * Each conditional branch is a single bullet with numbered sub-steps —
 * no multi-sentence paragraphs with embedded conditionals.
 */
export function SHARED_REVIEW_LOOP(p: ReviewLoopParams): string {
  return `   - When \`next\` starts with "INDEPENDENT_REVIEW_COMPLETED":
       1. Read \`overallVerdict\` from \`pluginReviewFindings\` in the response.
       2. host_task_required mode: findings are resolved from plugin evidence automatically — submit only the verdict without \`reviewFindings\`.
       3. SDK mode: pass the entire \`pluginReviewFindings\` object as \`reviewFindings\`.
       4. "approve": Call \`${p.toolName}({ reviewVerdict: "approve" })\` (or with \`reviewFindings\` in SDK mode).
       5. "changes_requested": Revise the ${p.artifactName} to address blocking issues, then call \`${p.toolName}({ reviewVerdict: "changes_requested"${p.reviseParams ? `, ${p.reviseParams}` : ''} })\` (or with \`reviewFindings\` in SDK mode).${p.changesRequestedExtra}
       6. "unable_to_review": The reviewer declared the ${p.artifactName} unreviewable (${p.unableDescription}). The tool will be BLOCKED with reason \`SUBAGENT_UNABLE_TO_REVIEW\`. DO NOT retry the review with the same ${p.artifactName} — that obligation is consumed. Report the reviewer's findings to the user, then either ${p.unableRecoveryA} OR ${p.unableRecoveryB}.
   - When \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED":
       1. Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool${p.subagentExtra}.
       2. Submit the verdict. In host_task_required mode, plugin evidence is resolved automatically — do not submit \`reviewFindings\`.
       3. In strict mode, manual JSON/attestation copy alone is diagnostic context only; FlowGuard must persist matching \`ReviewInvocationEvidence\` before reviewFindings satisfy governance.
       4. **FALLBACK**: If the Task tool cannot spawn the reviewer (error, agent unavailable${p.fallbackExtra}), submit \`${p.toolName}({ reviewVerdict: "approve", reviewerUnavailable: true })\` to proceed with self-review assurance.
   - If review converged: Report the result per the Presentation section below.
   - If another iteration is needed: Repeat from step ${p.repeatStep} ${p.iterationNote}.
   - If the tool returns BLOCKED with code \`SUBAGENT_UNABLE_TO_REVIEW\`: Stop the review loop. Treat the obligation as consumed (no retry). Surface the recovery steps from the reason payload.
   - If the tool returns BLOCKED with code \`STRICT_REVIEW_ORCHESTRATION_FAILED\`: The plugin review pipeline encountered a transient failure. ${p.strictRecoveryVerb} the ${p.artifactName}: call \`${p.strictRecoveryCall}\` to create a fresh review obligation and retry the orchestration. Do NOT treat this as a permanent failure — up to 3 ${p.strictRecoveryNoun} are allowed.
   - If the tool returns BLOCKED with code \`ORCHESTRATION_PERMANENTLY_FAILED\`: The review orchestration has failed on multiple consecutive attempts. Report this to the user with the recovery steps from the error payload and stop.`;
}
