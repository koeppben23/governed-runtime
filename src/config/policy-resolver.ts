/**
 * @module config/policy-resolver
 * @description Runtime and hydrate-time policy resolution authority.
 */

import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type {
  EffectiveGateBehavior,
  CentralPolicyEvidence,
  DiscoveryHealthPolicy,
  FlowGuardPolicy,
  HydratePolicyResolution,
  PolicyDegradedReason,
  PolicyMode,
  PolicySource,
} from './policy-types.js';
import { PolicyConfigurationError } from './policy-errors.js';
import { detectCiContext } from './policy-ci.js';
import { loadCentralPolicyEvidence, modeStrength } from './policy-central.js';
import { getPolicyPreset, TEAM_CI_POLICY } from './policy-presets.js';
import { normalizePolicyMode } from './policy-presets.js';

/** Detailed policy resolution result (requested vs effective). */
export interface PolicyResolution {
  readonly requestedMode: PolicyMode;
  readonly effectiveMode: PolicyMode;
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly degradedReason?: PolicyDegradedReason;
  readonly policy: FlowGuardPolicy;
}

export interface HydratePolicyOptions {
  explicitMode?: PolicyMode;
  repoMode?: PolicyMode;
  defaultMode: PolicyMode;
  ciContext: boolean;
  centralPolicyPath?: string;
  digestFn: (text: string) => string;
  readFileFn?: (path: string) => Promise<string>;
  configMaxSelfReviewIterations?: number;
  configMaxImplReviewIterations?: number;
  configMinimumActorAssuranceForApproval?: 'best_effort' | 'claim_validated' | 'idp_verified';
  configRequireVerifiedActorsForApproval?: boolean;
  configIdentityProvider?: IdpConfig;
  configIdentityProviderMode?: IdentityProviderMode;
  configEnforceRiskClassification?: boolean;
  configAllowRiskDowngradeOverride?: boolean;
  configAllowReducedCeremony?: boolean;
  configDiscoveryHealth?: Partial<DiscoveryHealthPolicy>;
}

interface RequestedPolicyContext {
  readonly requestedMode: PolicyMode;
  readonly requestedSource: Exclude<PolicySource, 'central'>;
  readonly requestedResolution: PolicyResolution;
  readonly policyWithOverrides: FlowGuardPolicy;
}

/** Apply user-level config overrides (iteration limits, assurance, IdP) to a base policy. */
function applyConfigOverrides(
  basePolicy: FlowGuardPolicy,
  opts: {
    configMaxSelfReviewIterations?: number;
    configMaxImplReviewIterations?: number;
    configMinimumActorAssuranceForApproval?: 'best_effort' | 'claim_validated' | 'idp_verified';
    configRequireVerifiedActorsForApproval?: boolean;
    configIdentityProvider?: IdpConfig;
    configIdentityProviderMode?: IdentityProviderMode;
    configEnforceRiskClassification?: boolean;
    configAllowRiskDowngradeOverride?: boolean;
    configAllowReducedCeremony?: boolean;
    configDiscoveryHealth?: Partial<DiscoveryHealthPolicy>;
  },
): FlowGuardPolicy {
  return {
    ...basePolicy,
    maxSelfReviewIterations:
      opts.configMaxSelfReviewIterations ?? basePolicy.maxSelfReviewIterations,
    maxImplReviewIterations:
      opts.configMaxImplReviewIterations ?? basePolicy.maxImplReviewIterations,
    minimumActorAssuranceForApproval:
      opts.configMinimumActorAssuranceForApproval ??
      (opts.configRequireVerifiedActorsForApproval === true ? 'claim_validated' : undefined) ??
      basePolicy.minimumActorAssuranceForApproval,
    requireVerifiedActorsForApproval:
      opts.configRequireVerifiedActorsForApproval ?? basePolicy.requireVerifiedActorsForApproval,
    identityProvider: opts.configIdentityProvider ?? basePolicy.identityProvider,
    identityProviderMode: opts.configIdentityProviderMode ?? basePolicy.identityProviderMode,
    enforceRiskClassification:
      opts.configEnforceRiskClassification ?? basePolicy.enforceRiskClassification,
    allowRiskDowngradeOverride:
      opts.configAllowRiskDowngradeOverride ?? basePolicy.allowRiskDowngradeOverride,
    allowReducedCeremony: opts.configAllowReducedCeremony ?? basePolicy.allowReducedCeremony,
    discoveryHealth: {
      enforcement:
        opts.configDiscoveryHealth?.enforcement ?? basePolicy.discoveryHealth.enforcement,
      onDegraded: opts.configDiscoveryHealth?.onDegraded ?? basePolicy.discoveryHealth.onDegraded,
      onDrift: opts.configDiscoveryHealth?.onDrift ?? basePolicy.discoveryHealth.onDrift,
    },
  };
}

function resolveRequestedPolicy(opts: HydratePolicyOptions): RequestedPolicyContext {
  const requestedSource: Exclude<PolicySource, 'central'> = opts.explicitMode
    ? 'explicit'
    : opts.repoMode
      ? 'repo'
      : 'default';
  const requestedMode = opts.explicitMode ?? opts.repoMode ?? opts.defaultMode;
  const requestedResolution = resolvePolicyWithContext(requestedMode, opts.ciContext);
  const policyWithOverrides = applyConfigOverrides(requestedResolution.policy, opts);

  return { requestedMode, requestedSource, requestedResolution, policyWithOverrides };
}

function hydrateFromRequested(ctx: RequestedPolicyContext): HydratePolicyResolution {
  return {
    requestedMode: ctx.requestedMode,
    requestedSource: ctx.requestedSource,
    effectiveMode: ctx.requestedResolution.effectiveMode,
    effectiveSource: ctx.requestedSource,
    effectiveGateBehavior: ctx.requestedResolution.effectiveGateBehavior,
    degradedReason: ctx.requestedResolution.degradedReason,
    policy: ctx.policyWithOverrides,
  };
}

async function resolveCentralPolicyForHydrate(
  opts: HydratePolicyOptions & { centralPolicyPath: string },
  ctx: RequestedPolicyContext,
): Promise<HydratePolicyResolution> {
  const centralEvidence = await loadCentralPolicyEvidence(
    opts.centralPolicyPath,
    opts.digestFn,
    opts.readFileFn,
  );
  const requestedStrength = modeStrength(ctx.requestedResolution.effectiveMode);
  const centralStrength = modeStrength(centralEvidence.minimumMode);

  if (ctx.requestedSource === 'explicit' && requestedStrength < centralStrength) {
    throw new PolicyConfigurationError(
      'EXPLICIT_WEAKER_THAN_CENTRAL',
      `Explicit policy mode '${ctx.requestedResolution.effectiveMode}' is weaker than centrally required minimum '${centralEvidence.minimumMode}'`,
    );
  }

  if (requestedStrength >= centralStrength) {
    return {
      ...hydrateFromRequested(ctx),
      ...(ctx.requestedSource === 'explicit' && requestedStrength > centralStrength
        ? { resolutionReason: 'explicit_stronger_than_central' as const }
        : {}),
      centralEvidence,
    };
  }

  return resolveCentralUplift(opts, ctx, requestedStrength, centralStrength, centralEvidence);
}

function resolveCentralUplift(
  opts: HydratePolicyOptions,
  ctx: RequestedPolicyContext,
  requestedStrength: number,
  centralStrength: number,
  centralEvidence: CentralPolicyEvidence,
): HydratePolicyResolution {
  const centralResolution = resolvePolicyWithContext(centralEvidence.minimumMode, opts.ciContext);
  getAdapterLogger().warn('policy', 'Policy uplifted to central minimum', {
    requestedMode: ctx.requestedMode,
    requestedSource: ctx.requestedSource,
    requestedStrength: requestedStrength,
    centralMinimum: centralEvidence.minimumMode,
    centralStrength,
    resolutionReason:
      ctx.requestedSource === 'repo' ? 'repo_weaker_than_central' : 'default_weaker_than_central',
  });
  const centralPolicyWithOverrides = applyConfigOverrides(centralResolution.policy, opts);
  return {
    requestedMode: ctx.requestedMode,
    requestedSource: ctx.requestedSource,
    effectiveMode: centralResolution.effectiveMode,
    effectiveSource: 'central',
    effectiveGateBehavior: centralResolution.effectiveGateBehavior,
    degradedReason: centralResolution.degradedReason,
    policy: centralPolicyWithOverrides,
    resolutionReason:
      ctx.requestedSource === 'repo' ? 'repo_weaker_than_central' : 'default_weaker_than_central',
    centralEvidence,
  };
}

export async function resolvePolicyForHydrate(
  opts: HydratePolicyOptions,
): Promise<HydratePolicyResolution> {
  const ctx = resolveRequestedPolicy(opts);
  if (opts.centralPolicyPath === undefined) return hydrateFromRequested(ctx);
  return resolveCentralPolicyForHydrate(
    { ...opts, centralPolicyPath: opts.centralPolicyPath },
    ctx,
  );
}

/**
 * Resolve policy with runtime context awareness.
 *
 * THIS IS THE RUNTIME AUTHORITY. Use this for session creation and any
 * user-facing resolution where the effective mode matters.
 */
export function resolvePolicyWithContext(
  mode: string,
  ciContext = detectCiContext(),
): PolicyResolution {
  const requestedMode = normalizePolicyMode(mode);
  if (requestedMode === 'team-ci' && !ciContext) {
    getAdapterLogger().warn('policy', 'team-ci mode degraded to team — no CI context detected');
    const degradedPolicy: FlowGuardPolicy = {
      ...TEAM_CI_POLICY,
      requireHumanGates: true,
    };
    return {
      requestedMode,
      effectiveMode: 'team',
      effectiveGateBehavior: 'human_gated',
      degradedReason: 'ci_context_missing',
      policy: degradedPolicy,
    };
  }

  const policy = getPolicyPreset(requestedMode);
  return {
    requestedMode,
    effectiveMode: policy.mode,
    effectiveGateBehavior: policy.requireHumanGates ? 'human_gated' : 'auto_approve',
    policy,
  };
}

/**
 * P32: Resolve Runtime Policy Mode -- unified fallback for runtime surfaces.
 *
 * Priority: state snapshot > config > team (fail-closed default).
 *
 * The default is `team` (meaningful review gates) rather than `solo`
 * (weakest enforcement) to satisfy fail-closed principles.
 */
export function resolveRuntimePolicyMode(opts: {
  state?: { policySnapshot?: { mode?: PolicyMode } };
  configDefaultMode?: PolicyMode;
}): PolicyMode {
  if (opts.state?.policySnapshot?.mode) {
    return opts.state.policySnapshot.mode;
  }
  return opts.configDefaultMode ?? 'team';
}
