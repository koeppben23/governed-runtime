/**
 * @module config/policy
 * @description FlowGuard policy — operating mode configuration.
 *
 * Four presets:
 * - SOLO:      Single developer, no human gates, minimal ceremony
 * - TEAM:      Collaborative workflow, human gates, self-approval allowed
 * - TEAM-CI:   Team workflow with CI-only auto-approval
 * - REGULATED: Full FlowGuard, four-eyes principle, complete audit trail
 *
 * Policy lifecycle:
 * 1. Resolved at session creation (/hydrate) via `resolvePolicy(mode)`
 * 2. Frozen as an immutable PolicySnapshot in SessionState
 * 3. Governs the session for its entire lifetime — never mutated mid-session
 *
 * The PolicySnapshot stores FlowGuard-critical fields so auditors can verify
 * which rules governed a session — even if the policy presets are updated later.
 * The snapshot hash provides non-repudiation: if the hash matches a known policy,
 * the policy is authentic.
 *
 * Regulatory context:
 * - MaRisk AT 7.2: REGULATED enforces separation of duties via four-eyes
 * - ISO 27001 A.8.32: All modes enforce change management controls
 * - GoBD §146: TEAM/REGULATED enable tamper-evident hash chain
 * - DORA Art. 9: REGULATED provides full ICT change management FlowGuard
 *
 * Dependency: imports PolicySnapshot from state layer (inner → outer is correct).
 *
 * @version v1
 */

import type { PolicySnapshot } from '../state/evidence.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';

// ─── Audit Policy ─────────────────────────────────────────────────────────────

/** Controls which audit events are emitted and how. */
export interface AuditPolicy {
  /** Emit per-transition audit events (one per state change). */
  readonly emitTransitions: boolean;
  /** Emit per-tool-call audit events. */
  readonly emitToolCalls: boolean;
  /** Enable SHA-256 hash chain for tamper detection. */
  readonly enableChainHash: boolean;
}

/**
 * P34a: Independent self-review configuration.
 * Controls whether a subagent performs independent review.
 */
export interface SelfReviewConfig {
  /** Enable subagent-based independent review for plan/implement phases. */
  readonly subagentEnabled: boolean;
  /** Fallback to self-review (agent reviews own work) on subagent timeout/failure. */
  readonly fallbackToSelf: boolean;
}

/** Self-review configuration for FlowGuardPolicy interface. */
export const DEFAULT_SELF_REVIEW_CONFIG: SelfReviewConfig = {
  subagentEnabled: false,
  fallbackToSelf: false,
};

// ─── FlowGuard Policy ─────────────────────────────────────────────────────────

/**
 * Full FlowGuard policy configuration.
 *
 * Determines:
 * - Whether human gates require explicit human decisions
 * - Max iterations for self-review and impl-review loops
 * - Whether the session initiator can approve their own work (four-eyes)
 * - Which audit events are emitted and how
 * - How actors are classified in the audit trail
 */
export interface FlowGuardPolicy {
  /** Policy mode identifier. */
  readonly mode: PolicyMode;

  /**
   * Whether User Gate phases require explicit human decisions.
   * false → auto-approve at gates (solo mode).
   * true → machine waits for /review-decision (team/regulated).
   */
  readonly requireHumanGates: boolean;

  /** Max self-review iterations in PLAN phase before force-convergence. */
  readonly maxSelfReviewIterations: number;

  /** Max impl-review iterations in IMPL_REVIEW phase before force-convergence. */
  readonly maxImplReviewIterations: number;

  /**
   * Whether the session initiator can approve at User Gates.
   * false → four-eyes principle enforced (regulated).
   *         Session initiator !== review decision maker.
   * true  → self-approval allowed (solo/team).
   */
  readonly allowSelfApproval: boolean;

  /** P34a: Independent self-review configuration. */
  readonly selfReview: SelfReviewConfig;

  /** Audit event emission controls. */
  readonly audit: AuditPolicy;

  /**
   * Actor classification per tool name.
   * Maps FlowGuard tool names to actor labels for the audit trail.
   * Tools not listed default to "system".
   */
  readonly actorClassification: Readonly<Record<string, string>>;

  /**
   * P34: Minimum required actor assurance for regulated approval decisions.
   *
   * - 'best_effort'     → any actor may approve (default, backward-compat with P33 v0)
   * - 'claim_validated' → only actors with validated local claims may approve
   * - 'idp_verified'    → only IdP-verified actors may approve (future P35 enterprise target)
   *
   * Applies at User Gates in regulated mode. Actors below the threshold are blocked
   * with reason ACTOR_ASSURANCE_INSUFFICIENT.
   *
   * Migration from P33 v0:
   *   requireVerifiedActorsForApproval: true  ��� minimumActorAssuranceForApproval: 'claim_validated'
   *   requireVerifiedActorsForApproval: false → minimumActorAssuranceForApproval: 'best_effort'
   *
   * P34 design doc: docs/actor-assurance-architecture.md
   */
  readonly minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified';

  /**
   * P33 (deprecated): Whether regulated approvals require verified actor identity.
   * Ignored if minimumActorAssuranceForApproval is set.
   * Translated to minimumActorAssuranceForApproval at resolution time:
   *   true  → 'claim_validated'
   *   false → 'best_effort'
   */
  readonly requireVerifiedActorsForApproval: boolean;

  /**
   * P35a/P35b1/P35b2: IdP configuration for static keys or JWKS authority.
   * Defines issuer, audience, claim mapping, and key source details.
   * When set, allows idp_verified actors via FLOWGUARD_ACTOR_TOKEN_PATH.
   */
  readonly identityProvider?: IdpConfig;

  /**
   * P35a: Controls IdP verification behavior when identityProvider is set.
   * - 'optional': Token verification is attempted but failure doesn't block hydration
   * - 'required': IdP verification must succeed at hydration time
   *
   * Note: Approval gates respect minimumActorAssuranceForApproval regardless of this mode.
   * This mode only controls whether IdP failure blocks session creation.
   */
  readonly identityProviderMode: IdentityProviderMode;
}

/** Supported policy modes. */
export type PolicyMode = 'solo' | 'team' | 'team-ci' | 'regulated';

/** Effective gate behavior after policy resolution. */
export type EffectiveGateBehavior = 'auto_approve' | 'human_gated';

/** Why policy mode was degraded. */
export type PolicyDegradedReason = 'ci_context_missing';

/** Policy source used for hydrate-time authority resolution. */
export type PolicySource = 'explicit' | 'central' | 'repo' | 'default';

/** Central policy minimum modes (team-ci is intentionally excluded). */
export type CentralMinimumMode = 'solo' | 'team' | 'regulated';

/** Why a policy source was selected or overridden. */
export type PolicyResolutionReason =
  | 'repo_weaker_than_central'
  | 'default_weaker_than_central'
  | 'explicit_stronger_than_central';

/** Central policy bundle schema (P29 local distribution model). */
export interface CentralPolicyBundle {
  readonly schemaVersion: 'v1';
  readonly minimumMode: CentralMinimumMode;
  readonly policyId?: string;
  readonly version?: string;
}

/** Provenance/evidence for a resolved central policy bundle. */
export interface CentralPolicyEvidence {
  readonly minimumMode: CentralMinimumMode;
  readonly digest: string;
  readonly version?: string;
  readonly pathHint: string;
}

/** Hydrate policy authority resolution result (P29). */
export interface HydratePolicyResolution {
  readonly requestedMode: PolicyMode;
  readonly requestedSource: Exclude<PolicySource, 'central'>;
  readonly effectiveMode: PolicyMode;
  readonly effectiveSource: PolicySource;
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly degradedReason?: PolicyDegradedReason;
  readonly policy: FlowGuardPolicy;
  readonly resolutionReason?: PolicyResolutionReason;
  readonly centralEvidence?: CentralPolicyEvidence;
}

/** Validate an existing session mode against optional central minimum (P29). */
export async function validateExistingPolicyAgainstCentral(opts: {
  existingMode: PolicyMode;
  centralPolicyPath?: string;
  digestFn: (text: string) => string;
  readFileFn?: (path: string) => Promise<string>;
}): Promise<CentralPolicyEvidence | undefined> {
  if (opts.centralPolicyPath === undefined) {
    return undefined;
  }

  const centralEvidence = await loadCentralPolicyEvidence(
    opts.centralPolicyPath,
    opts.digestFn,
    opts.readFileFn,
  );

  if (modeStrength(opts.existingMode) < modeStrength(centralEvidence.minimumMode)) {
    throw new PolicyConfigurationError(
      'EXISTING_POLICY_WEAKER_THAN_CENTRAL',
      `Existing session policy mode '${opts.existingMode}' is weaker than centrally required minimum '${centralEvidence.minimumMode}'`,
    );
  }

  return centralEvidence;
}

/** Detailed policy resolution result (requested vs effective). */
export interface PolicyResolution {
  readonly requestedMode: PolicyMode;
  readonly effectiveMode: PolicyMode;
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly degradedReason?: PolicyDegradedReason;
  readonly policy: FlowGuardPolicy;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when policy configuration is invalid or contains an unsupported mode.
 *
 * Fail-stop: invalid policy must surface immediately, never silently degrade.
 */
export class PolicyConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyConfigurationError';
    this.code = code;
  }
}

// ─── Presets ──────────────────────────────────────────────────────────────────

/**
 * SOLO mode — single developer, minimal ceremony.
 *
 * - No human gates (auto-approve at PLAN_REVIEW/EVIDENCE_REVIEW)
 * - 1 review iteration (fast feedback, not deep convergence)
 * - Self-approval allowed (single person workflow)
 * - Hash chain disabled (overhead not justified for solo work)
 * - Audit events still emitted (traceability even in solo)
 */
export const SOLO_POLICY: FlowGuardPolicy = {
  mode: 'solo',
  requireHumanGates: false,
  maxSelfReviewIterations: 2,
  maxImplReviewIterations: 1,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: false,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
};

/**
 * TEAM mode — collaborative workflow.
 *
 * - Human gates active (explicit approve/reject at review points)
 * - 3 review iterations (deep convergence via digest-stop)
 * - Self-approval allowed (trust within team)
 * - Full audit with hash chain
 */
export const TEAM_POLICY: FlowGuardPolicy = {
  mode: 'team',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
};

/**
 * TEAM-CI mode — CI pipeline workflow.
 *
 * - Auto-approve at user gates (only when CI context is present)
 * - 3 review iterations (same as TEAM)
 * - Self-approval allowed (CI actor)
 * - Full audit with hash chain
 */
export const TEAM_CI_POLICY: FlowGuardPolicy = {
  mode: 'team-ci',
  requireHumanGates: false,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
};

/**
 * REGULATED mode — full FlowGuard for banks, DATEV, regulated industries.
 *
 * - Human gates active (explicit approve/reject required)
 * - 3 review iterations (full convergence)
 * - Four-eyes principle enforced (initiator ≠ reviewer)
 * - Full audit with hash chain
 * - Abort also classified as human action
 *
 * Regulatory coverage:
 * - MaRisk AT 7.2 (1-5): Documented change request, impact analysis,
 *   test evidence, authorized approval, separation of duties
 * - BAIT 4.3.2: Change management with documented approval process
 * - ISO 27001 A.8.32: Change management controls
 * - GoBD §146 Abs. 4: Tamper-evident, immutable audit trail
 * - DORA Art. 9: ICT change management with audit trail
 */
export const REGULATED_POLICY: FlowGuardPolicy = {
  mode: 'regulated',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: false,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
    flowguard_abort_session: 'human',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
};

// ─── Registry ─────────────────────────────────────────────────────────────────

/** All known policy presets, indexed by mode. */
const POLICIES: Readonly<Record<string, FlowGuardPolicy>> = {
  solo: SOLO_POLICY,
  team: TEAM_POLICY,
  'team-ci': TEAM_CI_POLICY,
  regulated: REGULATED_POLICY,
};

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Detect whether this process runs in a CI context.
 *
 * Conservative default: false when context is missing or unclear.
 */
export function detectCiContext(env: Record<string, string | undefined> = process.env): boolean {
  const ciSignals = [
    env.CI,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.BUILDKITE,
    env.JENKINS_URL,
    env.TF_BUILD,
    env.TEAMCITY_VERSION,
    env.CIRCLECI,
    env.DRONE,
    env.BITBUCKET_BUILD_NUMBER,
    env.BUILDKITE_BUILD_ID,
  ];
  return ciSignals.some(isTruthyEnv);
}

/**
 * Validate and normalize a policy mode string.
 *
 * Fail-stop: unrecognized modes throw PolicyConfigurationError.
 * No silent fallback — every caller must pass a validated mode string.
 * Zod schema validation on config and CLI args prevents normal users from
 * hitting this; it catches programmatic errors and config drift.
 *
 * @param mode - Policy mode string. Must be one of: solo, team, team-ci, regulated.
 * @throws PolicyConfigurationError for unsupported mode values.
 */
function normalizePolicyMode(mode: string): PolicyMode {
  if (mode === 'solo' || mode === 'team' || mode === 'team-ci' || mode === 'regulated') {
    return mode;
  }
  throw new PolicyConfigurationError(
    'INVALID_POLICY_MODE',
    `Unsupported policy mode: '${mode}'. Valid modes: solo, team, team-ci, regulated`,
  );
}

function normalizeCentralMinimumMode(mode: unknown): CentralMinimumMode {
  if (mode === 'solo' || mode === 'team' || mode === 'regulated') {
    return mode;
  }
  throw new PolicyConfigurationError(
    'CENTRAL_POLICY_INVALID_MODE',
    `Central policy minimumMode must be one of: solo, team, regulated (received: ${String(mode)})`,
  );
}

function parseCentralPolicyBundle(raw: string): CentralPolicyBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_JSON',
      'Central policy file is not valid JSON',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy must be a JSON object',
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 'v1') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy schemaVersion must be "v1"',
    );
  }

  const minimumMode = normalizeCentralMinimumMode(obj.minimumMode);

  if (obj.version !== undefined && typeof obj.version !== 'string') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy version must be a string when provided',
    );
  }

  if (obj.policyId !== undefined && typeof obj.policyId !== 'string') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy policyId must be a string when provided',
    );
  }

  return {
    schemaVersion: 'v1',
    minimumMode,
    ...(typeof obj.policyId === 'string' ? { policyId: obj.policyId } : {}),
    ...(typeof obj.version === 'string' ? { version: obj.version } : {}),
  };
}

function modeStrength(mode: PolicyMode | CentralMinimumMode): number {
  if (mode === 'solo') return 1;
  if (mode === 'team' || mode === 'team-ci') return 2;
  return 3;
}

function centralPathHint(absolutePath: string): string {
  return `basename:${nodePath.basename(absolutePath)}`;
}

export async function loadCentralPolicyEvidence(
  policyPath: string,
  digestFn: (text: string) => string,
  readFileFn: (path: string) => Promise<string> = async (path) => fsReadFile(path, 'utf8'),
): Promise<CentralPolicyEvidence> {
  if (!policyPath.trim()) {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_PATH_EMPTY',
      'FLOWGUARD_POLICY_PATH is set but empty',
    );
  }

  const absolutePath = nodePath.resolve(policyPath);
  let raw: string;
  try {
    raw = await readFileFn(absolutePath);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
    const message = err instanceof Error ? err.message : String(err);
    throw new PolicyConfigurationError(
      code === 'ENOENT' ? 'CENTRAL_POLICY_MISSING' : 'CENTRAL_POLICY_UNREADABLE',
      `Central policy file cannot be read at ${absolutePath}: ${message}`,
    );
  }

  const bundle = parseCentralPolicyBundle(raw);
  return {
    minimumMode: bundle.minimumMode,
    digest: digestFn(raw),
    ...(bundle.version ? { version: bundle.version } : {}),
    pathHint: centralPathHint(absolutePath),
  };
}

export async function resolvePolicyForHydrate(opts: {
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
}): Promise<HydratePolicyResolution> {
  const requestedSource: Exclude<PolicySource, 'central'> = opts.explicitMode
    ? 'explicit'
    : opts.repoMode
      ? 'repo'
      : 'default';
  const requestedMode = opts.explicitMode ?? opts.repoMode ?? opts.defaultMode;
  const requestedResolution = resolvePolicyWithContext(requestedMode, opts.ciContext);

  // Apply config iteration-limit overrides over the selected policy preset.
  const basePolicy = requestedResolution.policy;
  const policyWithOverrides: FlowGuardPolicy = {
    ...basePolicy,
    maxSelfReviewIterations:
      opts.configMaxSelfReviewIterations ?? basePolicy.maxSelfReviewIterations,
    maxImplReviewIterations:
      opts.configMaxImplReviewIterations ?? basePolicy.maxImplReviewIterations,
    // P34: Translate legacy requireVerifiedActorsForApproval to minimumActorAssuranceForApproval
    // Priority: explicit new config > legacy bool true > preset value > default
    minimumActorAssuranceForApproval:
      (opts.configMinimumActorAssuranceForApproval as
        | 'best_effort'
        | 'claim_validated'
        | 'idp_verified') ??
      (opts.configRequireVerifiedActorsForApproval === true ? 'claim_validated' : undefined) ??
      basePolicy.minimumActorAssuranceForApproval,
    requireVerifiedActorsForApproval:
      opts.configRequireVerifiedActorsForApproval ?? basePolicy.requireVerifiedActorsForApproval,
    // P35a: Wire IdP configuration through
    identityProvider: opts.configIdentityProvider ?? basePolicy.identityProvider,
    identityProviderMode: opts.configIdentityProviderMode ?? basePolicy.identityProviderMode,
  };

  if (opts.centralPolicyPath === undefined) {
    return {
      requestedMode,
      requestedSource,
      effectiveMode: requestedResolution.effectiveMode,
      effectiveSource: requestedSource,
      effectiveGateBehavior: requestedResolution.effectiveGateBehavior,
      degradedReason: requestedResolution.degradedReason,
      policy: policyWithOverrides,
    };
  }

  const centralEvidence = await loadCentralPolicyEvidence(
    opts.centralPolicyPath,
    opts.digestFn,
    opts.readFileFn,
  );

  const requestedStrength = modeStrength(requestedResolution.effectiveMode);
  const centralStrength = modeStrength(centralEvidence.minimumMode);

  if (requestedSource === 'explicit' && requestedStrength < centralStrength) {
    throw new PolicyConfigurationError(
      'EXPLICIT_WEAKER_THAN_CENTRAL',
      `Explicit policy mode '${requestedResolution.effectiveMode}' is weaker than centrally required minimum '${centralEvidence.minimumMode}'`,
    );
  }

  if (requestedStrength >= centralStrength) {
    return {
      requestedMode,
      requestedSource,
      effectiveMode: requestedResolution.effectiveMode,
      effectiveSource: requestedSource,
      effectiveGateBehavior: requestedResolution.effectiveGateBehavior,
      degradedReason: requestedResolution.degradedReason,
      policy: policyWithOverrides,
      ...(requestedSource === 'explicit' && requestedStrength > centralStrength
        ? { resolutionReason: 'explicit_stronger_than_central' as const }
        : {}),
      centralEvidence,
    };
  }

  const centralResolution = resolvePolicyWithContext(centralEvidence.minimumMode, opts.ciContext);
  // Apply config overrides to central policy as well
  const centralPolicyWithOverrides: FlowGuardPolicy = {
    ...centralResolution.policy,
    maxSelfReviewIterations:
      opts.configMaxSelfReviewIterations ?? centralResolution.policy.maxSelfReviewIterations,
    maxImplReviewIterations:
      opts.configMaxImplReviewIterations ?? centralResolution.policy.maxImplReviewIterations,
    minimumActorAssuranceForApproval:
      (opts.configMinimumActorAssuranceForApproval as
        | 'best_effort'
        | 'claim_validated'
        | 'idp_verified') ??
      (opts.configRequireVerifiedActorsForApproval === true ? 'claim_validated' : undefined) ??
      centralResolution.policy.minimumActorAssuranceForApproval,
    requireVerifiedActorsForApproval:
      opts.configRequireVerifiedActorsForApproval ??
      centralResolution.policy.requireVerifiedActorsForApproval,
    identityProvider: opts.configIdentityProvider ?? centralResolution.policy.identityProvider,
    identityProviderMode:
      opts.configIdentityProviderMode ?? centralResolution.policy.identityProviderMode,
  };
  return {
    requestedMode,
    requestedSource,
    effectiveMode: centralResolution.effectiveMode,
    effectiveSource: 'central',
    effectiveGateBehavior: centralResolution.effectiveGateBehavior,
    degradedReason: centralResolution.degradedReason,
    policy: centralPolicyWithOverrides,
    resolutionReason:
      requestedSource === 'repo' ? 'repo_weaker_than_central' : 'default_weaker_than_central',
    centralEvidence,
  };
}

/**
 * Resolve policy with runtime context awareness.
 *
 * THIS IS THE RUNTIME AUTHORITY. Use this for session creation and any
 * user-facing resolution where the effective mode matters.
 *
 * Degradation rules:
 * - team-ci + no CI detected → effectiveMode="team", effectiveGateBehavior="human_gated"
 * - All other modes → effectiveMode = requestedMode
 *
 * The returned policy object reflects the effective (possibly degraded) policy.
 * Compare: resolvePolicy() returns the raw preset without context.
 *
 * @param mode - Policy mode string (required). Callers must resolve their own fallback.
 * @param ciContext - Whether CI environment is detected. Defaults to runtime detection.
 * @throws PolicyConfigurationError for unsupported mode values.
 */
export function resolvePolicyWithContext(
  mode: string,
  ciContext = detectCiContext(),
): PolicyResolution {
  const requestedMode = normalizePolicyMode(mode);
  if (requestedMode === 'team-ci' && !ciContext) {
    return {
      requestedMode,
      effectiveMode: 'team',
      effectiveGateBehavior: 'human_gated',
      degradedReason: 'ci_context_missing',
      policy: TEAM_POLICY,
    };
  }

  const policy = POLICIES[requestedMode] ?? TEAM_POLICY;
  return {
    requestedMode,
    effectiveMode: policy.mode,
    effectiveGateBehavior: policy.requireHumanGates ? 'human_gated' : 'auto_approve',
    policy,
  };
}

/**
 * Resolve a FlowGuard policy PRESET by mode name.
 *
 * ⚠ Authority scope: PRESET LOOKUP ONLY.
 * Returns the raw policy object for a given mode string without applying
 * runtime context (CI detection, degradation, etc.).
 *
 * Use for:
 *   - Config lookups (map mode strings to policy objects)
 *   - PolicySnapshot factory input (pass the already-resolved effective mode)
 *   - Preset comparison (e.g., policyTests)
 *
 * Do NOT use for:
 *   - Session creation → resolvePolicyWithContext()
 *   - Runtime gate evaluation → resolvePolicyWithContext()
 *
 * Runtime authority is resolvePolicyWithContext():
 *   - Applies CI context detection
 *   - Degrades team-ci to team when CI is not detected
 *   - Returns effective mode, effective gate behavior, and degradedReason
 *
 * team-ci returns TEAM_CI_POLICY (the preset, not the degraded result).
 * Degradation to TEAM_POLICY only happens inside resolvePolicyWithContext.
 *
 * @param mode - Policy mode string (solo | team | team-ci | regulated).
 *               Required. Callers must resolve their own fallback.
 * @throws PolicyConfigurationError for unsupported mode values.
 */
export function getPolicyPreset(mode: string): FlowGuardPolicy {
  const m = normalizePolicyMode(mode);
  // defensive: POLICIES[m] is guaranteed after normalizePolicyMode validation
  return POLICIES[m] ?? TEAM_POLICY;
}

/**
 * @deprecated Use getPolicyPreset() for preset lookup, or
 * resolvePolicyWithContext() for runtime authority.
 * @throws PolicyConfigurationError for unsupported mode values.
 */
export function resolvePolicy(mode: string): FlowGuardPolicy {
  return getPolicyPreset(mode);
}

/** All known policy mode names. */
export function policyModes(): string[] {
  return Object.keys(POLICIES);
}

// ─── Snapshot Factory ─────────────────────────────────────────────────────────

/**
 * Create an immutable policy snapshot for embedding in SessionState.
 *
 * The snapshot freezes all FlowGuard-critical fields. The hash provides
 * non-repudiation: given the hash and the policy registry, an auditor
 * can verify which exact policy governed a session.
 *
 * @param policy - The resolved FlowGuard policy.
 * @param resolvedAt - ISO-8601 timestamp when the policy was frozen.
 * @param digestFn - SHA-256 digest function (injected for testability).
 */
export function createPolicySnapshot(
  policy: FlowGuardPolicy,
  resolvedAt: string,
  digestFn: (text: string) => string,
  resolution?: {
    requestedMode: PolicyMode;
    effectiveGateBehavior: EffectiveGateBehavior;
    degradedReason?: PolicyDegradedReason;
    source?: PolicySource;
    resolutionReason?: PolicyResolutionReason;
    centralMinimumMode?: CentralMinimumMode;
    policyDigest?: string;
    policyVersion?: string;
    policyPathHint?: string;
  },
): PolicySnapshot {
  // Canonical JSON: sorted keys for deterministic hashing.
  // This ensures the same policy always produces the same hash,
  // regardless of object key insertion order in different JS engines.
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());

  return {
    mode: policy.mode,
    hash: digestFn(canonical),
    resolvedAt,
    requestedMode: resolution?.requestedMode ?? policy.mode,
    ...(resolution?.source ? { source: resolution.source } : {}),
    effectiveGateBehavior:
      resolution?.effectiveGateBehavior ??
      (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    ...(resolution?.degradedReason ? { degradedReason: resolution.degradedReason } : {}),
    ...(resolution?.resolutionReason ? { resolutionReason: resolution.resolutionReason } : {}),
    ...(resolution?.centralMinimumMode
      ? { centralMinimumMode: resolution.centralMinimumMode }
      : {}),
    ...(resolution?.policyDigest ? { policyDigest: resolution.policyDigest } : {}),
    ...(resolution?.policyVersion ? { policyVersion: resolution.policyVersion } : {}),
    ...(resolution?.policyPathHint ? { policyPathHint: resolution.policyPathHint } : {}),
    requireHumanGates: policy.requireHumanGates,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    maxImplReviewIterations: policy.maxImplReviewIterations,
    allowSelfApproval: policy.allowSelfApproval,
    requireVerifiedActorsForApproval: policy.requireVerifiedActorsForApproval,
    audit: {
      emitTransitions: policy.audit.emitTransitions,
      emitToolCalls: policy.audit.emitToolCalls,
      enableChainHash: policy.audit.enableChainHash,
    },
    actorClassification: { ...policy.actorClassification },
    minimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval,
    ...(policy.identityProvider ? { identityProvider: policy.identityProvider } : {}),
    identityProviderMode: policy.identityProviderMode,
    ...(policy.selfReview ? { selfReview: policy.selfReview } : {}),
  };
}

/**
 * Reconstruct an executable policy from a frozen policy snapshot.
 *
 * Snapshot fields are the sole authority. No preset fallback.
 * All governance-critical fields including actorClassification
 * are read exclusively from the snapshot.
 */
export function policyFromSnapshot(snapshot: PolicySnapshot): FlowGuardPolicy {
  return {
    mode: snapshot.mode as PolicyMode,
    requireHumanGates: snapshot.requireHumanGates,
    maxSelfReviewIterations: snapshot.maxSelfReviewIterations,
    maxImplReviewIterations: snapshot.maxImplReviewIterations,
    allowSelfApproval: snapshot.allowSelfApproval,
    selfReview: snapshot.selfReview ?? DEFAULT_SELF_REVIEW_CONFIG,
    minimumActorAssuranceForApproval:
      (snapshot.minimumActorAssuranceForApproval as
        | 'best_effort'
        | 'claim_validated'
        | 'idp_verified'
        | undefined) ??
      (snapshot.requireVerifiedActorsForApproval ? 'claim_validated' : 'best_effort'),
    requireVerifiedActorsForApproval: snapshot.requireVerifiedActorsForApproval ?? false,
    audit: {
      emitTransitions: snapshot.audit.emitTransitions,
      emitToolCalls: snapshot.audit.emitToolCalls,
      enableChainHash: snapshot.audit.enableChainHash,
    },
    actorClassification: { ...snapshot.actorClassification },
    identityProvider: snapshot.identityProvider,
    identityProviderMode: snapshot.identityProviderMode ?? 'optional',
  };
}

/**
 * P32: Resolve Runtime Policy Mode — unified fallback for runtime surfaces.
 *
 * Priority: state snapshot > config > solo
 * - state.policySnapshot.mode (existing session) takes precedence
 * - config.policy.defaultMode is secondary
 * - solo is the final safe fallback
 *
 * This function is for runtime surfaces (plugin, status, etc.) that already have
 * an existing session state. It does NOT handle explicit user input —
 * that is handled by resolvePolicyForHydrate() which includes P29/P31 logic.
 *
 * @example
 * // Plugin with existing session
 * const mode = resolveRuntimePolicyMode({ state: existingState });
 *
 * // Plugin without session, using config
 * const mode = resolveRuntimePolicyMode({ configDefaultMode: config.policy.defaultMode });
 *
 * // Plugin without anything
 * const mode = resolveRuntimePolicyMode({});
 */
export function resolveRuntimePolicyMode(opts: {
  state?: { policySnapshot?: { mode?: PolicyMode } };
  configDefaultMode?: PolicyMode;
}): PolicyMode {
  if (opts.state?.policySnapshot?.mode) {
    return opts.state.policySnapshot.mode;
  }
  return opts.configDefaultMode ?? 'solo';
}
