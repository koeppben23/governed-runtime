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

import type { StatusProjection, StatusActionProjection } from './status.js';
import type { DiscoveryHealthProjection } from '../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from './discovery-drift-status.js';
import { projectStatusActionFromCommand } from './status-conclusion.js';
import { isTerminalPhase } from '../machine/topology.js';
import { INSTALLED_COMMANDS } from './installed-commands.js';
import {
  normalizedMarkdown,
  lookupStatusLabel,
  type PresentationDocument,
  type PresentationSection,
  type PresentationConclusion,
  type PresentationAction,
  type PresentationForm,
  type KeyValueItem,
  type BlockerSection,
  type NoticeSection,
} from '../presentation/index.js';
import { buildProofGraphSection } from '../presentation/proof-summary.js';

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
 * Renders sections with `##` headings in UX-optimised order:
 *   1. ## Status (phase, readiness, policy)
 *   2. ## Blocked (only when blocked)
 *   3. ## Evidence summary
 *   4. ## Available actions
 *   5. ## Remaining checks (VALIDATION phase only)
 *   6. ## Notice (Discovery warnings / not-verified)
 *   7. Conclusion (no heading — inline at document end)
 */
export function buildStatusDocument(input: FullStatusPresentationInput): PresentationDocument {
  const { status, discoveryHealth, discoveryDrift, remainingChecks } = input;
  const sections: PresentationSection[] = [];

  // 1. Status
  sections.push(buildStatusSection(status));

  // 2. Blocked
  if (status.blocker && status.blocker.reasonText) {
    sections.push(buildBlockerSection(status));
  }

  // 3. Evidence summary
  sections.push(buildEvidenceSection(status));

  // 3b. ProofGraph is mandatory for every resolved governance status.
  sections.push(buildProofGraphSection(status.proofSummary));

  // 4. Available actions
  if (status.allowedCommands.length > 0) {
    sections.push(buildAvailableActionsSection(status));
  }

  // 5. Remaining checks (VALIDATION phase)
  if (remainingChecks && remainingChecks.length > 0) {
    sections.push(buildRemainingChecksSection(remainingChecks));
  }

  // 6. Discovery notices
  const discoverySection = buildDiscoveryNoticeSection(discoveryHealth, discoveryDrift);
  if (discoverySection) {
    sections.push(discoverySection);
  }

  // 7. Finish-readiness hint (terminal phases only).
  //    /finish is an operational, read-only status aggregator — it is NOT a
  //    workflow command and therefore never appears in `allowedCommands` or as a
  //    next-action. At the workflow end we surface it as a plain hint, clearly
  //    separated from the canonical `→ /export` conclusion, without a heading so
  //    it is not mistaken for next-action authority.
  const finishHint = buildFinishHintSection(status);
  if (finishHint) {
    sections.push(finishHint);
  }

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

/**
 * Build a PresentationDocument for the no-session state.
 */
export function buildNoSessionDocument(): PresentationDocument {
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
        invocation: '/start',
        description: 'Start or restore a governed session.',
        visibility: 'recommended',
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

function buildBlockerSection(status: StatusProjection): BlockerSection {
  const blocker = status.blocker!;
  return {
    kind: 'blocker',
    heading: 'Blocked',
    code: blocker.reasonCode ?? null,
    text: blocker.reasonText!,
    // recovery must come from the canonical projection, not from
    // general next-action copy — omitted until the projection carries it
  };
}

function buildEvidenceSection(status: StatusProjection): PresentationSection {
  const { evidenceSummary } = status;
  return {
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
  };
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
      return {
        kind: 'next_action',
        action: toPresentationAction(conclusion.action),
      };
    case 'decision_required':
      return {
        kind: 'decision_required',
        question: conclusion.question,
        actions: conclusion.actions.map(toPresentationAction),
      };
    case 'terminal':
      return {
        kind: 'terminal',
        message: conclusion.message,
      };
    case 'review_pending':
      return {
        kind: 'review_pending',
        message: conclusion.message,
      };
  }
}

function toPresentationAction(action: StatusActionProjection): PresentationAction {
  return {
    invocation: action.invocation,
    description: action.description,
    visibility: action.visibility,
  };
}

function presentationForm(blocked: boolean, conclusion: PresentationConclusion): PresentationForm {
  if (conclusion.kind === 'review_pending') return 'review_pending';
  if (conclusion.kind === 'decision_required') return 'decision';
  if (blocked) return 'blocked';
  if (conclusion.kind === 'terminal') return 'terminal';
  return 'success';
}
