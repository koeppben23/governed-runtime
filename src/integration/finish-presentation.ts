/**
 * @module integration/finish-presentation
 * @description Presentation builder for the /finish surface.
 *
 * Consumes the canonical FinishPresentationProjection and produces a typed
 * PresentationDocument for deterministic Markdown rendering.
 *
 * This builder ONLY arranges already-decided data — it never derives authority,
 * invents blocker text, recovery, or status labels. The conclusion is copied
 * mechanically from the projection.
 *
 * @version v1
 */

import { PHASE_LABELS } from '../presentation/phase-labels.js';
import type { Phase } from '../state/schema.js';
import {
  lookupStatusLabel,
  parseArchiveLabel,
  PresentationContractError,
  type PresentationDocument,
  type PresentationSection,
  type PresentationConclusion,
  type KeyValueItem,
} from '../presentation/index.js';
import type {
  FinishPresentationProjection,
  FinishConclusionProjection,
} from './status-why-finish.js';
import type { FinishCard } from './status.js';
import { buildProofGraphSection } from '../presentation/proof-summary.js';

// ─── Exit Option Copy ──────────────────────────────────────────────────────────

const EXIT_OPTION_LABELS = {
  abandon: 'Abandon this work',
} as const;

function resolveExitOptionLabel(id: string): string {
  if (!(id in EXIT_OPTION_LABELS)) {
    throw new PresentationContractError(
      `Unknown finish exit option: ${JSON.stringify(id)}. ` +
        `Known values: ${Object.keys(EXIT_OPTION_LABELS).join(', ')}.`,
    );
  }
  return EXIT_OPTION_LABELS[id as keyof typeof EXIT_OPTION_LABELS];
}

// ─── Public Builder ────────────────────────────────────────────────────────────

/**
 * Build a compact-card PresentationDocument for /finish.
 */
export function buildFinishDocument(
  projection: FinishPresentationProjection,
): PresentationDocument {
  const f = projection.card;
  const sections: PresentationSection[] = [];

  // 1. Status
  sections.push({
    kind: 'keyValue',
    heading: 'Status',
    items: [
      { label: 'Overall', value: lookupStatusLabel(f.overallStatus) },
      { label: 'Phase', value: PHASE_LABELS[f.phase as Phase] },
      { label: 'Policy', value: f.readiness.policyMode },
    ],
  });

  // 2. Blocked
  if (f.blocker.blocked && f.blocker.reasonText) {
    sections.push({
      kind: 'blocker',
      heading: 'Blocked',
      code: f.blocker.reasonCode,
      text: f.blocker.reasonText,
    });
  }

  // 3. Evidence
  sections.push(buildEvidenceSection(f));

  // 3b. ProofGraph
  if (f.proofSummary) {
    sections.push(buildProofGraphSection(f.proofSummary));
  }

  // 4. Archive
  if (f.readiness.archiveStatus) {
    sections.push({
      kind: 'keyValue',
      heading: 'Archive',
      items: [
        {
          label: 'Status',
          value: parseArchiveLabel(f.readiness.archiveStatus),
        },
      ],
    });
  }

  // 5. Warnings
  if (f.warnings.length > 0) {
    const firstWarning = f.warnings[0];
    if (!firstWarning) {
      throw new PresentationContractError(
        'FinishCard: warnings array must not contain undefined entry',
      );
    }
    sections.push({
      kind: 'notice',
      level: 'warning',
      heading: 'Warnings',
      message: firstWarning,
      additionalMessages: f.warnings.slice(1),
      details: [],
    });
  }

  // 6. Guidance
  sections.push({
    kind: 'guidance',
    heading: 'Guidance',
    items: f.actionGuidance.map((g) => ({
      action: g.action,
      status: g.status,
      reason: g.reason,
    })),
  });

  // 7. Exit options
  if (f.exitOptions.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: 'Exit options',
      items: f.exitOptions.map(resolveExitOptionLabel),
    });
  }

  // Conclusion — copied mechanically
  const conclusion = toFinishConclusion(projection.conclusion);

  return {
    kind: 'compact_card',
    density: 'compact',
    form: f.blocker.blocked ? 'blocked' : conclusion.kind === 'terminal' ? 'terminal' : 'success',
    sections,
    conclusion,
  };
}

// ─── Internal Builders ─────────────────────────────────────────────────────────

function buildEvidenceSection(finish: FinishCard): PresentationSection {
  const items: KeyValueItem[] = [
    { label: 'Verified', value: String(finish.evidence.summary.present) },
    { label: 'Missing', value: String(finish.evidence.summary.missing) },
    {
      label: 'Four eyes',
      value: finish.evidence.fourEyes.satisfied ? 'Satisfied' : 'Not satisfied',
    },
    ...(finish.evidence.summary.failed > 0
      ? [{ label: 'Failed', value: String(finish.evidence.summary.failed) }]
      : []),
  ];

  return {
    kind: 'keyValue',
    heading: 'Evidence',
    items,
  };
}

function toFinishConclusion(c: FinishConclusionProjection): PresentationConclusion {
  switch (c.kind) {
    case 'next_action':
      return { kind: 'next_action', action: { ...c.action } };
    case 'terminal':
      return { kind: 'terminal', message: c.message };
  }
}
