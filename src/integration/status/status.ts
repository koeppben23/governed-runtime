/**
 * @module integration/status/status
 * @description Status projection — pure SSOT-aligned view of canonical runtime truth.
 *
 * Design principle (FlowGuard Agent Rule):
 *   "Status surfaces must be projections of canonical runtime truth,
 *    never an independent interpretation layer."
 *
 * This module is the ONLY place that builds the unified StatusProjection.
 * All consumers (tools, helpers, reporters) MUST use buildStatusProjection().
 * No drift — if the projection changes, only this file changes.
 *
 * Source of truth for each field:
 * - phase              → state.phase
 * - allowedCommands    → isCommandAllowed() for each known command
 * - directive          → resolveWorkflowDirective()
 * - blocker           → evaluate() waiting/pending reason
 * - evidenceSummary    → evaluateCompleteness()
 * - policyMode         → state.policySnapshot?.mode ?? 'unknown'
 * - actor              → state.actorInfo
 * - archiveStatus      → state.regulatedArchiveStatus
 *
 * The projection contracts live in status-types.ts and the per-flag detail
 * surfaces (--evidence, --why-blocked, --context, --readiness) in
 * status-detail-projections.ts.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type { KnownPresentationStatusInput } from '../../presentation/labels.js';
import { evaluate } from '../../machine/evaluate.js';
import { allValidationsPassed, implValidationPassed } from '../../machine/guards.js';
import {
  resolveExecutionDisposition,
  resolveWorkflowDirective,
} from '../../machine/workflow-directive.js';
import {
  isCommandAllowed,
  Command,
  type Command as FlowGuardCommand,
} from '../../machine/commands.js';
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { evaluateCompleteness } from '../../audit/completeness.js';
import { getReviewLoopProgress } from '../review/review-loop-progress.js';
import { projectStatusConclusion } from './status-conclusion.js';
import { summarizePersistedProofGraph } from '../../audit/proofgraph/summary.js';
import { buildProofApprovalProjection } from '../proofgraph/approval-projection.js';
import { projectProofStatusForState } from '../proofgraph/proof-summary-projectors.js';
import { projectOpenImplementationChallengeIds } from '../../state/implementation-review-findings.js';
import type { StatusProjection } from './status-types.js';
import { proofGraphGateRegistryCode } from './status-detail-projections.js';

const ALL_COMMANDS = Object.values(Command) as FlowGuardCommand[];

// ─── Projection Builder ───────────────────────────────────────────────────────

/**
 * Build a StatusProjection purely from canonical runtime truth.
 *
 * This is the ONLY function that constructs StatusProjection.
 * No new logic — only projection from existing SSOT sources.
 *
 * @param state - Current session state.
 * @param policy - Resolved FlowGuard policy (from state or default).
 * @returns Structured status projection.
 */
function buildLastExport(state: SessionState): StatusProjection['lastExport'] {
  return {
    packagePurpose: state.lastExportPackagePurpose ?? null,
    integrityCapability: state.lastExportIntegrityCapability ?? null,
    verificationStatus: state.lastExportVerificationStatus ?? null,
  };
}

function remainingValidationChecks(state: SessionState): string[] | undefined {
  if (
    (state.phase !== 'VALIDATION' && state.phase !== 'IMPL_VALIDATION') ||
    state.activeChecks.length === 0
  )
    return undefined;
  const results = state.phase === 'VALIDATION' ? state.validation : state.implValidation;
  const passed =
    state.phase === 'VALIDATION' ? allValidationsPassed(state) : implValidationPassed(state);
  if (passed) return [];
  return state.activeChecks.filter((id) => !results.some((v) => v.checkId === id && v.passed));
}

function projectImplementationReworkIssues(
  findings: ReviewFindings | undefined,
): Pick<
  NonNullable<StatusProjection['implementationRework']>,
  'iteration' | 'blockingIssues' | 'majorRisks' | 'missingVerification' | 'scopeCreep' | 'unknowns'
> {
  if (!findings) {
    return {
      iteration: null,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
    };
  }
  return {
    iteration: findings.iteration,
    blockingIssues: findings.blockingIssues,
    majorRisks: findings.majorRisks,
    missingVerification: findings.missingVerification,
    scopeCreep: findings.scopeCreep,
    unknowns: findings.unknowns,
  };
}

function projectImplementationRework(
  state: SessionState,
): StatusProjection['implementationRework'] {
  const marker = state.implementationRework;
  if (!marker) return null;
  const findings = [...(state.implReviewFindings ?? [])]
    .reverse()
    .find((item) => item.overallVerdict === 'changes_requested');
  return {
    rejectedDigest: marker.rejectedDigest,
    ...projectImplementationReworkIssues(findings),
    openChallengeIds: projectOpenImplementationChallengeIds(state.implReviewFindings),
  };
}

export function buildStatusProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): StatusProjection {
  const completeness = evaluateCompleteness(state);
  const directive = resolveWorkflowDirective(state);
  const allowed = ALL_COMMANDS.filter((cmd: FlowGuardCommand) =>
    isCommandAllowed(state.phase, cmd),
  );
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });

  const blocker = buildBlocker(evalResult, state);
  const policyMode = state.policySnapshot?.mode ?? 'unknown';
  const profileId = state.activeProfile?.id ?? 'none';

  const actor = state.actorInfo
    ? {
        id: state.actorInfo.id,
        source: state.actorInfo.source,
        assurance: state.actorInfo.assurance,
      }
    : null;

  return {
    phase: state.phase,
    phaseLabel: PHASE_LABELS[state.phase],
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: state.binding.hostSessionId,
    policyMode,
    profileId,
    actor,
    archiveStatus: state.regulatedArchiveStatus ?? null,
    lastExport: buildLastExport(state),
    allowedCommands: allowed.map((cmd: FlowGuardCommand) => `/${cmd}`),
    executionDisposition: resolveExecutionDisposition(state),
    directive,
    blocker,
    evidenceSummary: {
      present: completeness.summary.complete,
      missing: completeness.summary.missing,
      notYetRequired: completeness.summary.notYetRequired,
      failed: completeness.summary.failed,
    },
    proofGraph: summarizePersistedProofGraph(state),
    proofSummary: projectProofStatusForState(state),
    proofApprovals: buildProofApprovalProjection(state),
    reviewLoop: getReviewLoopProgress(state),
    implementationRework: projectImplementationRework(state),
    remainingChecks: remainingValidationChecks(state),
    conclusion: projectStatusConclusion(evalResult, directive),
    readiness: deriveReadinessField(evalResult, completeness),
  };
}

// ─── Readiness Derivation ──────────────────────────────────────────────────────

/** Canonical readiness for StatusProjection — computed upstream, never in presentation. */
function deriveReadinessField(
  evalResult: ReturnType<typeof evaluate>,
  completeness: ReturnType<typeof evaluateCompleteness>,
): KnownPresentationStatusInput {
  if (evalResult.kind === 'waiting') return 'BLOCKED';
  if (completeness.summary.missing > 0 || completeness.summary.failed > 0) return 'NOT_VERIFIED';
  if (evalResult.kind === 'pending') return 'IN_PROGRESS';
  return 'READY';
}

// ─── Blocker Extraction ───────────────────────────────────────────────────────

/**
 * Extract blocker from an EvalResult.
 *
 * The blocker surface mirrors the EvalResult semantics used for
 * human-facing guidance. This is the same truth that feeds the
 * structured `directive` — no new blocker logic is invented here.
 *
 * At EVIDENCE_REVIEW the waiting blocker carries the registered reason code
 * of the ProofGraph gate that the review-decision rail enforces (mirrors the
 * rail inputs via evaluateProofGraphGateFromState), so the status surface can
 * project the migrated human copy for the gate.
 */
function buildBlocker(
  evalResult: ReturnType<typeof evaluate>,
  state: SessionState,
): StatusProjection['blocker'] {
  switch (evalResult.kind) {
    case 'waiting':
      return {
        reasonCode: proofGraphGateRegistryCode(state),
        reasonText: evalResult.reason,
      };
    case 'pending':
      // No structured code or text in canonical EvalPending
      return {
        reasonCode: null,
        reasonText: null,
      };
    case 'terminal':
    case 'transition':
      return null;
  }
}
