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
  enrichWithNextAction,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';
import { authorizedCriticalPlanClaimIds } from '../../state/proofgraph-approval.js';
import { resolveRuntimeReadiness } from '../verification-runtime-resolution.js';
import { ProcessProbeRunner } from '../../verification/toolchain-probe.js';
import { computeProviderCapabilities } from './status-provider-projection.js';
import { wrapForResolution } from '../verification-runtime-resolution.js';
import type { ResolvedVerificationCandidate } from '../verification-runtime-resolution.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type { EvalResult } from '../../machine/evaluate.js';
import type { CompletenessReport } from '../../audit/completeness.js';
import { renderPhaseAwareMandates } from '../../rendering/mandates-renderer.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import {
  extractDiscoveryHealth,
  isDiscoveryHealthAvailable,
  unavailableDiscoveryHealth,
  classifyDiscoveryHealthUnavailable,
} from '../../discovery/discovery-health.js';
import type { DiscoveryHealthProjection } from '../../discovery/discovery-health.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { readReport } from '../../adapters/persistence.js';
import { readConfig } from '../../adapters/persistence-config.js';
import type { PresentationRenderOptions } from '../../presentation/glyph-profile.js';

// State & Machine
import { evaluate } from '../../machine/evaluate.js';

// Adapters
import { ActorClaimError } from '../../adapters/actor.js';

// Config
import { evaluateCompleteness } from '../../audit/completeness.js';
import {
  summarizePersistedProofGraph,
  summarizeProofGraph,
} from '../../audit/proofgraph/summary.js';
import {
  evaluateStructuralSurfaces,
  bindStructuralEvidence,
  surfaceDigestMap,
} from '../proofgraph/structural-provider.js';
import {
  loadMutationReport,
  evaluateMutationProfiles,
  resolveVerifiedMutationVerdicts,
} from '../proofgraph/mutation-provider.js';
import { bindMutationEvidence } from '../../audit/proofgraph/mutation-binder.js';
import { checkRegistrationConsistency } from '../proofgraph/registration-consistency.js';
import { checkConfigDefaultConsistency } from '../proofgraph/config-default-consistency.js';
import { evaluateProofGraphGate } from '../../audit/proofgraph/gate.js';
import { buildProofApprovalProjection } from '../proofgraph/approval-projection.js';
import {
  buildStatusProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from '../status.js';
import { buildFinishCard } from '../status-finish.js';
import {
  buildWhyPresentationProjection,
  buildFinishPresentationProjection,
} from '../status-why-finish.js';
import { buildImplementationGuidance } from '../implementation-guidance.js';
import type { DiscoveryDriftStatusProjection } from '../discovery-drift-status.js';
import { buildDiscoveryDriftStatus } from '../discovery-drift-status.js';
import { evaluateDiscoveryEvidenceGate } from '../discovery-health-gate.js';
import { BUILD_INFO } from '../../shared/build-info.js';
import { buildStatusDocument, buildNoSessionDocument } from '../status-presentation.js';
import { buildWhyDocument } from '../why-presentation.js';
import { buildFinishDocument } from '../finish-presentation.js';
import { renderMarkdown } from '../../presentation/index.js';

/**
 * Build identity for the governanceMandates block — surfaces the installed
 * plugin's version + git SHA at runtime so a stale installed dist (older than
 * source) is visible in /status. Null gitSha when no build-info is shipped
 * (dev/test running from source). Diagnostic only; never gates.
 */
function buildIdentityField(): Record<string, unknown> {
  const info = BUILD_INFO();
  return {
    version: info?.version ?? null,
    gitSha: info?.gitSha ?? null,
    builtAt: info?.builtAt ?? null,
    source: info ? 'dist/build-info.json' : 'unavailable',
  };
}

// ─── Projection dispatch ──────────────────────────────────────────────────────

interface StatusArgs {
  whyBlocked?: boolean;
  evidence?: boolean;
  context?: boolean;
  readiness?: boolean;
  finish?: boolean;
  proofGraph?: boolean;
}

/**
 * Cheap, SessionState-derived verification-check fields that the /check,
 * /validate, and /implement command prompts read to decide whether to run
 * flowguard_run_check. These are included in EVERY focused projection (not just
 * the full projection) because a focused status call (e.g. whyBlocked:true) must
 * not silently strip the exact fields those prompts gate on — otherwise a
 * VALIDATION session looks like it has "no active checks" and can never advance.
 *
 * Intentionally excludes the EXPENSIVE full-only fields (discoveryHealth,
 * discoveryDrift, implementationGuidance, detectedStack) which require reading
 * the persisted discovery artifact; those stay full-projection-only.
 *
 * `remainingChecks` mirrors the gate in buildStatusProjection (status.ts).
 * Both `activeChecks` and `remainingChecks` are surfaced so command prompts
 * referencing either name resolve.
 */
function buildCheckProjectionFields(state: SessionState): Record<string, unknown> {
  const remainingChecks =
    state.phase === 'VALIDATION' && state.activeChecks.length > 0
      ? state.activeChecks.filter((id) => !state.validation.some((v) => v.checkId === id))
      : undefined;
  return {
    activeChecks: state.activeChecks,
    verificationCandidates: state.verificationCandidates ?? [],
    ...(remainingChecks !== undefined ? { remainingChecks } : {}),
  };
}

/**
 * Build the focused, read-only ProofGraph projection response (advisory).
 * Never approves or gates; surfaces claim states, freshness, and critical gaps.
 */
async function buildProofGraphProjectionResponse(
  state: SessionState,
  policy: FlowGuardPolicy,
  checkFields: Record<string, unknown>,
): Promise<string> {
  const now = new Date().toISOString();
  const structuralSurfaces = evaluateStructuralSurfaces();
  // Profile summaries for the reviewer projection come from the default report;
  // claim-binding verdicts come ONLY from per-attempt digest-verified reports.
  const mutationReport = await loadMutationReport(state.binding.worktree);
  const mutationSummaries = evaluateMutationProfiles(mutationReport);
  const mutationVerdicts = await resolveVerifiedMutationVerdicts(
    state.binding.worktree,
    state.mutationAttempts,
  );
  const proofGraph = summarizeProofGraph(state, now, {
    providerResults: [
      ...bindStructuralEvidence(state, structuralSurfaces, now),
      ...bindMutationEvidence(state, mutationVerdicts, now),
    ],
    surfaceDigests: surfaceDigestMap(structuralSurfaces),
    mutationSummaries,
  });
  const proofGraphGate = evaluateProofGraphGate({
    projection: proofGraph.projection,
    authorizedCriticalClaimIds: authorizedCriticalPlanClaimIds(state.plan),
    implementationDigest: state.implementation?.digest,
    riskAssessment: state.implementationRiskAssessment,
    claimDiagnostics: proofGraph.claimDiagnostics,
  });
  const registrationConsistency = checkRegistrationConsistency();
  const configConsistency = checkConfigDefaultConsistency();
  return appendNextAction(
    JSON.stringify({
      phase: state.phase,
      sessionId: state.id,
      proofGraph,
      persistedProofGraph: summarizePersistedProofGraph(state),
      proofApprovals: buildProofApprovalProjection(state),
      proofGraphGate,
      registrationConsistency,
      configConsistency,
      ...checkFields,
    }),
    state,
  );
}

/**
 * Resolve a focused projection response, or null if no projection flag is set.
 */
interface ResolveProjectionInput {
  readonly args: StatusArgs;
  readonly state: SessionState;
  readonly policy: FlowGuardPolicy;
  readonly sessDir: string;
  readonly presentation: PresentationRenderOptions;
}

async function resolveProjection(input: ResolveProjectionInput): Promise<string | null> {
  const { args, state, policy, sessDir, presentation } = input;
  const checkFields = buildCheckProjectionFields(state);
  // /finish is the most comprehensive focused projection and is placed first so
  // its own template call is never shadowed by a stray additional flag. This
  // preserves the existing first-match dispatch semantics for all other flags.
  if (args.finish) {
    const reviewReport = await readReport(sessDir);
    const finishCard = buildFinishCard(state, policy, reviewReport);
    const finishPres = buildFinishPresentationProjection(state, finishCard);
    const finishDoc = buildFinishDocument(finishPres);
    return appendNextAction(
      JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        finish: finishCard,
        ...checkFields,
        presentation: { markdown: renderMarkdown(finishDoc, presentation) },
      }),
      state,
    );
  }
  if (args.whyBlocked) {
    const blocked = buildBlockedProjection(state, policy);
    const whyPres = buildWhyPresentationProjection(state, policy, blocked);
    const whyDoc = buildWhyDocument(whyPres);
    return appendNextAction(
      JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        whyBlocked: blocked,
        ...checkFields,
        presentation: { markdown: renderMarkdown(whyDoc, presentation) },
      }),
      state,
    );
  }
  if (args.evidence) {
    const evidenceDetail = buildEvidenceDetailProjection(state);
    return appendNextAction(
      JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        evidence: evidenceDetail,
        ...checkFields,
      }),
      state,
    );
  }
  if (args.context) {
    const contextDetail = buildContextProjection(state);
    return appendNextAction(
      JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        context: contextDetail,
        ...checkFields,
      }),
      state,
    );
  }
  if (args.readiness) {
    const readinessDetail = buildReadinessProjection(state, policy);
    return appendNextAction(
      JSON.stringify({
        phase: state.phase,
        sessionId: state.id,
        readiness: readinessDetail,
        ...checkFields,
      }),
      state,
    );
  }
  if (args.proofGraph) {
    return await buildProofGraphProjectionResponse(state, policy, checkFields);
  }
  return null;
}

// ─── Full status builder ──────────────────────────────────────────────────────

function latestReviewSummary(
  findings: ReadonlyArray<ReviewFindings> | null | undefined,
  opts: { includePlanVersion: boolean; hostIteration?: number },
): Record<string, unknown> | null {
  if (!findings || findings.length === 0) return null;
  const latest = findings.at(-1);
  if (!latest) return null;
  return {
    iteration: opts.hostIteration ?? latest.iteration,
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
    (state.selfReview.revisionDelta === 'none' && state.selfReview.verdict === 'accept')
  );
}

function implReviewConverged(state: SessionState): boolean | null {
  if (!state.implReview) return null;
  return (
    state.implReview.iteration >= state.implReview.maxIterations ||
    (state.implReview.revisionDelta === 'none' && state.implReview.verdict === 'accept')
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
    discoveryHealth: snapshot.discoveryHealth,
  };
}

/**
 * Read-only projection of the persisted Discovery-health gate (#399).
 * Status NEVER clears or mutates the gate; it only reports it.
 *
 * Exported for targeted read-only/no-mutation tests.
 */
export function buildDiscoveryHealthGateStatus(
  state: SessionState,
): Record<string, unknown> | null {
  const gate = state.discoveryHealthGate;
  if (!gate) return null;
  if (gate.status === 'blocked') {
    return {
      status: 'blocked',
      code: gate.code,
      message: gate.message,
      blockedAt: gate.blockedAt,
      lastDriftAssessment: gate.lastDriftAssessment ?? null,
    };
  }
  return {
    status: 'clear',
    clearedAt: gate.clearedAt ?? null,
    lastDriftAssessment: gate.lastDriftAssessment ?? null,
  };
}

const DISCOVERY_HEALTH_INSTRUCTION = `\
## Discovery Health

Check flowguard_status.discoveryHealth when present. If healthy is false,
discovery was degraded or unavailable. If status is unavailable, inspect
reason and recovery, mark discovery-dependent claims NOT_VERIFIED, and
re-run /hydrate where appropriate. Do not treat unavailable discovery as
healthy or as a hard block unless policy explicitly requires it. For
available degraded discovery, failedCollectorNames lists failed collectors.
Verification commands and stack detection may be incomplete. If
hasBudgetExhaustion is true, code-surface analysis was truncated. If
ageWarning is set, discovery data may be stale. Mark unsupported claims
as NOT_VERIFIED.`;

const IMPLEMENTATION_GUIDANCE_INSTRUCTION = `\
## Implementation Guidance

For full flowguard_status responses, inspect implementationGuidance when present.
It is advisory, runtime-only, and never overrides phase gates, policy gates,
review obligations, validation requirements, or the approved plan. Treat low
confidence, missing discovery, or degraded discovery as NOT_VERIFIED.`;

const DISCOVERY_DRIFT_INSTRUCTION = `\
## Discovery Drift

For full flowguard_status responses, inspect discoveryDrift when present.
It is advisory, read-only, and separate from discoveryHealth.ageWarning.
Timeout or unavailable drift status means repository drift is NOT_VERIFIED.`;

interface DiscoveryStatusContext {
  readonly discovery: DiscoveryResult | null;
  readonly discoveryHealth: DiscoveryHealthProjection | null;
}

interface FullStatusInput {
  readonly state: SessionState;
  readonly policy: FlowGuardPolicy;
  readonly ev: EvalResult;
  readonly completeness: CompletenessReport;
  readonly discovery: DiscoveryResult | null;
  readonly discoveryHealth: DiscoveryHealthProjection | null;
  readonly discoveryDrift: DiscoveryDriftStatusProjection;
  readonly presentation: PresentationRenderOptions;
  readonly runtimeCandidates?: readonly ResolvedVerificationCandidate[];
}

async function loadDiscoveryStatusContext(wsDir: string): Promise<DiscoveryStatusContext> {
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
      return { discovery: null, discoveryHealth: unavailableDiscoveryHealth('missing') };
    }
    return { discovery: result, discoveryHealth: extractDiscoveryHealth(result) };
  } catch (error) {
    const reason = classifyDiscoveryHealthUnavailable(error);
    getAdapterLogger().warn(
      'discovery-health',
      'Failed to load discovery health projection for status',
      {
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { discovery: null, discoveryHealth: unavailableDiscoveryHealth(reason) };
  }
}

function buildProfileStatus(
  state: SessionState,
  discoveryHealth: DiscoveryHealthProjection | null,
  runtimeCandidates?: readonly ResolvedVerificationCandidate[],
): Record<string, unknown> {
  const base = state.activeProfile?.ruleContent ?? '';
  const phaseExtra = state.activeProfile?.phaseRuleContent?.[state.phase];
  const profileRules = [
    phaseExtra ? base + '\n\n' + phaseExtra : base,
    discoveryDegradationWarning(discoveryHealth),
    DISCOVERY_HEALTH_INSTRUCTION,
    IMPLEMENTATION_GUIDANCE_INSTRUCTION,
    DISCOVERY_DRIFT_INSTRUCTION,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    initiatedBy: state.initiatedBy,
    profileId: state.activeProfile?.id ?? 'none',
    profileName: state.activeProfile?.name ?? 'None',
    profileRules,
    detectedStack: state.detectedStack ?? null,
    activeChecks: state.activeChecks,
    verificationCandidates: state.verificationCandidates ?? [],
    providerCapabilities: computeProviderCapabilities(state, runtimeCandidates),
  };
}

function discoveryDegradationWarning(discoveryHealth: DiscoveryHealthProjection | null): string {
  if (!discoveryHealth || discoveryHealth.healthy) return '';
  if (!isDiscoveryHealthAvailable(discoveryHealth)) {
    return (
      'WARNING: Discovery health is unavailable.' +
      ` Reason: ${discoveryHealth.reason}. ` +
      `${discoveryHealth.recovery} ` +
      'Mark discovery-dependent claims NOT_VERIFIED.'
    );
  }
  const failed = discoveryHealth.failedCollectorNames;
  return (
    'WARNING: Discovery is degraded.' +
    ` ${discoveryHealth.failedCollectors} collector(s) failed` +
    (failed.length > 0 ? ` (${failed.join(', ')})` : '') +
    `, ${discoveryHealth.partialCollectors} partial. ` +
    `Verification candidates and stack data may be incomplete. ` +
    `Check flowguard_status.discoveryHealth.`
  );
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
      derivedRepairGuidance: v.derivedRepairGuidance ?? null,
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
      hostIteration: state.selfReview?.iteration,
    }),
    hasReviewDecision: state.reviewDecision !== null,
    reviewVerdict: state.reviewDecision?.verdict ?? null,
    challengeResolutions: state.challengeResolutions
      .filter((resolution) => resolution.implementationDigest === state.implementation?.digest)
      .map((resolution) => ({
        ...resolution,
        advisory:
          'NOT_VERIFIED until a subsequent independent ReviewFindings verdict resolves the challenge.',
      })),
    error: state.error,
  };
}

function buildFullStatusResponse(input: FullStatusInput): string {
  const {
    state,
    policy,
    ev,
    completeness,
    discovery,
    discoveryHealth,
    discoveryDrift,
    presentation,
  } = input;
  const projection = buildStatusProjection(state, policy);
  const implementationGuidance = buildImplementationGuidance({
    state,
    discovery,
    discoveryHealth,
  });

  const presentationDoc = buildStatusDocument({
    status: projection,
    discoveryHealth: discoveryHealth ?? null,
    discoveryDrift,
    remainingChecks: projection.remainingChecks,
  });
  const presentationMarkdown = renderMarkdown(presentationDoc, presentation);

  const responseObj = {
    status: projection,
    phase: state.phase,
    sessionId: state.id,
    remainingChecks: projection.remainingChecks,
    policyMode: state.policySnapshot?.mode ?? 'unknown',
    discoveryHealth: discoveryHealth ?? null,
    discoveryHealthGate: buildDiscoveryHealthGateStatus(state),
    discoveryEvidenceGate: evaluateDiscoveryEvidenceGate(
      state.policySnapshot.discoveryHealth,
      discoveryHealth ?? unavailableDiscoveryHealth('missing'),
      discoveryDrift.status,
    ),
    discoveryDrift,
    implementationGuidance,
    archiveStatus: state.archiveStatus ?? null,
    appliedPolicy: buildAppliedPolicyStatus(state),
    ...buildProfileStatus(state, discoveryHealth, input.runtimeCandidates),
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
    build: buildIdentityField(),
  };

  const enriched = enrichWithNextAction(responseObj, state);

  return JSON.stringify({
    ...enriched,
    presentation: { markdown: presentationMarkdown },
  });
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
    finish: z
      .boolean()
      .optional()
      .describe(
        'Return the read-only Finish Card: overall status, readiness, evidence, ' +
          'non-normative action guidance, and exit options. Never approves or mutates.',
      ),
    proofGraph: z
      .boolean()
      .optional()
      .describe(
        'Return the advisory ProofGraph summary: per-claim verification states, ' +
          'freshness, and critical gaps. Read-only; never approves or gates.',
      ),
  },
  async execute(_args, context) {
    try {
      const { wsDir } = await resolveWorkspacePaths(context);
      const presentation: PresentationRenderOptions = {
        glyphProfile: (await readConfig(wsDir)).presentation.opencode.glyphProfile,
      };
      const { state, policy, sessDir } = await withReadOnlySession(context);

      if (!state) {
        const noSessionDoc = buildNoSessionDocument();
        return JSON.stringify({
          phase: null,
          status: 'No FlowGuard session found.',
          discoveryHealth: null,
          discoveryDrift: null,
          next: 'Run /start to bootstrap a session.',
          governanceMandates: {
            source: 'src/templates/mandates.ts',
            projection: 'none-without-canonical-session-state',
            mandatesVerbosity: 'explicit',
            renderFallbackIsPromptSafetyOnly: true,
            runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence: true,
          },
          build: buildIdentityField(),
          presentation: { markdown: renderMarkdown(noSessionDoc, presentation) },
        });
      }

      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);
      const args = _args as StatusArgs;

      // Resolve runtime readiness via toolchain probes
      const probeRunner = new ProcessProbeRunner();
      const runtimeCandidates = await resolveRuntimeReadiness(
        wrapForResolution(state.verificationCandidates ?? []),
        probeRunner,
        state.binding.worktree,
      );

      const projection = await resolveProjection({
        args,
        state,
        policy,
        sessDir,
        presentation,
      });
      if (projection !== null) return projection;

      const { discovery, discoveryHealth } = await loadDiscoveryStatusContext(wsDir);
      const discoveryDrift = await buildDiscoveryDriftStatus({
        workspaceDir: wsDir,
        worktree: state.binding.worktree,
        fingerprint: state.binding.fingerprint,
      });
      return buildFullStatusResponse({
        state,
        policy,
        ev,
        completeness,
        discovery,
        discoveryHealth,
        discoveryDrift,
        presentation,
        runtimeCandidates,
      });
    } catch (err) {
      if (err instanceof ActorClaimError) {
        return formatBlocked(err.code);
      }
      return formatError(err);
    }
  },
};
