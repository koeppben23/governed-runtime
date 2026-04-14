/**
 * @module governance
 * @description OpenCode Custom Tools for the governance system.
 *
 * 9 named exports -> 9 tools (governance_status, governance_hydrate, etc.)
 * OpenCode derives tool names as <filename>_<exportname>.
 *
 * Architecture:
 * - Tools are the bridge between the LLM and the governance state machine.
 * - Simple operations (hydrate, ticket, decision, abort, review) call rails directly.
 * - Iterative operations (plan, implement) manage state step-by-step
 *   because the LLM drives the loop (multi-call pattern).
 * - Validation records check results submitted by the LLM.
 * - All tools: resolve worktree -> read state -> resolve policy -> work -> persist -> return JSON.
 *
 * Policy integration:
 * - Policy is resolved from state.policySnapshot.mode (for existing sessions)
 *   or from "team" default (for new sessions / status checks).
 * - Policy is injected into RailContext so all rails get it.
 * - maxIterations for review loops come from the policy, not hardcoded constants.
 *
 * Return format:
 * Every tool returns a JSON string with structured data for the LLM:
 *   { phase, status, next?, data? }
 *
 * Error handling:
 * Tools catch all errors and return structured error JSON via the reason registry:
 *   { error: true, code, message, recovery?, quickFix? }
 * This ensures the LLM always gets parseable feedback, never raw stack traces.
 *
 * @version v1
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

// State & Machine
import type { SessionState, Phase } from "../../src/state/schema";
import { evaluate } from "../../src/machine/evaluate";
import type { EvalResult } from "../../src/machine/evaluate";
import { isCommandAllowed, Command } from "../../src/machine/commands";

// Rails (direct-call: no executors needed)
import { executeHydrate } from "../../src/rails/hydrate";
import { executeTicket } from "../../src/rails/ticket";
import { executeReviewDecision } from "../../src/rails/review-decision";
import { executeReview } from "../../src/rails/review";
import { executeAbort } from "../../src/rails/abort";

// Rail helpers
import { autoAdvance, applyTransition } from "../../src/rails/types";
import type { RailResult, RailContext, TransitionRecord } from "../../src/rails/types";

// Adapters
import {
  readState,
  writeState,
  writeReport,
} from "../../src/adapters/persistence";
import { fromOpenCodeContext } from "../../src/adapters/binding";
import { changedFiles, listRepoSignals } from "../../src/adapters/git";
import { createRailContext } from "../../src/adapters/context";

// Evidence types
import type {
  PlanEvidence,
  CheckId,
  LoopVerdict,
  RevisionDelta,
} from "../../src/state/evidence";

// Config: Policy, Reasons, Completeness
import { resolvePolicy } from "../../src/config/policy";
import type { GovernancePolicy } from "../../src/config/policy";
import { defaultReasonRegistry } from "../../src/config/reasons";
import { evaluateCompleteness } from "../../src/audit/completeness";

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/** Format an EvalResult into a human-readable next-action string. */
function formatEval(ev: EvalResult): string {
  switch (ev.kind) {
    case "transition":
      return `Auto-advanced to ${ev.target} via ${ev.event}.`;
    case "waiting":
      return ev.reason;
    case "terminal":
      return "Workflow complete. Session is terminal.";
    case "pending":
      return `Phase ${ev.phase} needs more work.`;
  }
}

/** Format a RailResult for LLM consumption. Includes _audit for the audit plugin. */
function formatRailResult(result: RailResult): string {
  if (result.kind === "blocked") {
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
    });
  }
  return JSON.stringify({
    phase: result.state.phase,
    status: "ok",
    next: formatEval(result.evalResult),
    _audit: { transitions: result.transitions },
  });
}

/**
 * Format a blocked error using the reason registry.
 * Used for inline blocked returns in tool logic (outside rail calls).
 */
function formatBlocked(
  code: string,
  vars?: Record<string, string>,
): string {
  const info = defaultReasonRegistry.format(code, vars);
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
  });
}

/** Wrap any thrown error into a structured JSON string via the registry. */
function formatError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && "code" in err
      ? String((err as { code: unknown }).code)
      : "INTERNAL_ERROR";
  return formatBlocked(code, { message });
}

/** Extract worktree from OpenCode tool context. */
function getWorktree(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}): string {
  return context.worktree || context.directory;
}

/** Read state with null-safety messaging. */
async function requireState(
  worktree: string,
): Promise<SessionState> {
  const state = await readState(worktree);
  if (!state) {
    throw Object.assign(
      new Error(
        "No governance session found. Run /hydrate first to bootstrap a session.",
      ),
      { code: "NO_SESSION" },
    );
  }
  return state;
}

/**
 * Resolve policy from session state (existing session)
 * or default to TEAM_POLICY (no session yet).
 */
function resolvePolicyFromState(state: SessionState | null): GovernancePolicy {
  return resolvePolicy(state?.policySnapshot?.mode);
}

/**
 * Create a policy-aware RailContext.
 * Merges the production context with the resolved policy.
 */
function createPolicyContext(policy: GovernancePolicy): RailContext {
  return { ...createRailContext(), policy };
}

/**
 * Persist a RailResult if it's an "ok" result. Returns the formatted JSON.
 * Rails don't persist — the caller (this tool layer) does it atomically.
 */
async function persistAndFormat(
  worktree: string,
  result: RailResult,
): Promise<string> {
  if (result.kind === "ok") {
    await writeState(worktree, result.state);
  }
  return formatRailResult(result);
}

/** Extract markdown section headers from plan text. */
function extractSections(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 1: governance_status — Read-Only State Check
// ═══════════════════════════════════════════════════════════════════════════════

export const status = tool({
  description:
    "Read the current governance session state. Returns phase, evidence summary, " +
    "policy info, completeness matrix, and next action. " +
    "Does NOT mutate state. Use this to understand where the workflow is before taking action.",
  args: {},
  async execute(_args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await readState(worktree);

      if (!state) {
        return JSON.stringify({
          phase: null,
          status: "No governance session found.",
          next: "Run /hydrate to bootstrap a session.",
        });
      }

      const policy = resolvePolicyFromState(state);
      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);

      return JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        policyMode: state.policySnapshot?.mode ?? "unknown",
        initiatedBy: state.initiatedBy,
        profileId: state.activeProfile?.id ?? "none",
        profileName: state.activeProfile?.name ?? "None",
        profileRules: state.activeProfile?.ruleContent ?? "",
        hasTicket: state.ticket !== null,
        hasPlan: state.plan !== null,
        planVersion: state.plan
          ? state.plan.history.length + 1
          : 0,
        selfReviewIteration: state.selfReview?.iteration ?? null,
        selfReviewConverged: state.selfReview
          ? state.selfReview.iteration >= state.selfReview.maxIterations ||
            (state.selfReview.revisionDelta === "none" &&
              state.selfReview.verdict === "approve")
          : null,
        validationResults: state.validation.map((v) => ({
          checkId: v.checkId,
          passed: v.passed,
        })),
        hasImplementation: state.implementation !== null,
        implReviewIteration: state.implReview?.iteration ?? null,
        implReviewConverged: state.implReview
          ? state.implReview.iteration >=
              state.implReview.maxIterations ||
            (state.implReview.revisionDelta === "none" &&
              state.implReview.verdict === "approve")
          : null,
        hasReviewDecision: state.reviewDecision !== null,
        reviewVerdict: state.reviewDecision?.verdict ?? null,
        error: state.error,
        evalKind: ev.kind,
        next: formatEval(ev),
        completeness: {
          overallComplete: completeness.overallComplete,
          fourEyes: completeness.fourEyes,
          summary: completeness.summary,
        },
      });
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 2: governance_hydrate — Bootstrap Session
// ═══════════════════════════════════════════════════════════════════════════════

export const hydrate = tool({
  description:
    "Bootstrap or reload the governance session. Creates a new session if none exists, " +
    "or returns the existing session unchanged (idempotent). " +
    "Optionally configure policy mode (solo/team/regulated) and profile. " +
    "This MUST be the first governance tool call in any workflow.",
  args: {
    policyMode: z
      .enum(["solo", "team", "regulated"])
      .default("team")
      .describe(
        "Governance policy mode. 'solo' = no human gates. " +
        "'team' = human gates, self-approval allowed. " +
        "'regulated' = human gates, four-eyes principle enforced.",
      ),
    profileId: z
      .string()
      .default("baseline")
      .describe("Governance profile ID. Defaults to 'baseline'."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const existing = await readState(worktree);

      // Resolve policy for context
      const policy = existing
        ? resolvePolicyFromState(existing)
        : resolvePolicy(args.policyMode);
      const ctx = createPolicyContext(policy);

      // Gather repo signals for profile auto-detection (only needed for new sessions)
      const repoSignals = existing ? undefined : await listRepoSignals(worktree);

      const result = executeHydrate(existing, {
        sessionId: context.sessionID,
        worktree,
        policyMode: args.policyMode,
        profileId: args.profileId,
        repoSignals,
        initiatedBy: context.sessionID,
      }, ctx);

      // Include detected profile info in the response for new sessions
      if (result.kind === "ok" && !existing) {
        const state = result.state;
        const formatted = JSON.parse(await persistAndFormat(worktree, result));
        return JSON.stringify({
          ...formatted,
          profileId: state.activeProfile?.id ?? "baseline",
          profileName: state.activeProfile?.name ?? "Baseline Governance",
          profileDetected: !!repoSignals,
        });
      }

      return await persistAndFormat(worktree, result);
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 3: governance_ticket — Record Task
// ═══════════════════════════════════════════════════════════════════════════════

export const ticket = tool({
  description:
    "Record the task/ticket description for the governance session. " +
    "Clears all downstream evidence (plan, validation, implementation). " +
    "Allowed only in TICKET phase.",
  args: {
    text: z.string().describe(
      "The task or ticket description. Must be non-empty.",
    ),
    source: z
      .enum(["user", "external"])
      .default("user")
      .describe("Source of the ticket: 'user' (typed in chat) or 'external' (from issue tracker)."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const result = executeTicket(state, {
        text: args.text,
        source: args.source,
      }, ctx);

      return await persistAndFormat(worktree, result);
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 4: governance_plan — Submit Plan OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Multi-call pattern driven by the LLM:
//
// Step 1: LLM generates plan, calls governance_plan({ planText: "..." })
//   -> Tool records plan, initializes self-review loop, returns "self-review needed"
//
// Step 2: LLM reviews plan critically, calls governance_plan({
//   selfReviewVerdict: "changes_requested", planText: "revised..."
// }) OR governance_plan({ selfReviewVerdict: "approve" })
//   -> Tool records iteration, checks convergence
//
// Repeat Step 2 until converged or max iterations (from policy).
// On convergence: auto-advance to PLAN_REVIEW.
// ═══════════════════════════════════════════════════════════════════════════════

export const plan = tool({
  description:
    "Submit a plan OR record a self-review verdict. Two modes:\n" +
    "Mode A (submit plan): provide planText. Records the plan and starts self-review loop.\n" +
    "Mode B (self-review): provide selfReviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised planText.\n" +
    "The self-review loop runs up to maxIterations (from policy). " +
    "On convergence, auto-advances to PLAN_REVIEW.",
  args: {
    planText: z
      .string()
      .optional()
      .describe(
        "Plan body text (markdown). Required for Mode A (initial submission) " +
        "and when selfReviewVerdict is 'changes_requested' (revised plan).",
      ),
    selfReviewVerdict: z
      .enum(["approve", "changes_requested"])
      .optional()
      .describe(
        "Self-review verdict. Omit for initial plan submission. " +
        "'approve' = plan is good, advance. " +
        "'changes_requested' = plan needs revision, provide updated planText.",
      ),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxSelfReviewIterations = policy.maxSelfReviewIterations;

      // Admissibility
      if (!isCommandAllowed(state.phase, Command.PLAN)) {
        return formatBlocked("COMMAND_NOT_ALLOWED", {
          command: "/plan",
          phase: state.phase,
        });
      }

      // Require ticket
      if (!state.ticket) {
        return formatBlocked("TICKET_REQUIRED", { action: "creating a plan" });
      }

      const isInitialSubmission = !args.selfReviewVerdict;

      if (isInitialSubmission) {
        // ── Mode A: Initial plan submission ──────────────────────
        const planBody = args.planText?.trim();
        if (!planBody) {
          return formatBlocked("EMPTY_PLAN");
        }

        const planEvidence: PlanEvidence = {
          body: planBody,
          digest: ctx.digest(planBody),
          sections: extractSections(planBody),
          createdAt: ctx.now(),
        };

        // Preserve version history
        const history = state.plan
          ? [state.plan.current, ...state.plan.history]
          : [];

        const nextState: SessionState = {
          ...state,
          plan: { current: planEvidence, history },
          selfReview: {
            iteration: 0,
            maxIterations: maxSelfReviewIterations,
            prevDigest: null,
            currDigest: planEvidence.digest,
            revisionDelta: "major" as RevisionDelta,
            verdict: "changes_requested" as LoopVerdict,
          },
          error: null,
        };

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, evalResult: ev, transitions } = autoAdvance(
          nextState,
          evalFn,
          ctx,
        );
        await writeState(worktree, finalState);

        return JSON.stringify({
          phase: finalState.phase,
          status: "Plan submitted (v" + (history.length + 1) + ").",
          planDigest: planEvidence.digest,
          selfReviewIteration: 0,
          maxSelfReviewIterations,
          next:
            "Self-review needed. Review the plan critically against the ticket. " +
            "Check for completeness, correctness, edge cases, and feasibility. " +
            "Then call governance_plan with selfReviewVerdict.",
          _audit: { transitions },
        });
      } else {
        // ── Mode B: Self-review verdict ──────────────────────────
        if (!state.selfReview) {
          return formatBlocked("NO_SELF_REVIEW");
        }
        if (!state.plan) {
          return formatBlocked("NO_PLAN");
        }

        const iteration = state.selfReview.iteration + 1;
        const verdict = args.selfReviewVerdict as LoopVerdict;
        const prevDigest = state.plan.current.digest;

        let currentPlan = state.plan.current;
        let history = [...state.plan.history];
        let revisionDelta: RevisionDelta = "none";

        if (verdict === "changes_requested") {
          const revisedBody = args.planText?.trim();
          if (!revisedBody) {
            return formatBlocked("REVISED_PLAN_REQUIRED");
          }

          const revised: PlanEvidence = {
            body: revisedBody,
            digest: ctx.digest(revisedBody),
            sections: extractSections(revisedBody),
            createdAt: ctx.now(),
          };

          revisionDelta = revised.digest === prevDigest ? "none" : "minor";
          history = [currentPlan, ...history];
          currentPlan = revised;
        }

        // Build updated state
        const nextState: SessionState = {
          ...state,
          plan: { current: currentPlan, history },
          selfReview: {
            iteration,
            maxIterations: maxSelfReviewIterations,
            prevDigest,
            currDigest: currentPlan.digest,
            revisionDelta,
            verdict,
          },
          error: null,
        };

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, evalResult: ev, transitions } = autoAdvance(
          nextState,
          evalFn,
          ctx,
        );
        await writeState(worktree, finalState);

        // Check convergence for messaging
        const converged =
          iteration >= maxSelfReviewIterations ||
          (revisionDelta === "none" && verdict === "approve");

        if (converged) {
          return JSON.stringify({
            phase: finalState.phase,
            status: `Self-review converged at iteration ${iteration}. Plan approved.`,
            planDigest: currentPlan.digest,
            selfReviewIteration: iteration,
            next: formatEval(ev),
            _audit: { transitions },
          });
        }

        return JSON.stringify({
          phase: finalState.phase,
          status: `Self-review iteration ${iteration}/${maxSelfReviewIterations}. Verdict: ${verdict}.`,
          planDigest: currentPlan.digest,
          selfReviewIteration: iteration,
          revisionDelta,
          next:
            "Review the plan again. Check if the revisions address all issues. " +
            "Call governance_plan with selfReviewVerdict.",
          _audit: { transitions },
        });
      }
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 5: governance_decision — Human Verdict at User Gates
// ═══════════════════════════════════════════════════════════════════════════════

export const decision = tool({
  description:
    "Record a human review decision at a User Gate (PLAN_REVIEW or EVIDENCE_REVIEW). " +
    "Verdicts: 'approve' (proceed), 'changes_requested' (revise), 'reject' (restart from ticket). " +
    "This tool ONLY works at PLAN_REVIEW and EVIDENCE_REVIEW phases. " +
    "In regulated mode, four-eyes principle is enforced: the reviewer must differ from the session initiator.",
  args: {
    verdict: z
      .enum(["approve", "changes_requested", "reject"])
      .describe(
        "Review verdict. 'approve' advances the workflow. " +
        "'changes_requested' returns to revision. " +
        "'reject' restarts from TICKET.",
      ),
    rationale: z
      .string()
      .default("")
      .describe("Reason for the decision. Recorded in audit trail."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const result = executeReviewDecision(
        state,
        {
          verdict: args.verdict,
          rationale: args.rationale,
          decidedBy: context.sessionID,
        },
        ctx,
      );

      return await persistAndFormat(worktree, result);
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 6: governance_implement — Record Implementation OR Impl Review Verdict
// ═══════════════════════════════════════════════════════════════════════════════
//
// Multi-call pattern driven by the LLM:
//
// Step 1: LLM makes code changes using OpenCode built-in tools (read, write, bash)
// Step 2: LLM calls governance_implement({})
//   -> Tool auto-detects changed files via git, records ImplEvidence
//   -> Auto-advances to IMPL_REVIEW
//   -> Returns "review needed"
//
// Step 3: LLM reviews the implementation
// Step 4: LLM calls governance_implement({ reviewVerdict: "approve" })
//   -> Tool records review iteration, checks convergence
//   -> On convergence: auto-advance to EVIDENCE_REVIEW
//
// OR Step 4: LLM calls governance_implement({ reviewVerdict: "changes_requested" })
//   -> LLM makes more code changes, then calls governance_implement({}) again
// ═══════════════════════════════════════════════════════════════════════════════

export const implement = tool({
  description:
    "Record implementation evidence OR submit implementation review verdict. Two modes:\n" +
    "Mode A (record impl): no reviewVerdict. Auto-detects changed files via git. " +
    "Use AFTER making code changes with read/write/bash tools.\n" +
    "Mode B (review verdict): provide reviewVerdict ('approve' or 'changes_requested'). " +
    "Use at IMPL_REVIEW after reviewing the implementation.\n" +
    "Review loop runs up to maxIterations (from policy). " +
    "On convergence, auto-advances to EVIDENCE_REVIEW.",
  args: {
    reviewVerdict: z
      .enum(["approve", "changes_requested"])
      .optional()
      .describe(
        "Implementation review verdict. Omit to record implementation evidence. " +
        "'approve' = implementation is correct. " +
        "'changes_requested' = implementation needs revision.",
      ),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxImplReviewIterations = policy.maxImplReviewIterations;

      const isRecordImpl = !args.reviewVerdict;

      if (isRecordImpl) {
        // ── Mode A: Record implementation evidence ───────────────
        if (!isCommandAllowed(state.phase, Command.IMPLEMENT)) {
          return formatBlocked("COMMAND_NOT_ALLOWED", {
            command: "/implement",
            phase: state.phase,
          });
        }

        if (!state.ticket) {
          return formatBlocked("TICKET_REQUIRED", { action: "implementation" });
        }
        if (!state.plan) {
          return formatBlocked("PLAN_REQUIRED", { action: "implementation" });
        }

        // Auto-detect changed files via git
        const files = await changedFiles(worktree);
        // Separate domain files (non-config, non-test, non-governance)
        const domainFiles = files.filter(
          (f) =>
            !f.startsWith(".governance/") &&
            !f.startsWith(".opencode/") &&
            !f.includes("node_modules/"),
        );

        const implEvidence = {
          changedFiles: files,
          domainFiles,
          digest: ctx.digest(files.sort().join("\n")),
          executedAt: ctx.now(),
        };

        let nextState: SessionState = {
          ...state,
          implementation: implEvidence,
          implReview: null,
          error: null,
        };

        // Auto-advance to IMPL_REVIEW (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, evalResult: ev, transitions } = autoAdvance(
          nextState,
          evalFn,
          ctx,
        );
        await writeState(worktree, finalState);

        return JSON.stringify({
          phase: finalState.phase,
          status: `Implementation recorded. ${files.length} files changed, ${domainFiles.length} domain files.`,
          changedFiles: files,
          domainFiles,
          next:
            "Review the implementation against the plan. Check correctness, completeness, " +
            "edge cases, and code quality. Then call governance_implement with reviewVerdict.",
          _audit: { transitions },
        });
      } else {
        // ── Mode B: Implementation review verdict ────────────────
        if (state.phase !== "IMPL_REVIEW") {
          return formatBlocked("WRONG_PHASE", { phase: state.phase });
        }

        if (!state.implementation) {
          return formatBlocked("NO_IMPLEMENTATION");
        }

        const iteration = (state.implReview?.iteration ?? 0) + 1;
        const verdict = args.reviewVerdict as LoopVerdict;
        const prevDigest = state.implementation.digest;

        // For changes_requested, the LLM should make changes and call
        // governance_implement({}) again (Mode A). Here we just record
        // the review verdict.
        let revisionDelta: RevisionDelta = "none";

        const nextState: SessionState = {
          ...state,
          implReview: {
            iteration,
            maxIterations: maxImplReviewIterations,
            prevDigest,
            currDigest: state.implementation.digest,
            revisionDelta,
            verdict,
            executedAt: ctx.now(),
          },
          error: null,
        };

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, evalResult: ev, transitions } = autoAdvance(
          nextState,
          evalFn,
          ctx,
        );
        await writeState(worktree, finalState);

        const converged =
          iteration >= maxImplReviewIterations ||
          (revisionDelta === "none" && verdict === "approve");

        if (converged && verdict === "approve") {
          return JSON.stringify({
            phase: finalState.phase,
            status: `Implementation review converged at iteration ${iteration}. Approved.`,
            implReviewIteration: iteration,
            next: formatEval(ev),
            _audit: { transitions },
          });
        }

        if (verdict === "changes_requested") {
          return JSON.stringify({
            phase: finalState.phase,
            status: `Implementation review iteration ${iteration}/${maxImplReviewIterations}. Changes requested.`,
            implReviewIteration: iteration,
            next:
              "Make the requested code changes using read/write/bash tools, " +
              "then call governance_implement (without reviewVerdict) to re-record the implementation.",
            _audit: { transitions },
          });
        }

        // Forced convergence (max iterations reached, verdict was not approve)
        return JSON.stringify({
          phase: finalState.phase,
          status: `Implementation review reached max iterations (${iteration}/${maxImplReviewIterations}). Force-converged.`,
          implReviewIteration: iteration,
          next: formatEval(ev),
          _audit: { transitions },
        });
      }
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 7: governance_validate — Record Validation Check Results
// ═══════════════════════════════════════════════════════════════════════════════

export const validate = tool({
  description:
    "Record validation check results. The LLM executes the checks (test analysis, " +
    "rollback safety analysis, etc.) and reports results here. " +
    "Provide an array of check results. Check IDs must match the session's activeChecks. " +
    "After recording: ALL_PASSED -> advance to IMPLEMENTATION, CHECK_FAILED -> return to PLAN.",
  args: {
    results: z
      .array(
        z.object({
          checkId: z
            .string()
            .min(1)
            .describe("Which validation check this result is for (must match activeChecks)."),
          passed: z.boolean().describe("Whether the check passed."),
          detail: z
            .string()
            .describe("Detailed explanation of the check result."),
        }),
      )
      .describe(
        "Array of validation check results. Must cover all activeChecks for the session.",
      ),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      // Admissibility
      if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
        return formatBlocked("COMMAND_NOT_ALLOWED", {
          command: "/validate",
          phase: state.phase,
        });
      }

      if (state.activeChecks.length === 0) {
        return formatBlocked("NO_ACTIVE_CHECKS");
      }

      // Validate that all active checks are covered
      const submittedIds = new Set(args.results.map((r) => r.checkId));
      const missing = state.activeChecks.filter(
        (id) => !submittedIds.has(id),
      );
      if (missing.length > 0) {
        return formatBlocked("MISSING_CHECKS", {
          checks: missing.join(", "),
        });
      }

      // Record results with timestamps
      const now = ctx.now();
      const validationResults = args.results.map((r) => ({
        checkId: r.checkId as CheckId,
        passed: r.passed,
        detail: r.detail,
        executedAt: now,
      }));

      const nextState: SessionState = {
        ...state,
        validation: validationResults,
        error: null,
      };

      // Evaluate + autoAdvance (ALL_PASSED -> IMPLEMENTATION, CHECK_FAILED -> PLAN)
      const evalFn = (s: SessionState) => evaluate(s, policy);
      const { state: finalState, evalResult: ev, transitions } = autoAdvance(
        nextState,
        evalFn,
        ctx,
      );
      await writeState(worktree, finalState);

      const allPassed = validationResults.every((r) => r.passed);
      const failedChecks = validationResults
        .filter((r) => !r.passed)
        .map((r) => r.checkId);

      return JSON.stringify({
        phase: finalState.phase,
        status: allPassed
          ? "All validation checks passed."
          : `Validation failed: ${failedChecks.join(", ")}.`,
        results: validationResults.map((r) => ({
          checkId: r.checkId,
          passed: r.passed,
        })),
        next: formatEval(ev),
        _audit: { transitions },
      });
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 8: governance_review — Generate Compliance Report (Read-Only)
// ═══════════════════════════════════════════════════════════════════════════════

export const review = tool({
  description:
    "Generate a standalone compliance review report with evidence completeness matrix " +
    "and four-eyes principle status. Always available in every phase. " +
    "Does NOT mutate session state. Produces a governance-review-report.v1 artifact " +
    "written to .governance/review-report.json.",
  args: {},
  async execute(_args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const now = new Date().toISOString();

      // Generate extended report (with completeness matrix)
      const report = await executeReview(state, now);

      // Write report artifact
      await writeReport(worktree, report);

      return JSON.stringify({
        phase: state.phase,
        status: "Review report generated.",
        reportPath: ".governance/review-report.json",
        overallStatus: report.overallStatus,
        policyMode: state.policySnapshot?.mode ?? "unknown",
        completeness: {
          overallComplete: report.completeness.overallComplete,
          fourEyes: report.completeness.fourEyes,
          summary: report.completeness.summary,
          slots: report.completeness.slots.map((s) => ({
            slot: s.slot,
            label: s.label,
            status: s.status,
            detail: s.detail,
          })),
        },
        findingsCount: report.findings.length,
        findings: report.findings,
        validationSummary: report.validationSummary,
      });
    } catch (err) {
      return formatError(err);
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tool 9: governance_abort_session — Emergency Termination
// ═══════════════════════════════════════════════════════════════════════════════

export const abort_session = tool({
  description:
    "Emergency termination of the governance session. Bypasses the state machine " +
    "and directly sets phase to COMPLETE with an ABORTED error marker. " +
    "Use only when the session cannot or should not continue. Irreversible.",
  args: {
    reason: z
      .string()
      .default("Session aborted by user")
      .describe("Reason for aborting. Recorded in audit trail."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);
      const state = await requireState(worktree);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const result = executeAbort(
        state,
        {
          reason: args.reason,
          actor: context.sessionID,
        },
        ctx,
      );

      return await persistAndFormat(worktree, result);
    } catch (err) {
      return formatError(err);
    }
  },
});
