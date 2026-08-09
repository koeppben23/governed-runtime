/**
 * @module integration/status-presentation
 * @description Presentation builder for the FlowGuard status surface.
 *
 * Consumes the canonical status projection (status.ts) and produces a typed
 * PresentationDocument for deterministic Markdown rendering.
 *
 * This builder ONLY arranges already-decided data — it never derives authority,
 * invents blocker text, recovery, or status labels. The renderer enforces
 * spacing invariants; this module produces the semantic structure.
 *
 * @version v2
 */

import type { StatusProjection } from './status.js';
import type { DiscoveryHealthProjection } from '../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from './discovery-drift-status.js';
import { projectStatusActionFromCommand } from './status-conclusion.js';
import { isTerminalPhase } from '../machine/topology.js';
import { INSTALLED_COMMANDS } from './installed-commands.js';
import {
  normalizedMarkdown,
  lookupStatusLabel,
  projectReasonFromRegistry,
  type PresentationDocument,
  type PresentationSection,
  type PresentationConclusion,
  type PresentationAction,
  type PresentationForm,
  type PresentationBuildOptions,
  type PresentationDetailLevel,
  type KeyValueItem,
  type BlockerSection,
  type NoticeSection,
  type ReasonProjection,
} from '../presentation/index.js';
import { buildProofGraphSection } from '../presentation/proof-summary.js';
import type { ProofGraphRenderOptions } from '../presentation/proof-summary.js';
import { getInstalledCommand } from './installed-commands.js';

// ─── Presentation Input ────────────────────────────────────────────────────────

export interface FullStatusPresentationInput {
  readonly status: StatusProjection;
  readonly discoveryHealth: DiscoveryHealthProjection | null;
  readonly discoveryDrift: DiscoveryDriftStatusProjection;
  readonly remainingChecks?: string[];
}

// ─── Public Builders ───────────────────────────────────────────────────────────

/**
 * Build a compact-card PresentationDocument from the Full-Status projection.
 *
 * `detail` controls information density:
 *   summary     — compressed: immediate state, blocker headline, primary action
 *   explanation — causal: state, blocker explanation, recovery, relevant claims
 *   diagnostic  — full: canonical codes, raw states, structured detail
 *
 * Section order varies by detail level. Summary mode omits the full Evidence
 * section (substituted by compact notice when evidence causes NOT_VERIFIED)
 * and renders ProofGraph without a per-claim list.
 */
export function buildStatusDocument(
  input: FullStatusPresentationInput,
  options: PresentationBuildOptions = { detail: 'summary' },
): PresentationDocument {
  const { status, discoveryHealth, discoveryDrift, remainingChecks } = input;
  const detail = options.detail;
  const sections: PresentationSection[] = [];

  sections.push(buildStatusSection(status));

  if (status.blocker && status.blocker.reasonText) {
    sections.push(buildBlockerSection(status, detail));
  }

  buildEvidenceSection(status, detail, sections);

  sections.push(buildProofGraphSection(status.proofSummary, proofGraphOpts(detail, status)));

  if (detail !== 'summary' && status.allowedCommands.length > 0) {
    sections.push(buildAvailableActionsSection(status));
  }

  if (remainingChecks && remainingChecks.length > 0) {
    sections.push(buildRemainingChecksSection(remainingChecks));
  }

  appendDiscoveryAndFinish(sections, status, discoveryHealth, discoveryDrift);

  const conclusion = buildPresentationConclusion(status.conclusion);

  return {
    kind: 'compact_card',
    density: 'compact',
    form: presentationForm(
      status.blocker?.reasonText !== null && status.blocker?.reasonText !== undefined,
      conclusion,
    ),
    sections,
    conclusion,
  };
}

function appendDiscoveryAndFinish(
  sections: PresentationSection[],
  status: StatusProjection,
  discoveryHealth: DiscoveryHealthProjection | null,
  discoveryDrift: DiscoveryDriftStatusProjection,
): void {
  const discoverySection = buildDiscoveryNoticeSection(discoveryHealth, discoveryDrift);
  if (discoverySection) {
    sections.push(discoverySection);
  }
  const finishHint = buildFinishHintSection(status);
  if (finishHint) {
    sections.push(finishHint);
  }
}

function proofGraphOpts(
  detail: PresentationBuildOptions['detail'],
  _status: StatusProjection,
): ProofGraphRenderOptions {
  if (detail === 'diagnostic') return { detail: 'diagnostic' };
  if (detail === 'summary') return { claimVisibility: 'none' };
  // explanation: show all human claims
  return {};
}

/**
 * Build a PresentationDocument for the no-session state.
 */
export function buildNoSessionDocument(): PresentationDocument {
  const startCmd = getInstalledCommand('/start');
  if (!startCmd) {
    throw new Error('buildNoSessionDocument: no installed command metadata for "/start".');
  }
  return {
    kind: 'compact_card',
    density: 'compact',
    form: 'success',
    sections: [
      {
        kind: 'text',
        content: normalizedMarkdown('**No FlowGuard session found.**'),
      },
    ],
    conclusion: {
      kind: 'next_action',
      action: {
        invocation: startCmd.invocation,
        description: startCmd.description,
        visibility: 'recommended',
        ...(startCmd.intent ? { intent: startCmd.intent } : {}),
      },
    },
  };
}

// ─── Section Builders ──────────────────────────────────────────────────────────

function buildStatusSection(status: StatusProjection): PresentationSection {
  const items: KeyValueItem[] = [
    { label: 'Phase', value: status.phaseLabel },
    { label: 'Readiness', value: lookupStatusLabel(status.readiness) },
    { label: 'Policy', value: status.policyMode },
  ];
  return { kind: 'keyValue', heading: 'Status', items };
}

function buildBlockerSection(
  status: StatusProjection,
  detail: PresentationBuildOptions['detail'],
): BlockerSection {
  const blocker = status.blocker!;
  const reasonProjection = blocker.reasonCode
    ? projectReasonFromRegistry(blocker.reasonCode)
    : null;
  const recovery = reasonProjection?.recovery.primary;
  return {
    kind: 'blocker',
    heading: 'Blocked',
    code: detail === 'diagnostic' ? (blocker.reasonCode ?? null) : null,
    text: reasonProjection?.headline ?? blocker.reasonText!,
    ...(recovery ? { recovery } : {}),
    ...statusBlockerDetailFields(reasonProjection, detail),
  };
}

function statusBlockerDetailFields(
  projection: ReasonProjection | null,
  detail: PresentationDetailLevel,
): { explanation?: string; canonicalMessage?: string; impact?: string } {
  if (!projection) return {};

  switch (detail) {
    case 'summary':
      return {};

    case 'explanation':
      return {
        ...(projection.explanation ? { explanation: projection.explanation } : {}),
      };

    case 'diagnostic':
      return {
        ...(projection.explanation ? { explanation: projection.explanation } : {}),
        ...(projection.canonicalMessage ? { canonicalMessage: projection.canonicalMessage } : {}),
      };
  }
}

function buildEvidenceSection(
  status: StatusProjection,
  detail: PresentationBuildOptions['detail'],
  sections: PresentationSection[],
): void {
  const { evidenceSummary } = status;

  if (detail === 'diagnostic' || detail === 'explanation') {
    sections.push({
      kind: 'keyValue',
      heading: 'Evidence',
      items: [
        { label: 'Verified', value: String(evidenceSummary.present) },
        { label: 'Missing', value: String(evidenceSummary.missing) },
        { label: 'Not yet required', value: String(evidenceSummary.notYetRequired) },
        ...(evidenceSummary.failed > 0
          ? [{ label: 'Failed', value: String(evidenceSummary.failed) }]
          : []),
      ],
    });
    return;
  }

  // Summary mode: compact notice only when evidence incompleteness is
  // materially relevant (NOT_VERIFIED caused by missing/failed evidence)
  if (
    status.readiness === 'NOT_VERIFIED' &&
    (evidenceSummary.missing > 0 || evidenceSummary.failed > 0)
  ) {
    const parts: string[] = [];
    if (evidenceSummary.missing > 0) parts.push(`${evidenceSummary.missing} missing`);
    if (evidenceSummary.failed > 0) parts.push(`${evidenceSummary.failed} failed`);
    sections.push({
      kind: 'notice',
      level: 'not_verified',
      message: `Evidence is incomplete: ${parts.join(', ')}.`,
      details: [],
    });
  }
}

function buildAvailableActionsSection(status: StatusProjection): PresentationSection {
  const items: PresentationAction[] = status.allowedCommands.map((invocation: string) => {
    const p = projectStatusActionFromCommand(invocation, 'available');
    return { invocation: p.invocation, description: p.description, visibility: p.visibility };
  });

  return { kind: 'commandList', heading: 'Available actions', items };
}

function buildRemainingChecksSection(checks: string[]): PresentationSection {
  return {
    kind: 'checklist',
    heading: 'Remaining checks',
    items: checks.map((id) => ({ text: id, checked: false })),
  };
}

/**
 * Description for the /finish hint, sourced verbatim from the installed-command
 * registry (single source of truth) rather than duplicated here.
 */
const FINISH_INVOCATION = '/finish';
const FINISH_DESCRIPTION =
  INSTALLED_COMMANDS.find((c) => c.invocation === FINISH_INVOCATION)?.description ?? '';

/**
 * Build the terminal-phase /finish hint, or null when the phase is not terminal.
 *
 * Heading-less bulletList so it renders as a plain `• /finish — …` line above
 * the canonical conclusion, never mistaken for the next-action authority.
 */
function buildFinishHintSection(status: StatusProjection): PresentationSection | null {
  if (!isTerminalPhase(status.phase)) return null;
  if (FINISH_DESCRIPTION.length === 0) return null;
  return {
    kind: 'bulletList',
    items: [`\`${FINISH_INVOCATION}\` — ${FINISH_DESCRIPTION}`],
  };
}

function buildDiscoveryNoticeSection(
  discoveryHealth: DiscoveryHealthProjection | null,
  discoveryDrift: DiscoveryDriftStatusProjection,
): NoticeSection | null {
  if (!discoveryHealth) return null;
  if (discoveryHealth.healthy) {
    const driftNotVerified = discoveryDrift.notVerified.filter(
      (n: string) => !n.startsWith('NOT_VERIFIED:'),
    );
    if (driftNotVerified.length === 0) return null;

    return {
      kind: 'notice',
      level: 'not_verified',
      heading: 'Discovery',
      message: 'Discovery drift could not be verified.',
      details: [
        { label: 'Status', value: discoveryDrift.status },
        { label: 'Not verified', value: driftNotVerified.join(', ') },
      ],
    };
  }

  const notVerifiedClaims = [
    ...(discoveryHealth.status === 'unavailable' ? discoveryHealth.notVerified : []),
    ...discoveryDrift.notVerified.filter((n: string) => !n.startsWith('NOT_VERIFIED:')),
  ];

  return {
    kind: 'notice',
    level: 'warning',
    heading: 'Discovery',
    message: 'Discovery data is degraded or unavailable. Runtime workflow authority is unchanged.',
    details: [
      ...(discoveryHealth.status === 'unavailable'
        ? [
            { label: 'Reason', value: discoveryHealth.reason },
            { label: 'Recovery', value: discoveryHealth.recovery },
          ]
        : []),
      ...(notVerifiedClaims.length > 0
        ? [{ label: 'Not verified', value: notVerifiedClaims.join(', ') }]
        : []),
    ],
  };
}

// ─── Conclusion Builder ────────────────────────────────────────────────────────

function buildPresentationConclusion(
  conclusion: StatusProjection['conclusion'],
): PresentationConclusion {
  switch (conclusion.kind) {
    case 'next_action':
      return { kind: 'next_action', action: conclusion.action };
    case 'decision_required':
      return {
        kind: 'decision_required',
        question: conclusion.question,
        actions: conclusion.actions,
      };
    case 'terminal':
      return { kind: 'terminal', message: conclusion.message };
    case 'review_pending':
      return { kind: 'review_pending', message: conclusion.message };
  }
}

function presentationForm(blocked: boolean, conclusion: PresentationConclusion): PresentationForm {
  if (conclusion.kind === 'review_pending') return 'review_pending';
  if (conclusion.kind === 'decision_required') return 'decision';
  if (blocked) return 'blocked';
  if (conclusion.kind === 'terminal') return 'terminal';
  return 'success';
}
