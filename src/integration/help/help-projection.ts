/**
 * @module integration/help/help-projection
 * @description Read-only contextual help projection over canonical runtime state.
 */

import type { FlowGuardPolicy } from '../../config/policy.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewReport } from '../../state/evidence.js';
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { directiveLabel } from '../../presentation/directive-copy.js';
import { buildStatusProjection } from '../status/status.js';
import { buildEvidenceDetailProjection } from '../status/status-detail-projections.js';
import type { FinishOverallStatus } from '../status/status-types.js';
import { buildFinishCard } from '../status/status-finish.js';
import {
  COMMAND_CATALOG,
  DEFAULT_HELP_CAPABILITIES,
  commandAvailability,
  getCatalogCommand,
  type CapabilityMap,
  type CommandCatalogEntry,
  type HelpCapabilities,
} from './command-catalog.js';
import {
  catalogPreflight,
  findRecommendation,
  projectCatalogCommand,
  type ProjectedCommand,
} from './command-projection.js';
import {
  resolveCurrentReviewReport,
  type ReviewReportResolution,
} from '../review/evidence/report-coherence.js';
import { IntegrationInvariantError } from '../errors.js';

export type { HelpVisibility, ProjectedCommand } from './command-projection.js';

export type CommandScope = 'available' | 'all' | 'detail';

export type Readiness = 'ready' | 'ready_with_warnings' | 'blocked' | 'not_verified' | 'none';

export interface EvidenceCompleteness {
  readonly status: 'complete' | 'incomplete' | 'failed' | 'not_applicable';
  readonly summary: string;
}

export interface ArchiveVerification {
  readonly packagePurpose: 'sharing' | 'auditor' | null;
  readonly integrityCapability: 'verifiable' | 'not_verifiable' | null;
  readonly verificationStatus: 'not_run' | 'passed' | 'failed' | null;
  readonly currentSnapshotVerified: boolean;
  readonly summary: string;
}

export interface RecommendationQuality {
  readonly quality: 'clean' | 'warnings' | 'issues' | 'not_applicable';
  readonly advisoryStatus: 'ready' | 'ready_with_warnings' | 'changes_required' | 'not_applicable';
  readonly summary: string;
}

export interface ArtifactSlot {
  readonly status: 'available' | 'not_verified';
  readonly digest: string | null;
  readonly preview: string | null;
  readonly content: string | null;
  readonly workflowNextAction: string | null;
}

export interface HelpArtifacts {
  readonly ticket: ArtifactSlot;
  readonly currentPlan: ArtifactSlot;
  readonly currentPlanVersion: number | null;
  readonly status: 'available' | 'partial' | 'not_verified';
}

export interface HelpBlocker {
  readonly reasonCode: string | null;
  readonly message: string | null;
}

export interface HelpResult {
  readonly phase: Readonly<{ id: string; label: string }> | null;
  readonly lifecycle: string;
  readonly readiness: Readiness;
  readonly recommendationQuality: RecommendationQuality;
  readonly reviewReportStatus: 'current' | 'stale' | 'foreign' | 'incoherent' | 'not_available';
  readonly nextActionSummary: string;
  readonly evidenceCompleteness: EvidenceCompleteness;
  readonly archiveVerification: ArchiveVerification;
  readonly directive: ProjectedCommand | null;
  readonly commands: readonly ProjectedCommand[];
  readonly commandScope: CommandScope;
  /** Capability snapshot used for this projection. */
  readonly capabilities: CapabilityMap;
  /** `host` when supplied by trusted host composition; `default` otherwise. */
  readonly capabilitySource: 'host' | 'default';
  readonly artifacts: HelpArtifacts;
  readonly blocker: HelpBlocker | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const EMPTY_ARTIFACT_SLOT: ArtifactSlot = {
  status: 'not_verified',
  digest: null,
  preview: null,
  content: null,
  workflowNextAction: null,
};

const EMPTY_ARTIFACTS: HelpArtifacts = {
  ticket: EMPTY_ARTIFACT_SLOT,
  currentPlan: EMPTY_ARTIFACT_SLOT,
  currentPlanVersion: null,
  status: 'not_verified',
};

function firstLinePreview(body: string): string {
  const idx = body.indexOf('\n');
  const line = idx === -1 ? body : body.slice(0, idx);
  return line.length <= 200 ? line : line.slice(0, 197) + '...';
}

function buildArtifactSlot(
  evidence: { text?: string; body?: string; digest?: string } | null | undefined,
  includeContent: boolean,
  nextActionSummary: string,
): ArtifactSlot {
  const text = evidence ? (evidence.text ?? evidence.body ?? null) : null;
  const digest = evidence?.digest ?? null;
  if (text) {
    return {
      status: 'available',
      digest,
      preview: firstLinePreview(text),
      content: includeContent ? text : null,
      workflowNextAction: null,
    };
  }
  return {
    status: 'not_verified',
    digest: null,
    preview: null,
    content: null,
    workflowNextAction: nextActionSummary,
  };
}

function artifactsStatus(tAvailable: boolean, pAvailable: boolean): HelpArtifacts['status'] {
  if (tAvailable && pAvailable) return 'available';
  if (tAvailable || pAvailable) return 'partial';
  return 'not_verified';
}

function buildArtifacts(
  state: SessionState | null,
  includeContent: boolean,
  nextActionSummary: string,
): HelpArtifacts {
  if (!state) return EMPTY_ARTIFACTS;

  const ticketSlot = buildArtifactSlot(state.ticket, includeContent, nextActionSummary);
  const planSlot = buildArtifactSlot(state.plan?.current, includeContent, nextActionSummary);

  return {
    ticket: ticketSlot,
    currentPlan: planSlot,
    currentPlanVersion: state.plan ? (state.plan.history?.length ?? 0) + 1 : null,
    status: artifactsStatus(ticketSlot.status === 'available', planSlot.status === 'available'),
  };
}

function buildBlocker(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
): HelpBlocker | null {
  if (!state || !policy) return null;
  const status = buildStatusProjection(state, policy);
  if (status.blocker?.reasonCode || status.blocker?.reasonText) {
    return {
      reasonCode: status.blocker.reasonCode,
      message: status.blocker.reasonText,
    };
  }
  if (state.discoveryHealthGate?.status === 'blocked') {
    return {
      reasonCode: state.discoveryHealthGate.code ?? null,
      message: state.discoveryHealthGate.message ?? null,
    };
  }
  return null;
}

export function finishToReadiness(overallStatus: FinishOverallStatus): Readiness {
  switch (overallStatus) {
    case 'IN_PROGRESS':
      return 'none';
    case 'READY':
      return 'ready';
    case 'READY_WITH_WARNINGS':
      return 'ready_with_warnings';
    case 'BLOCKED':
      return 'blocked';
    case 'NOT_VERIFIED':
      return 'not_verified';
    case 'CHANGES_REQUIRED':
      return 'ready_with_warnings';
  }
}

function projectRecommendationQuality(
  reportResolution: ReviewReportResolution | null,
): RecommendationQuality {
  if (!reportResolution || reportResolution.status !== 'current') {
    return {
      quality: 'not_applicable',
      advisoryStatus: 'not_applicable',
      summary: 'No current peer review recommendation is available.',
    };
  }
  switch (reportResolution.report.overallStatus) {
    case 'clean':
      return {
        quality: 'clean',
        advisoryStatus: 'ready',
        summary: 'No advisory findings. The review found no issues.',
      };
    case 'warnings':
      return {
        quality: 'warnings',
        advisoryStatus: 'ready_with_warnings',
        summary: 'Review found warnings. They are advisory and do not block export.',
      };
    case 'issues':
      return {
        quality: 'issues',
        advisoryStatus: 'changes_required',
        summary: 'Peer review found issues. Changes are recommended but do not block export.',
      };
  }
}

function buildEvidenceCompleteness(state: SessionState | null): EvidenceCompleteness {
  if (!state) return { status: 'not_applicable', summary: 'No session is available to assess.' };
  const evidence = buildEvidenceDetailProjection(state);
  if (evidence.overallComplete) {
    return { status: 'complete', summary: 'Required evidence is present.' };
  }
  const hasFailed = evidence.slots.some((slot) => slot.required && slot.status === 'failed');
  if (hasFailed) {
    return { status: 'failed', summary: 'One or more required evidence slots have failed checks.' };
  }
  return { status: 'incomplete', summary: 'Required evidence is incomplete.' };
}

function buildArchiveVerification(state: SessionState | null): ArchiveVerification {
  if (!state)
    return {
      packagePurpose: null,
      integrityCapability: null,
      verificationStatus: null,
      currentSnapshotVerified: false,
      summary: 'No session is available for archive verification.',
    };
  if (state.lastExportVerificationStatus === 'passed') {
    return {
      packagePurpose: state.lastExportPackagePurpose ?? null,
      integrityCapability: state.lastExportIntegrityCapability ?? null,
      verificationStatus: 'passed',
      currentSnapshotVerified: false,
      summary:
        'A previous audit package verification succeeded. Current snapshot freshness is not established.',
    };
  }
  if (state.lastExportIntegrityCapability === 'not_verifiable') {
    return {
      packagePurpose: state.lastExportPackagePurpose ?? 'sharing',
      integrityCapability: 'not_verifiable',
      verificationStatus: state.lastExportVerificationStatus ?? 'not_run',
      currentSnapshotVerified: false,
      summary:
        'A redacted sharing archive was created. It intentionally excludes raw evidence, so canonical audit-chain verification is unavailable.',
    };
  }
  if (state.lastExportVerificationStatus === 'failed') {
    return {
      packagePurpose: state.lastExportPackagePurpose ?? null,
      integrityCapability: state.lastExportIntegrityCapability ?? 'verifiable',
      verificationStatus: 'failed',
      currentSnapshotVerified: false,
      summary: 'Audit package verification failed. Inspect status before retrying export.',
    };
  }
  return {
    packagePurpose: null,
    integrityCapability: null,
    verificationStatus: null,
    currentSnapshotVerified: false,
    summary: 'No audit package has been created yet.',
  };
}

function buildCommandDetail(
  state: SessionState | null,
  requestedInvocation: string,
  capabilities: HelpCapabilities,
  capabilitySource: 'host' | 'default',
): HelpResult {
  const entry = getCatalogCommand(requestedInvocation);
  const command = entry ? projectCatalogCommand(entry, state, capabilities, null) : null;
  return {
    phase: state ? { id: state.phase, label: PHASE_LABELS[state.phase] } : null,
    lifecycle: state ? PHASE_LABELS[state.phase] : 'No active session',
    readiness: 'none',
    recommendationQuality: {
      quality: 'not_applicable',
      advisoryStatus: 'not_applicable',
      summary: '',
    },
    reviewReportStatus: 'not_available',
    nextActionSummary: command ? command.description : 'Unknown FlowGuard command.',
    evidenceCompleteness: buildEvidenceCompleteness(state),
    archiveVerification: buildArchiveVerification(state),
    directive: null,
    commands: command ? [command] : [],
    commandScope: 'detail',
    capabilities,
    capabilitySource,
    artifacts: EMPTY_ARTIFACTS,
    blocker: null,
  };
}

function noSessionCommand(
  invocation: string,
  capabilities: HelpCapabilities,
  recommendedInvocation: string | null,
): ProjectedCommand {
  const entry = getCatalogCommand(invocation);
  if (entry === undefined) {
    throw new IntegrationInvariantError(
      'HELP_COMMAND_METADATA_MISSING',
      `buildNoSessionResult: no command metadata for ${invocation}.`,
    );
  }
  return projectCatalogCommand(entry, null, capabilities, recommendedInvocation);
}

function noSessionDirective(capabilities: HelpCapabilities): ProjectedCommand | null {
  const start = noSessionCommand('/start', capabilities, '/start');
  return start.availability === 'available' ? start : null;
}

function buildNoSessionResult(
  capabilities: HelpCapabilities,
  capabilitySource: 'host' | 'default',
): HelpResult {
  return {
    phase: null,
    lifecycle: 'No active session',
    readiness: 'none',
    recommendationQuality: {
      quality: 'not_applicable',
      advisoryStatus: 'not_applicable',
      summary: '',
    },
    reviewReportStatus: 'not_available',
    nextActionSummary: 'Start a governed session.',
    evidenceCompleteness: buildEvidenceCompleteness(null),
    archiveVerification: buildArchiveVerification(null),
    directive: noSessionDirective(capabilities),
    commands: [
      noSessionCommand('/start', capabilities, '/start'),
      noSessionCommand('/status', capabilities, '/start'),
    ],
    commandScope: 'available',
    capabilities,
    capabilitySource,
    artifacts: EMPTY_ARTIFACTS,
    blocker: null,
  };
}

function buildNoSessionCatalogResult(
  capabilities: HelpCapabilities,
  capabilitySource: 'host' | 'default',
): HelpResult {
  const commands = COMMAND_CATALOG.filter((entry) => entry.public).map((entry) =>
    projectCatalogCommand(entry, null, capabilities, '/start'),
  );
  return {
    phase: null,
    lifecycle: 'No active session',
    readiness: 'none',
    recommendationQuality: {
      quality: 'not_applicable',
      advisoryStatus: 'not_applicable',
      summary: '',
    },
    reviewReportStatus: 'not_available',
    nextActionSummary: 'Start a governed session.',
    evidenceCompleteness: buildEvidenceCompleteness(null),
    archiveVerification: buildArchiveVerification(null),
    directive: noSessionDirective(capabilities),
    commands,
    commandScope: 'all',
    capabilities,
    capabilitySource,
    artifacts: EMPTY_ARTIFACTS,
    blocker: null,
  };
}

function isEntryVisible(
  entry: CommandCatalogEntry,
  scope: 'available' | 'all',
  state: SessionState,
  capabilities: HelpCapabilities,
): boolean {
  if (!entry.public) return false;
  if (scope === 'all') return true;
  if (entry.visibility !== 'primary') return false;
  if (commandAvailability(entry, capabilities) !== 'available') return false;
  return catalogPreflight(entry, state).status === 'available';
}

function resolveReport(
  state: SessionState,
  reviewReport?: ReviewReport,
): ReviewReportResolution | null {
  if (!reviewReport) return null;
  return resolveCurrentReviewReport(state, reviewReport);
}
interface SessionHelpOpts {
  readonly state: SessionState;
  readonly policy: FlowGuardPolicy;
  readonly view: 'context' | 'commands';
  readonly scope: 'available' | 'all';
  readonly reportResolution: ReviewReportResolution | null;
  readonly includeArtifactContent: boolean;
  readonly capabilities: HelpCapabilities;
  readonly capabilitySource: 'host' | 'default';
}

function projectHelpNext(
  status: ReturnType<typeof buildStatusProjection>,
  state: SessionState,
  recommended: CommandCatalogEntry | undefined,
  capabilities: HelpCapabilities,
): Pick<HelpResult, 'directive' | 'nextActionSummary'> {
  const chooseFlow = status.directive.code === 'CHOOSE_FLOW';
  const candidateNext = recommended
    ? projectCatalogCommand(recommended, state, capabilities, recommended.invocation)
    : null;
  if (chooseFlow && status.conclusion.kind === 'decision_required') {
    const choices = status.conclusion.actions.map((action) =>
      action.description.toLowerCase().includes('recommended')
        ? `${action.invocation} (recommended)`
        : action.invocation,
    );
    return {
      directive: null,
      nextActionSummary: `${status.conclusion.question} ${choices.join(', ')}`,
    };
  }
  return {
    directive:
      candidateNext?.availability === 'available' && candidateNext.preflight.status === 'available'
        ? candidateNext
        : null,
    nextActionSummary: status.blocker?.reasonText ?? directiveLabel(status.directive.code),
  };
}

function buildSessionHelpResult(opts: SessionHelpOpts): HelpResult {
  const {
    state,
    policy,
    view,
    scope,
    reportResolution,
    includeArtifactContent,
    capabilities,
    capabilitySource,
  } = opts;
  const currentReport = reportResolution?.status === 'current' ? reportResolution.report : null;

  const status = buildStatusProjection(state, policy);
  const finish = buildFinishCard(state, policy, currentReport);
  const readiness = finishToReadiness(finish.overallStatus);
  const recommendationQuality = projectRecommendationQuality(reportResolution);
  const recommended = findRecommendation(status.directive.commands[0] ?? null);
  const next = projectHelpNext(status, state, recommended, capabilities);

  const commands = COMMAND_CATALOG.filter((entry) =>
    isEntryVisible(entry, scope, state, capabilities),
  ).map((entry) =>
    projectCatalogCommand(entry, state, capabilities, recommended?.invocation ?? null),
  );
  const contextCommands = view === 'context' ? limitContextCommands(commands) : commands;

  return {
    phase: { id: state.phase, label: PHASE_LABELS[state.phase] },
    lifecycle: PHASE_LABELS[state.phase],
    readiness,
    recommendationQuality,
    reviewReportStatus: reportResolution?.status ?? 'not_available',
    nextActionSummary: next.nextActionSummary,
    evidenceCompleteness: buildEvidenceCompleteness(state),
    archiveVerification: buildArchiveVerification(state),
    directive: next.directive,
    commands: contextCommands,
    commandScope: scope,
    capabilities,
    capabilitySource,
    artifacts: buildArtifacts(state, includeArtifactContent, directiveLabel(status.directive.code)),
    blocker: buildBlocker(state, policy),
  };
}

export function buildHelpResult(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
  opts: {
    view: 'context' | 'commands' | 'command';
    scope?: 'available' | 'all';
    requestedInvocation?: string;
    reviewReport?: ReviewReport;
    includeArtifactContent?: boolean;
    capabilities?: HelpCapabilities;
  },
): HelpResult {
  const capabilities = opts.capabilities ?? DEFAULT_HELP_CAPABILITIES;
  const capabilitySource = opts.capabilities === undefined ? 'default' : 'host';
  if (opts.requestedInvocation)
    return buildCommandDetail(state, opts.requestedInvocation, capabilities, capabilitySource);
  if (!state || !policy) {
    return opts.view === 'commands' && (opts.scope ?? 'available') === 'all'
      ? buildNoSessionCatalogResult(capabilities, capabilitySource)
      : buildNoSessionResult(capabilities, capabilitySource);
  }

  // After the early returns, view is always 'context' or 'commands'.
  const view = opts.view as 'context' | 'commands';
  return buildSessionHelpResult({
    state,
    policy,
    view,
    scope: opts.scope ?? 'available',
    reportResolution: resolveReport(state, opts.reviewReport),
    includeArtifactContent: opts.includeArtifactContent ?? false,
    capabilities,
    capabilitySource,
  });
}

function limitContextCommands(commands: readonly ProjectedCommand[]): readonly ProjectedCommand[] {
  const recommended = commands.filter((command) => command.visibility === 'recommended');
  const available = commands.filter(
    (command) => command.visibility === 'available' && command.id !== recommended[0]?.id,
  );
  const upcoming = commands
    .filter(
      (command) =>
        command.visibility === 'blocked_recoverable' && command.id !== recommended[0]?.id,
    )
    .slice(0, 2);

  return [...recommended, ...available.slice(0, 5), ...upcoming];
}
