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
  /** The tool call to recover a technically failed reviewer attempt. */
  strictRecoveryCall: string;
  /** Verb for the recovery action, e.g. `Re-submit` or `Re-record`. */
  strictRecoveryVerb: string;
  /** Noun for recovery attempts. */
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
 * OpenCode review execution is intentionally explicit: the parent agent calls
 * the native Task tool, while FlowGuard's before-hook replaces the placeholder
 * prompt with the exact frozen reviewer material and persists dispatch authority
 * before host release. Task free-form text is never findings authority; the
 * after-hook obtains JSON-schema findings from the same visible child session.
 */
export function SHARED_REVIEW_LOOP(p: ReviewLoopParams): string {
  const verdictTool = p.verdictToolName ?? p.toolName;
  return `   - \`reviewVerdict\` records the INDEPENDENT REVIEWER's result, never your own approval. On convergence it advances to the policy's terminal gate — the human review gate, where the USER approves the ${p.artifactName} via /review-decision, or a policy-permitted automatic terminal phase (e.g. \`COMPLETE\`) — whichever the tool response returns; the returned phase is authoritative. \`flowguard_decision\` is the only user approval. When the response carries \`agentInstruction\`, follow it exactly; when it carries \`directive\`, the directive is the canonical routing.
    - When \`reviewDispatch.required\` is true and \`reviewDispatch.completed\` is not true:
       1. Require \`reviewInvocation.action === "call_task"\`, \`reviewInvocation.transport === "native_task_structured_followup"\`, and \`reviewInvocation.task.subagentType === "flowguard-reviewer"\`. If any differ, stop: do not invent another transport.
       2. Call the host-native \`task\` tool with \`subagent_type: "flowguard-reviewer"\`, \`description: "FlowGuard independent review"\`, and \`prompt: "FlowGuard independent review"\`. The prompt argument is transport filler only; FlowGuard replaces it at the before-hook with the exact frozen canonical review prompt. Never paste, reconstruct, or modify the reviewer material yourself.
       3. Wait for that Task call to return normally. Do not run a second reviewer and do not parse its free-form text as findings. FlowGuard serializes JSON-schema findings from the SAME child session, binds them to the exact obligation/attempt, and replaces the Task result with canonical \`reviewDispatch\` / \`reviewExecution\` data.
       4. Require \`reviewExecution.visible === true\`, \`reviewExecution.transcriptNavigable === true\`, and \`reviewExecution.structuredOutput === true\`. Otherwise stop on the returned FlowGuard blocker.
    - When \`reviewDispatch.completed\` is true:
       1. Read the bound \`overallVerdict\` from \`reviewDispatch.verdict\`.
       2. Do not submit or reconstruct \`reviewFindings\`; FlowGuard has already validated and bound them.
       3. "accept": Call \`${verdictTool}({ reviewVerdict: "accept" })\`. This is the reviewer's acceptance, not user approval.
       4. "changes_requested": ${
         p.changesRequestedVerdictFirst
           ? `Record the reviewer's negative verdict FIRST: call \`${verdictTool}({ reviewVerdict: "changes_requested"${p.reviseParams ? `, ${p.reviseParams}` : ''} })\` — do NOT modify the ${p.artifactName} before FlowGuard records this verdict.${p.changesRequestedExtra}`
           : `Revise the ${p.artifactName} to address blocking issues, then call \`${verdictTool}({ reviewVerdict: "changes_requested"${p.reviseParams ? `, ${p.reviseParams}` : ''} })\`.${p.changesRequestedExtra}`
       }
       5. "unable_to_review": The reviewer declared the ${p.artifactName} unreviewable (${p.unableDescription}). The tool will be BLOCKED with reason \`SUBAGENT_UNABLE_TO_REVIEW\`. DO NOT retry the review with the same ${p.artifactName} — that obligation is consumed. Report the reviewer result to the user, then either ${p.unableRecoveryA} OR ${p.unableRecoveryB}.
   - If review converged: Report the result per the Presentation section below.
   - If another semantic iteration is needed: CONTINUE AUTOMATICALLY — do not stop and do not wait for a new user command between iterations. Run the next iteration from step ${p.repeatStep}, looping until the reviewer accepts (convergence) or the budget is exhausted ${p.iterationNote}.
   - If the native reviewer Task or same-child structured serialization fails technically: ${p.strictRecoveryVerb} the SAME ${p.artifactName} with \`${p.strictRecoveryCall}\`. This re-arms the frozen obligation with a fresh append-only ReviewAttempt; it MUST NOT create a new artifact/plan revision solely for a transport failure. Never retry by issuing a second bare Task against the spent attempt.
   - If the tool returns BLOCKED with code \`SUBAGENT_UNABLE_TO_REVIEW\`: Stop the review loop. Treat the obligation as consumed (no retry). Surface the recovery steps from the reason payload.`;
}
