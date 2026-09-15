/**
 * @module templates/commands/shared-review-loop
 * @description Shared review-loop instructions extracted from plan, implement,
 * and architecture command templates to eliminate ~120 lines of near-identical
 * duplication. Each conditional branch is one bullet with numbered sub-steps.
 */

/**
 * Phase 1 Discovery-context capture instruction, shared across the plan,
 * implement, and architecture review templates (parity with /review). Discovery
 * is advisory falsification evidence, NEVER review verdict authority.
 *
 * Rendered as 3-space-indented sub-bullets to match the existing Phase 1
 * `flowguard_status` step in each template.
 */
export const DISCOVERY_REVIEW_CAPTURE = `   - Call \`flowguard_status\` with NO focused flags (no whyBlocked/evidence/context/readiness)
     so the FULL projection is returned. Focused projections omit \`discoveryHealth\`,
     \`discoveryDrift\`, and \`detectedStack\` — capture Discovery from the unfocused status,
     and never conclude Discovery is unavailable from a focused call; re-read status
     WITHOUT focused flags first.
   - Capture the compact Discovery context from the status response: Discovery
     \`health\`, \`drift\`, \`detectedStack\`, repo-native \`verificationCandidates\`,
     and risk surfaces. This is REQUIRED review evidence for repo-dependent claims.
   - Discovery context is advisory falsification evidence, NOT review verdict
     authority: the host-observed structured reviewer invocation evidence,
     obligation binding, and mandate digest remain the review authority.
   - If Discovery is unavailable, degraded, drifted, timed out, or not checked, mark
     every Discovery-dependent claim \`NOT_VERIFIED\`; do not invent repository truth.`;

/**
 * Shared Done-when Discovery bullets for the plan/implement/architecture review
 * templates (parity with /review Done-when).
 */
export const DISCOVERY_REVIEW_DONE_WHEN = `- Discovery health and drift checked before repo-dependent quality claims (or marked NOT_VERIFIED).
- Discovery-dependent claims marked NOT_VERIFIED when they could not be correlated to local Discovery.`;

export interface ReviewLoopParams {
  /** Full tool name, e.g. `flowguard_plan`. */
  toolName: string;
  /**
   * Tool name used to SUBMIT the review verdict. Defaults to `toolName`. For
   * /implement this differs from `toolName`: evidence is recorded via
   * `flowguard_implement` but the verdict is submitted via
   * `flowguard_review_implementation` (issue #565 — record and verdict are
   * separate single-purpose tools).
   */
  verdictToolName?: string;
  /** Artifact noun (lowercase), e.g. `plan`, `implementation`, `ADR`. */
  artifactName: string;
  /** The `changes_requested` revise-and-resubmit parameters string,
   *  e.g. `planText: <revised>` for plan or `adrText: <revised>` for architecture.
   *  Pass an empty string for implement (3-step recovery). */
  reviseParams: string;
  /** Extra steps after changes_requested before re-recording (implement only). */
  changesRequestedExtra: string;
  /**
   * When true, the reviewer's negative verdict is recorded BEFORE any edits:
   * the verdict tool call opens the repair cycle, so editing must never precede
   * the verdict submission (implement). When false, the artifact is revised and
   * resubmitted inside the verdict call (plan/architecture).
   */
  changesRequestedVerdictFirst?: boolean;
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
  const verdictTool = p.verdictToolName ?? p.toolName;
  return `   - \`reviewVerdict\` records the INDEPENDENT REVIEWER's result, never your own approval. On convergence it advances to the policy's terminal gate — the human review gate, where the USER approves the ${p.artifactName} via /review-decision, or a policy-permitted automatic terminal phase (e.g. \`COMPLETE\`) — whichever the tool response returns; the returned phase is authoritative. \`flowguard_decision\` is the only user approval.
    - When \`next\` starts with "INDEPENDENT_REVIEW_COMPLETED":
        1. Read the bound \`overallVerdict\` from \`next\`.
         2. Do not submit or reconstruct \`reviewFindings\`; FlowGuard has already validated and bound them.
         3. "accept": Call \`${verdictTool}({ reviewVerdict: "accept" })\`. This is the reviewer's acceptance, not user approval.
       5. "changes_requested": ${
         p.changesRequestedVerdictFirst
           ? `Record the reviewer's negative verdict FIRST: call \`${verdictTool}({ reviewVerdict: "changes_requested"${p.reviseParams ? `, ${p.reviseParams}` : ''} })\` — do NOT modify the ${p.artifactName} before FlowGuard records this verdict.${p.changesRequestedExtra}`
           : `Revise the ${p.artifactName} to address blocking issues, then call \`${verdictTool}({ reviewVerdict: "changes_requested"${p.reviseParams ? `, ${p.reviseParams}` : ''} })\`.${p.changesRequestedExtra}`
       }
       6. "unable_to_review": The reviewer declared the ${p.artifactName} unreviewable (${p.unableDescription}). The tool will be BLOCKED with reason \`SUBAGENT_UNABLE_TO_REVIEW\`. DO NOT retry the review with the same ${p.artifactName} — that obligation is consumed. Report the reviewer's findings to the user, then either ${p.unableRecoveryA} OR ${p.unableRecoveryB}.
    - When \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED": independent review is still in progress. Re-run the originating FlowGuard command only when its recovery steps direct you to do so; do not submit a verdict or reconstruct reviewer findings.
   - If review converged: Report the result per the Presentation section below.
   - If another iteration is needed: CONTINUE AUTOMATICALLY — do not stop and do not wait for a new user command between iterations. Run the next iteration from step ${p.repeatStep}, looping until the reviewer accepts (convergence) or the budget is exhausted ${p.iterationNote}.
   - If the tool returns BLOCKED with code \`SUBAGENT_UNABLE_TO_REVIEW\`: Stop the review loop. Treat the obligation as consumed (no retry). Surface the recovery steps from the reason payload.
   - If the tool returns BLOCKED with code \`STRICT_REVIEW_ORCHESTRATION_FAILED\`: The plugin review pipeline encountered a transient failure. ${p.strictRecoveryVerb} the ${p.artifactName}: call \`${p.strictRecoveryCall}\` to create a fresh review obligation and retry the orchestration. Do NOT treat this as a permanent failure — up to 3 ${p.strictRecoveryNoun} are allowed.
   - If the tool returns BLOCKED with code \`ORCHESTRATION_PERMANENTLY_FAILED\`: The review orchestration has failed on multiple consecutive attempts. Report this to the user with the recovery steps from the error payload and stop.`;
}
