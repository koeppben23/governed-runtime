/**
 * @module review
 * @description /review rail — standalone read-only review report.
 *
 * Always available, in every phase. Does NOT mutate state.
 * Generates a ReviewReport as an independent compliance artifact.
 *
 * Now includes the Evidence Completeness Matrix and Four-Eyes status.
 *
 * The report is written as a separate file (flowguard-review-report.v1),
 * not embedded in state. This makes it:
 * - Independently auditable (can be diffed, versioned, shared)
 * - Available without loading the full session state
 * - Forward-compatible (own schema version)
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import type { ReviewReport } from "../state/evidence";
import { evaluateCompleteness } from "../audit/completeness";
import type { CompletenessReport } from "../audit/completeness";

// ─── Executor Interface ───────────────────────────────────────────────────────

export interface ReviewExecutors {
  /**
   * Generate analysis findings via LLM. Optional.
   * If not provided, only mechanical checks are included in the report.
   */
  analyze?: (
    state: SessionState,
  ) => Promise<Array<{ severity: "info" | "warning" | "error"; category: string; message: string }>>;
}

// ─── Extended Review Report ───────────────────────────────────────────────────

/**
 * Extended review report with completeness matrix.
 * Extends the base ReviewReport with evidence completeness and four-eyes data.
 */
export interface ExtendedReviewReport extends ReviewReport {
  /** Evidence completeness matrix — per-slot status for all evidence. */
  completeness: CompletenessReport;
}

// ─── Report Generator ─────────────────────────────────────────────────────────

/**
 * Generate an ExtendedReviewReport from the current state.
 * Pure read — does NOT mutate state, does NOT produce RailResult.
 *
 * The caller is responsible for:
 * - Writing the report to .flowguard/review-report.json
 * - NOT persisting any state changes (there are none)
 */
export async function executeReview(
  state: SessionState,
  now: string,
  executors?: ReviewExecutors,
): Promise<ExtendedReviewReport> {
  // 1. Collect validation summary from state
  const validationSummary = state.validation.map((v) => ({
    checkId: v.checkId,
    passed: v.passed,
    detail: v.detail,
  }));

  // 2. Evaluate evidence completeness (mechanical, deterministic)
  const completeness = evaluateCompleteness(state);

  // 3. Generate findings (LLM or mechanical)
  let findings: Array<{ severity: "info" | "warning" | "error"; category: string; message: string }> = [];

  // Mechanical findings (always)
  if (!state.ticket) {
    findings.push({ severity: "warning", category: "completeness", message: "No ticket evidence" });
  }
  if (!state.plan) {
    findings.push({ severity: "warning", category: "completeness", message: "No plan evidence" });
  }
  if (state.error) {
    findings.push({ severity: "error", category: "error", message: `Error: ${state.error.code} — ${state.error.message}` });
  }
  if (state.validation.some((v) => !v.passed)) {
    const failed = state.validation.filter((v) => !v.passed).map((v) => v.checkId);
    findings.push({ severity: "error", category: "validation", message: `Failed checks: ${failed.join(", ")}` });
  }

  // Four-eyes findings
  if (completeness.fourEyes.required && !completeness.fourEyes.satisfied) {
    if (completeness.fourEyes.decidedBy === null) {
      findings.push({
        severity: "warning",
        category: "four-eyes",
        message: "Four-eyes principle required but no review decision recorded yet",
      });
    } else {
      findings.push({
        severity: "error",
        category: "four-eyes",
        message: `Four-eyes principle VIOLATED: initiator (${completeness.fourEyes.initiatedBy}) and reviewer (${completeness.fourEyes.decidedBy}) are the same person`,
      });
    }
  }

  // Evidence completeness findings
  for (const slot of completeness.slots) {
    if (slot.status === "missing") {
      findings.push({
        severity: "warning",
        category: "completeness",
        message: `${slot.label} is missing (required at phase ${state.phase})`,
      });
    } else if (slot.status === "failed") {
      findings.push({
        severity: "error",
        category: "completeness",
        message: `${slot.label} has failed`,
      });
    }
  }

  // LLM findings (optional, additive)
  if (executors?.analyze) {
    const llmFindings = await executors.analyze(state);
    findings = [...findings, ...llmFindings];
  }

  // 4. Determine overall status
  const hasErrors = findings.some((f) => f.severity === "error");
  const hasWarnings = findings.some((f) => f.severity === "warning");
  const overallStatus = hasErrors ? "issues" : hasWarnings ? "warnings" : "clean";

  // 5. Build report
  return {
    schemaVersion: "flowguard-review-report.v1",
    sessionId: state.id,
    generatedAt: now,
    phase: state.phase,
    planDigest: state.plan?.current.digest ?? null,
    implDigest: state.implementation?.digest ?? null,
    validationSummary,
    findings,
    overallStatus,
    completeness,
  };
}
