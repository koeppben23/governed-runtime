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
 * @version v1
 */

import type { StatusProjection, StatusActionProjection } from './status.js';
import type { DiscoveryHealthProjection } from '../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from './discovery-drift-status.js';
import {
  normalizedMarkdown,
  type PresentationDocument,
  type PresentationSection,
  type PresentationConclusion,
  type PresentationAction,
  type KeyValueItem,
  type BlockerSection,
  type NoticeSection,
} from '../presentation/index.js';

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
 * Renders sections in UX-optimised order:
 *   1. Status (phase, readiness, policy)
 *   2. Blocked (only when blocked)
 *   3. Evidence summary
 *   4. Available actions
 *   5. Notice (Discovery warnings / not-verified)
 *   6. Conclusion
 */
export function buildStatusDocument(input: FullStatusPresentationInput): PresentationDocument {
  const { status, discoveryHealth, discoveryDrift, remainingChecks } = input;
  const sections: PresentationSection[] = [];

  // 1. Status
  const statusItems: KeyValueItem[] = [
    { label: 'Phase', value: status.phaseLabel },
    { label: 'Policy', value: status.policyMode },
  ];
  sections.push({ kind: 'keyValue', items: statusItems });

  // 2. Blocked
  if (status.blocker && status.blocker.reasonText) {
    sections.push(buildBlockerSection(status));
  }

  // 3. Evidence summary
  sections.push(buildEvidenceSection(status));

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

  // 7. Conclusion
  const conclusion = buildPresentationConclusion(status.conclusion);

  return {
    kind: 'compact_card',
    density: 'compact',
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
    sections: [
      {
        kind: 'text',
        content: normalizedMarkdown('**No FlowGuard session found.**'),
      },
    ],
    conclusion: {
      kind: 'next_action',
      action: {
        invocation: '/hydrate',
        description: 'Prepare or restore a governed session.',
        visibility: 'recommended',
      },
    },
  };
}

// ─── Section Builders ──────────────────────────────────────────────────────────

function buildBlockerSection(status: StatusProjection): BlockerSection {
  const blocker = status.blocker!;
  return {
    kind: 'blocker',
    code: blocker.reasonCode ?? 'BLOCKED',
    text: blocker.reasonText!,
    ...(status.productNextAction.summary ? { recovery: status.productNextAction.summary } : {}),
  };
}

function buildEvidenceSection(status: StatusProjection): PresentationSection {
  const { evidenceSummary } = status;
  return {
    kind: 'keyValue',
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
  const items: PresentationAction[] = status.allowedCommands.map((invocation: string) => ({
    invocation,
    description: '', // populated below if installed metadata exists
    visibility: 'available' as const,
  }));

  return { kind: 'commandList', items };
}

function buildRemainingChecksSection(checks: string[]): PresentationSection {
  return {
    kind: 'checklist',
    label: 'Remaining checks',
    items: checks.map((id) => ({ text: id, checked: false })),
  };
}

function buildDiscoveryNoticeSection(
  discoveryHealth: DiscoveryHealthProjection | null,
  discoveryDrift: DiscoveryDriftStatusProjection,
): NoticeSection | null {
  if (!discoveryHealth) return null;
  if (discoveryHealth.healthy) {
    // Only surface drift if healthy (degraded covers both)
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
  }
}

function toPresentationAction(action: StatusActionProjection): PresentationAction {
  return {
    invocation: action.invocation,
    description: action.description,
    visibility: action.visibility,
  };
}
