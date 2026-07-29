/**
 * @module integration/tools/hydrate-format
 * @description Hydrate input assembly and response formatting.
 *
 * @version v1
 */

import { resolveActor } from '../../adapters/actor.js';
import type { HydrateInput, HydratePolicyInput, HydrateProfileInput } from '../../rails/hydrate.js';
import { executeHydrate } from '../../rails/hydrate.js';
import type { ToolResult } from './helpers.js';
import { persistAndFormat, appendNextAction } from './helpers.js';
import { LOCK_CONTENDED_OUTPUT_FIELD } from '../../shared/flowguard-identifiers.js';
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import type {
  CompactCardDocument,
  PresentationSection,
  PresentationConclusion,
  KeyValueSection,
  CommandListSection,
  NoticeSection,
} from '../../presentation/model.js';
import type { Phase } from '../../state/schema.js';

import type {
  DiscoveryHydration,
  ExistingHydrateState,
  ExistingCentralEvidence,
  HydratePolicyResolution,
  HydrateConfig,
  BuildHydrateInputParams,
} from './hydrate-types.js';

// ─── Input Assembly ──────────────────────────────────────────────────────

export function buildExistingPolicyInput(
  existing: NonNullable<ExistingHydrateState>,
  centralEvidenceForExisting: ExistingCentralEvidence | undefined,
): HydratePolicyInput {
  return {
    policyMode: existing.policySnapshot.mode,
    requestedPolicyMode: existing.policySnapshot.requestedMode,
    policySource: existing.policySnapshot.source ?? 'default',
    effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
    policyDegradedReason: existing.policySnapshot.degradedReason as
      'ci_context_missing' | undefined,
    policyResolutionReason: existing.policySnapshot.resolutionReason as
      | 'repo_weaker_than_central'
      | 'default_weaker_than_central'
      | 'explicit_stronger_than_central'
      | undefined,
    centralMinimumMode:
      centralEvidenceForExisting?.minimumMode ?? existing.policySnapshot.centralMinimumMode,
    policyDigest: centralEvidenceForExisting?.digest ?? existing.policySnapshot.policyDigest,
    policyVersion: centralEvidenceForExisting
      ? centralEvidenceForExisting.version
      : existing.policySnapshot.policyVersion,
    policyPathHint: centralEvidenceForExisting?.pathHint ?? existing.policySnapshot.policyPathHint,
  };
}

export function buildNewPolicyInput(
  policyResolution: HydratePolicyResolution,
  config: HydrateConfig,
): HydratePolicyInput {
  return {
    policyMode: policyResolution.effectiveMode,
    requestedPolicyMode: policyResolution.requestedMode,
    policySource: policyResolution.effectiveSource,
    effectiveGateBehavior: policyResolution.effectiveGateBehavior,
    policyDegradedReason: policyResolution.degradedReason,
    policyResolutionReason: policyResolution.resolutionReason,
    centralMinimumMode: policyResolution.centralEvidence?.minimumMode,
    policyDigest: policyResolution.centralEvidence?.digest,
    policyVersion: policyResolution.centralEvidence?.version,
    policyPathHint: policyResolution.centralEvidence?.pathHint,
    maxSelfReviewIterations: config.policy.maxSelfReviewIterations,
    maxImplReviewIterations: config.policy.maxImplReviewIterations,
    requireVerifiedActorsForApproval: config.policy.requireVerifiedActorsForApproval,
    identityProvider: config.policy.identityProvider,
    identityProviderMode: config.policy.identityProviderMode,
    minimumActorAssuranceForApproval: config.policy.minimumActorAssuranceForApproval,
    enforceRiskClassification: config.policy.enforceRiskClassification,
    allowRiskDowngradeOverride: config.policy.allowRiskDowngradeOverride,
    allowReducedCeremony: config.policy.allowReducedCeremony,
    policyResolution,
  };
}

export function buildPolicyInput(
  existing: ExistingHydrateState,
  policyResolution: HydratePolicyResolution,
  config: HydrateConfig,
  centralEvidenceForExisting: ExistingCentralEvidence | undefined,
): HydratePolicyInput {
  if (existing) return buildExistingPolicyInput(existing, centralEvidenceForExisting);
  return buildNewPolicyInput(policyResolution, config);
}

export function buildProfileInput(
  existing: ExistingHydrateState,
  discovery: DiscoveryHydration,
  config: HydrateConfig,
  actorInfo: Awaited<ReturnType<typeof resolveActor>>,
): HydrateProfileInput {
  return {
    profileId: existing
      ? existing.activeProfile?.id
      : (discovery.profileResolution?.primary?.id ?? 'baseline'),
    activeChecks: existing ? undefined : config.profile.activeChecks,
    repoSignals: discovery.repoSignals,
    discoveryResult: discovery.discoveryResult,
    initiatedBy: actorInfo.id,
    initiatedByIdentity: {
      actorId: actorInfo.id,
      actorEmail: actorInfo.email,
      actorSource: actorInfo.source,
      actorAssurance: actorInfo.assurance,
    },
    actorInfo,
  };
}

export function buildHydrateInput(params: BuildHydrateInputParams): HydrateInput {
  const { context, worktree, workspace, policyContext, config, discovery, actorInfo } = params;
  const { existingWithCentralEvidence, centralEvidenceForExisting, policyResolution } =
    policyContext;
  return {
    session: {
      sessionId: context.sessionID,
      worktree,
      fingerprint: workspace.fingerprint,
      claimedTaskClass: contextClaimedTaskClass(params),
      discoveryDigest: discovery.discoveryDigest,
      discoverySummary: discovery.discoverySummary,
      detectedStack: discovery.detectedStack,
      verificationCandidates: discovery.verificationCandidates,
      ...(params.baselineDirtyFiles ? { baselineDirtyFiles: params.baselineDirtyFiles } : {}),
    },
    policy: buildPolicyInput(
      existingWithCentralEvidence,
      policyResolution,
      config,
      centralEvidenceForExisting,
    ),
    profile: buildProfileInput(existingWithCentralEvidence, discovery, config, actorInfo),
  };
}

export function contextClaimedTaskClass(params: BuildHydrateInputParams) {
  const raw = params.args.claimedTaskClass;
  return raw === 'TRIVIAL' || raw === 'STANDARD' || raw === 'HIGH-RISK' ? raw : undefined;
}

// ─── Response Formatting ─────────────────────────────────────────────────

// ─── Response Formatting ─────────────────────────────────────────────────

interface HydrateCardParams {
  sessionId: string;
  phase: Phase;
  policyMode: string;
  gateBehavior: string;
  profileName: string;
  profileDetected: boolean;
  endpointCount: number | undefined;
  gateNotice: string | null;
}

/**
 * Build a portable, LLM-consensus presentation card for a fresh session.
 *
 * The card is rendered through the shared {@link renderMarkdown} so it carries
 * the same ASCII-only symbol conventions as /status, /finish, /why, and /help.
 * All LLMs render this identically — deepseek, big-pickle, and any future
 * model that consumes OpenCode-compatible tool output.
 */
function buildHydratePresentationCard(params: HydrateCardParams): { markdown: string } {
  const sections: PresentationSection[] = [];
  sections.push(buildHydrateStatusSection(params));
  sections.push(buildHydrateWorkflowsSection());
  if (params.gateNotice !== null) {
    sections.push(buildHydrateGateNoticeSection(params.gateNotice));
  }

  const conclusion: PresentationConclusion = {
    kind: 'next_action',
    action: {
      invocation: '/task',
      description: 'Record the task that the workflow will govern.',
      visibility: 'recommended',
    },
  };

  const document: CompactCardDocument = {
    kind: 'compact_card',
    density: 'compact',
    form: 'success',
    sections,
    conclusion,
  };
  return { markdown: renderMarkdown(document) };
}

function buildHydrateStatusSection(params: HydrateCardParams): KeyValueSection {
  const modeLabel =
    params.gateBehavior === 'auto_approve'
      ? `${params.policyMode} (auto-approve)`
      : params.policyMode;
  const gateQualifier =
    params.gateBehavior === 'human_gated'
      ? ' (human-gated — every key decision requires your explicit approval)'
      : '';

  const profileParts: string[] = [params.profileName];
  if (params.profileDetected) {
    profileParts.push('auto-detected');
    if (params.endpointCount !== undefined && params.endpointCount > 0) {
      profileParts.push(`${params.endpointCount} API endpoints discovered`);
    }
  }

  return {
    kind: 'keyValue',
    heading: 'Status',
    items: [
      { label: 'Session ID', value: params.sessionId.slice(0, 8) },
      { label: 'Phase', value: PHASE_LABELS[params.phase] },
      { label: 'Policy', value: `${modeLabel}${gateQualifier}` },
      { label: 'Profile', value: profileParts.join(', ') },
    ],
  };
}

function buildHydrateWorkflowsSection(): CommandListSection {
  return {
    kind: 'commandList',
    heading: 'Workflows',
    items: [
      {
        invocation: '/task',
        description:
          'Record a ticket and run the full development lifecycle (ticket \u2192 plan \u2192 implement \u2192 review)',
        visibility: 'available' as const,
      },
      {
        invocation: '/architecture',
        description: 'Create an Architecture Decision Record (ADR)',
        visibility: 'available' as const,
      },
      {
        invocation: '/review',
        description: 'Generate a compliance review report',
        visibility: 'available' as const,
      },
    ],
  };
}

function buildHydrateGateNoticeSection(notice: string): NoticeSection {
  return { kind: 'notice', level: 'warning', message: notice, additionalMessages: [], details: [] };
}

function extractOutputStr(formatted: ToolResult): string {
  return typeof formatted === 'object' && 'output' in formatted ? formatted.output : formatted;
}

export async function formatNewSessionResponse(
  sessDir: string,
  result: Extract<ReturnType<typeof executeHydrate>, { kind: 'ok' }>,
  discovery: DiscoveryHydration,
  policyResolution: HydratePolicyResolution,
): Promise<ToolResult> {
  const state = result.state;
  const formattedResult = await persistAndFormat(sessDir, result);
  const outputStr = extractOutputStr(formattedResult);
  const formatted = JSON.parse(outputStr) as Record<string, unknown>;
  const gateNoticeText = buildGateNotice(
    policyResolution.effectiveGateBehavior,
    policyResolution.effectiveMode,
  );
  const cardParams: HydrateCardParams = {
    sessionId: state.id,
    phase: state.phase,
    policyMode: policyResolution.effectiveMode,
    gateBehavior: policyResolution.effectiveGateBehavior,
    profileName: state.activeProfile?.name ?? 'Baseline Governance',
    profileDetected: !!discovery.repoSignals,
    endpointCount: discovery.discoverySummary?.apiEndpointCount ?? undefined,
    gateNotice: gateNoticeText,
  };
  const response: Record<string, unknown> = {
    ...formatted,
    sessionId: state.id,
    profileId: state.activeProfile?.id ?? 'baseline',
    profileName: state.activeProfile?.name ?? 'Baseline Governance',
    profileDetected: !!discovery.repoSignals,
    discoveryComplete: !!discovery.discoveryResult,
    discoverySummary: discovery.discoverySummary ?? null,
    claimedTaskClass: state.claimedTaskClass ?? null,
    policyResolution: formatPolicyResolution(policyResolution),
    gateNotice: gateNoticeText,
    presentation: buildHydratePresentationCard(cardParams),
  };
  return appendNextAction(JSON.stringify(response), state);
}

export function formatPolicyResolution(
  policyResolution: HydratePolicyResolution,
): Record<string, unknown> {
  return {
    requestedMode: policyResolution.requestedMode,
    effectiveMode: policyResolution.effectiveMode,
    source: policyResolution.effectiveSource,
    effectiveGateBehavior: policyResolution.effectiveGateBehavior,
    reason: policyResolution.degradedReason ?? null,
    resolutionReason: policyResolution.resolutionReason ?? null,
    centralMinimumMode: policyResolution.centralEvidence?.minimumMode ?? null,
    centralPolicyDigest: policyResolution.centralEvidence?.digest ?? null,
    centralPolicyVersion: policyResolution.centralEvidence?.version ?? null,
    centralPolicyPathHint: policyResolution.centralEvidence?.pathHint ?? null,
  };
}

export async function formatHydrateResult(
  sessDir: string,
  existing: ExistingHydrateState,
  result: ReturnType<typeof executeHydrate>,
  discovery: DiscoveryHydration,
  policyResolution: HydratePolicyResolution,
): Promise<ToolResult> {
  if (result.kind === 'ok' && !existing) {
    return formatNewSessionResponse(sessDir, result, discovery, policyResolution);
  }
  const formatted = await persistAndFormat(sessDir, result);
  if (result.kind !== 'ok') return formatted;
  // Existing-session reload: surface the auto-approve notice from the persisted
  // snapshot so a reloaded solo/team-ci session is just as visible as a new one.
  const notice = buildGateNotice(
    result.state.policySnapshot.effectiveGateBehavior,
    result.state.policySnapshot.mode,
  );
  return withGateNotice(formatted, notice);
}

// ─── Lock Contention Annotations ──────────────────────────────────────────

export function withLockContended(result: ToolResult, waited: boolean): ToolResult {
  if (!waited) return result;
  if (typeof result === 'string') {
    return injectLockContended(result);
  }
  return { ...result, output: injectLockContended(result.output) };
}

export function injectLockContended(output: string): string {
  const idx = output.indexOf('\n');
  const head = idx >= 0 ? output.slice(0, idx) : output;
  const tail = idx >= 0 ? output.slice(idx) : '';
  const parsed = JSON.parse(head) as Record<string, unknown>;
  // Faithful (#429): annotate ONLY a confirmed-success hydrate result. A
  // blocked/error output (`error: true`, or one lacking the success marker
  // `status: 'ok'`) MUST NOT carry lockContended — otherwise the plugin
  // boundary would log a "waited success" for a hydrate that actually failed.
  if (parsed.error === true || parsed.status !== 'ok') return output;
  parsed[LOCK_CONTENDED_OUTPUT_FIELD] = true;
  return JSON.stringify(parsed) + tail;
}

// ─── Gate Notice ──────────────────────────────────────────────────────────

export function buildGateNotice(
  gateBehavior: string | undefined,
  mode: string | undefined,
): string | null {
  if (gateBehavior !== 'auto_approve') return null;
  return (
    `Auto-approve is active (mode: ${mode ?? 'unknown'}). ` +
    'Plan and evidence review gates advance WITHOUT a human decision. ' +
    'Use team or regulated for human-gated approval.'
  );
}

/** Inject a non-null gateNotice into the JSON head of a hydrate output. */
export function injectGateNotice(output: string, notice: string | null): string {
  if (!notice) return output;
  const idx = output.indexOf('\n');
  const head = idx >= 0 ? output.slice(0, idx) : output;
  const tail = idx >= 0 ? output.slice(idx) : '';
  const parsed = JSON.parse(head) as Record<string, unknown>;
  if (parsed.error === true) return output;
  parsed.gateNotice = notice;
  return JSON.stringify(parsed) + tail;
}

/** Annotate a hydrate ToolResult with gateNotice (string or object form). */
export function withGateNotice(result: ToolResult, notice: string | null): ToolResult {
  if (!notice) return result;
  if (typeof result === 'string') return injectGateNotice(result, notice);
  return { ...result, output: injectGateNotice(result.output, notice) };
}
