/**
 * @module integration/tools/status-tool
 * @description FlowGuard status tool — read-only session state check.
 *
 * Returns phase, evidence summary, policy info, completeness matrix,
 * and next action. Does NOT mutate state.
 *
 * Supports focused projections via optional boolean flags:
 * whyBlocked, evidence, context, readiness.
 *
 * @version v2 (extracted projection dispatch and full status builder)
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  resolveWorkspacePaths,
  withReadOnlySession,
  formatBlocked,
  formatError,
  formatEval,
  appendNextAction,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type { EvalResult } from '../../machine/evaluate.js';
import type { CompletenessReport } from '../../audit/completeness.js';
import { renderPhaseAwareMandates } from '../../templates/mandates-renderer.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import { extractDiscoveryHealth } from '../../discovery/discovery-health.js';
import type { DiscoveryHealthProjection } from '../../discovery/discovery-health.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

// State & Machine
import { evaluate } from '../../machine/evaluate.js';

// Adapters
import { ActorClaimError } from '../../adapters/actor.js';

// Config
import { evaluateCompleteness } from '../../audit/completeness.js';
import {
  buildStatusProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from '../status.js';

// ─── Projection dispatch ──────────────────────────────────────────────────────

interface StatusArgs {
  whyBlocked?: boolean;
  evidence?: boolean;
  context?: boolean;
  readiness?: boolean;
}

/**
 * Resolve a focused projection response, or null if no projection flag is set.
 */
function resolveProjection(
  args: StatusArgs,
  state: SessionState,
  policy: FlowGuardPolicy,
): string | null {
  if (args.whyBlocked) {
    const blocked = buildBlockedProjection(state, policy);
    return appendNextAction(
      JSON.stringify({ phase: state.phase, sessionId: state.id, whyBlocked: blocked }),
      state,
    );
  }
  if (args.evidence) {
    const evidenceDetail = buildEvidenceDetailProjection(state);
    return appendNextAction(
      JSON.stringify({ phase: state.phase, sessionId: state.id, evidence: evidenceDetail }),
      state,
    );
  }
  if (args.context) {
    const contextDetail = buildContextProjection(state);
    return appendNextAction(
      JSON.stringify({ phase: state.phase, sessionId: state.id, context: contextDetail }),
      state,
    );
  }
  if (args.readiness) {
    const readinessDetail = buildReadinessProjection(state, policy);
    return appendNextAction(
      JSON.stringify({ phase: state.phase, sessionId: state.id, readiness: readinessDetail }),
      state,
    );
  }
  return null;
}

// ─── Full status builder ──────────────────────────────────────────────────────

function latestReviewSummary(
  findings: ReadonlyArray<ReviewFindings> | null | undefined,
  opts: { includePlanVersion: boolean },
): Record<string, unknown> | null {
  if (!findings || findings.length === 0) return null;
  const latest = findings[findings.length - 1];
  if (!latest) return null;
  return {
    iteration: latest.iteration,
    ...(opts.includePlanVersion ? { planVersion: latest.planVersion } : {}),
    overallVerdict: latest.overallVerdict,
    blockingIssueCount: latest.blockingIssues.length,
    majorRiskCount: latest.majorRisks.length,
    missingVerificationCount: latest.missingVerification.length,
    reviewMode: latest.reviewMode,
    reviewedAt: latest.reviewedAt,
  };
}

function selfReviewConverged(state: SessionState): boolean | null {
  if (!state.selfReview) return null;
  return (
    state.selfReview.iteration >= state.selfReview.maxIterations ||
    (state.selfReview.revisionDelta === 'none' && state.selfReview.verdict === 'approve')
  );
}

function implReviewConverged(state: SessionState): boolean | null {
  if (!state.implReview) return null;
  return (
    state.implReview.iteration >= state.implReview.maxIterations ||
    (state.implReview.revisionDelta === 'none' && state.implReview.verdict === 'approve')
  );
}

function buildAppliedPolicyStatus(state: SessionState): Record<string, unknown> {
  const snapshot = state.policySnapshot;
  if (!snapshot) {
    return {
      source: 'unknown',
      requestedMode: 'unknown',
      effectiveMode: 'unknown',
      effectiveGateBehavior: 'unknown',
      degradedReason: null,
      resolutionReason: null,
      centralMinimumMode: null,
      centralPolicyDigest: null,
      centralPolicyVersion: null,
      centralPolicyPathHint: null,
    };
  }
  return {
    source: snapshot.source ?? 'unknown',
    requestedMode: snapshot.requestedMode ?? 'unknown',
    effectiveMode: snapshot.mode ?? 'unknown',
    effectiveGateBehavior: snapshot.effectiveGateBehavior ?? 'unknown',
    degradedReason: snapshot.degradedReason ?? null,
    resolutionReason: snapshot.resolutionReason ?? null,
    centralMinimumMode: snapshot.centralMinimumMode ?? null,
    centralPolicyDigest: snapshot.policyDigest ?? null,
    centralPolicyVersion: snapshot.policyVersion ?? null,
    centralPolicyPathHint: snapshot.policyPathHint ?? null,
  };
}

const DISCOVERY_HEALTH_INSTRUCTION = `\
## Discovery Health

Check flowguard_status.discoveryHealth when present. If healthy is false,
discovery was degraded — failedCollectorNames lists failed collectors.
Verification commands and stack detection may be incomplete. If
hasBudgetExhaustion is true, code-surface analysis was truncated. If
ageWarning is set, discovery data may be stale. Mark unsupported claims
as NOT_VERIFIED.`;

async function loadDiscoveryHealth(wsDir: string): Promise<DiscoveryHealthProjection | null> {
  try {
    const result = await readDiscovery(wsDir);
    if (!result) {
      getAdapterLogger().info(
        'discovery-health',
        'No discovery artifact available for health projection',
        {
          reason: 'discovery_artifact_missing',
        },
      );
      return null;
    }
    return extractDiscoveryHealth(result);
  } catch (error) {
    getAdapterLogger().warn(
      'discovery-health',
      'Failed to load discovery health projection for status',
      {
        reason: 'discovery_health_unavailable',
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

function buildProfileStatus(
  state: SessionState,
  discoveryHealth: DiscoveryHealthProjection | null,
): Record<string, unknown> {
  const base = state.activeProfile?.ruleContent ?? '';
  const phaseExtra = state.activeProfile?.phaseRuleContent?.[state.phase];
  let profileRules = phaseExtra ? base + '\n\n' + phaseExtra : base;

  if (discoveryHealth && !discoveryHealth.healthy) {
    const failed = discoveryHealth.failedCollectorNames;
    const warning =
      '\n\nWARNING: Discovery is degraded.' +
      ` ${discoveryHealth.failedCollectors} collector(s) failed` +
      (failed.length > 0 ? ` (${failed.join(', ')})` : '') +
      `, ${discoveryHealth.partialCollectors} partial. ` +
      `Verification candidates and stack data may be incomplete. ` +
      `Check flowguard_status.discoveryHealth.`;
    profileRules += warning;
  }

  profileRules += '\n\n' + DISCOVERY_HEALTH_INSTRUCTION;

  return {
    initiatedBy: state.initiatedBy,
    profileId: state.activeProfile?.id ?? 'none',
    profileName: state.activeProfile?.name ?? 'None',
    profileRules,
    detectedStack: state.detectedStack ?? null,
    verificationCandidates: state.verificationCandidates ?? [],
  };
}

function buildEvidenceStatus(state: SessionState): Record<string, unknown> {
  return {
    hasTicket: state.ticket !== null,
    hasPlan: state.plan !== null,
    planVersion: state.plan ? state.plan.history.length + 1 : 0,
    selfReviewIteration: state.selfReview?.iteration ?? null,
    selfReviewConverged: selfReviewConverged(state),
    latestReview: latestReviewSummary(state.plan?.reviewFindings ?? null, {
      includePlanVersion: true,
    }),
    validationResults: state.validation.map((v) => ({
      checkId: v.checkId,
      passed: v.passed,
      kind: v.kind,
      command: v.command,
      exitCode: v.exitCode,
      executionMs: v.executionMs,
      timedOut: v.timedOut,
    })),
  };
}

function buildImplementationStatus(state: SessionState): Record<string, unknown> {
  return {
    hasImplementation: state.implementation !== null,
    implReviewIteration: state.implReview?.iteration ?? null,
    implReviewConverged: implReviewConverged(state),
    latestImplementationReview: latestReviewSummary(state.implReviewFindings ?? null, {
      includePlanVersion: false,
    }),
    latestArchitectureReview: latestReviewSummary(state.architecture?.reviewFindings ?? null, {
      includePlanVersion: true,
    }),
    hasReviewDecision: state.reviewDecision !== null,
    reviewVerdict: state.reviewDecision?.verdict ?? null,
    error: state.error,
  };
}

function buildFullStatusResponse(
  state: SessionState,
  policy: FlowGuardPolicy,
  ev: EvalResult,
  completeness: CompletenessReport,
  discoveryHealth: DiscoveryHealthProjection | null,
): string {
  const projection = buildStatusProjection(state, policy);

  return appendNextAction(
    JSON.stringify({
      status: projection,
      phase: state.phase,
      sessionId: state.id,
      policyMode: state.policySnapshot?.mode ?? 'unknown',
      discoveryHealth: discoveryHealth ?? null,
      archiveStatus: state.archiveStatus ?? null,
      appliedPolicy: buildAppliedPolicyStatus(state),
      ...buildProfileStatus(state, discoveryHealth),
      ...buildEvidenceStatus(state),
      ...buildImplementationStatus(state),
      evalKind: ev.kind,
      next: formatEval(ev),
      completeness: {
        overallComplete: completeness.overallComplete,
        fourEyes: completeness.fourEyes,
        summary: completeness.summary,
      },
      governanceMandates: {
        source: 'src/templates/mandates.ts',
        projection: 'phase-aware',
        mandatesVerbosity: 'explicit',
        renderFallbackIsPromptSafetyOnly: true,
        runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence: true,
        phaseRelevantRules: renderPhaseAwareMandates({}, state.phase),
      },
    }),
    state,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_status — Read-Only State Check
// ═══════════════════════════════════════════════════════════════════════════════

export const status: ToolDefinition = {
  description:
    'Read the current FlowGuard session state. Returns phase, evidence summary, ' +
    'policy info, completeness matrix, and next action. ' +
    'Does NOT mutate state. Use /status to inspect session state or debug blockers. ' +
    'Use /continue for deterministic next-action routing (tells you which command to run next).',
  args: {
    whyBlocked: z
      .boolean()
      .optional()
      .describe('Return focused blocker surface from the state machine evaluator.'),
    evidence: z
      .boolean()
      .optional()
      .describe('Return per-slot evidence detail from the session completeness check.'),
    context: z.boolean().optional().describe('Return actor/policy/archive context projection.'),
    readiness: z.boolean().optional().describe('Return compact operational readiness projection.'),
  },
  async execute(_args, context) {
    try {
      const { wsDir } = await resolveWorkspacePaths(context);
      const { state, policy } = await withReadOnlySession(context);

      if (!state) {
        return JSON.stringify({
          phase: null,
          status: 'No FlowGuard session found.',
          discoveryHealth: null,
          next: 'Run /hydrate to bootstrap a session.',
          governanceMandates: {
            source: 'src/templates/mandates.ts',
            projection: 'none-without-canonical-session-state',
            mandatesVerbosity: 'explicit',
            renderFallbackIsPromptSafetyOnly: true,
            runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence: true,
          },
        });
      }

      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);
      const args = _args as StatusArgs;

      const projection = resolveProjection(args, state, policy);
      if (projection !== null) return projection;

      const discoveryHealth = await loadDiscoveryHealth(wsDir);
      return buildFullStatusResponse(state, policy, ev, completeness, discoveryHealth);
    } catch (err) {
      if (err instanceof ActorClaimError) {
        return formatBlocked(err.code);
      }
      return formatError(err);
    }
  },
};
