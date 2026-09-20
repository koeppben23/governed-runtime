/**
 * @module integration/tools/status/status-full-response
 * @description Full flowguard_status response builder.
 *
 * Extracted from `status-tool.ts` along the full-status boundary: applied
 * policy/profile/evidence/implementation projections, discovery-health loading
 * and warnings, the governance-mandate block, and the build identity field.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import type { EvalResult } from '../../../machine/evaluate.js';
import type { CompletenessReport } from '../../../audit/completeness.js';
import { renderPhaseAwareMandates } from '../../../rendering/mandates-renderer.js';
import { readDiscovery } from '../../../adapters/persistence-discovery.js';
import {
  extractDiscoveryHealth,
  isDiscoveryHealthAvailable,
  unavailableDiscoveryHealth,
} from '../../../discovery/discovery-health.js';
import { classifyDiscoveryHealthUnavailable } from '../../discovery/discovery-health-loader.js';
import type { DiscoveryHealthProjection } from '../../../discovery/discovery-health.js';
import type { DiscoveryResult } from '../../../discovery/types.js';
import { getAdapterLogger } from '../../../logging/adapter-logger.js';
import type { PresentationRenderOptions } from '../../../presentation/glyph-profile.js';
import type { DiscoveryDriftStatusProjection } from '../../discovery/discovery-drift-status.js';
import { evaluateDiscoveryEvidenceGate } from '../../discovery/discovery-health-gate.js';
import { BUILD_INFO } from '../../../shared/build-info.js';
import { buildStatusDocument } from '../../status/status-presentation.js';
import { renderMarkdown } from '../../../presentation/index.js';
import { buildStatusProjection } from '../../status/status.js';
import { buildImplementationGuidance } from '../../implementation-guidance.js';
import type { ResolvedVerificationCandidate } from '../../verification-runtime-resolution.js';
import { computeProviderCapabilities } from './status-provider-projection.js';
import { latestReviewSummary } from './status-summary.js';
import { enrichWithWorkflowDirective } from '../helpers.js';

/**
 * Build identity for the governanceMandates block — surfaces the installed
 * plugin's version + git SHA at runtime so a stale installed dist (older than
 * source) is visible in /status. Null gitSha when no build-info is shipped
 * (dev/test running from source). Diagnostic only; never gates.
 */
export function buildIdentityField(): Record<string, unknown> {
  const info = BUILD_INFO();
  return {
    version: info?.version ?? null,
    gitSha: info?.gitSha ?? null,
    builtAt: info?.builtAt ?? null,
    source: info ? 'dist/build-info.json' : 'unavailable',
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

export interface FullStatusInput {
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

export async function loadDiscoveryStatusContext(wsDir: string): Promise<DiscoveryStatusContext> {
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
      assurance: state.reviewAssurance,
      obligationType: 'plan',
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
      assurance: state.reviewAssurance,
      obligationType: 'implement',
    }),
    latestArchitectureReview: latestReviewSummary(state.architecture?.reviewFindings ?? null, {
      includePlanVersion: true,
      ...(state.selfReview ? { hostIteration: state.selfReview.iteration } : {}),
      assurance: state.reviewAssurance,
      obligationType: 'architecture',
    }),
    architectureReviewCompletion: state.architecture?.reviewCompletion ?? null,
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

export function buildFullStatusResponse(input: FullStatusInput): string {
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
    ...(projection.remainingChecks ? { remainingChecks: projection.remainingChecks } : {}),
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
    archiveStatus: state.regulatedArchiveStatus ?? null,
    appliedPolicy: buildAppliedPolicyStatus(state),
    ...buildProfileStatus(state, discoveryHealth, input.runtimeCandidates),
    ...buildEvidenceStatus(state),
    ...buildImplementationStatus(state),
    evalKind: ev.kind,
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

  const enriched = enrichWithWorkflowDirective(responseObj, state);

  return JSON.stringify({
    ...enriched,
    presentation: { markdown: presentationMarkdown },
  });
}
