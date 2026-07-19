/**
 * @module integration/why-presentation
 * @description Presentation builder for the /why surface.
 *
 * Consumes the canonical WhyPresentationProjection and produces a typed
 * PresentationDocument for deterministic Markdown rendering.
 *
 * This builder ONLY arranges already-decided data — it never derives authority,
 * invents blocker text, recovery, or status labels. The conclusion is copied
 * mechanically from the projection.
 *
 * @version v1
 */

import type {
  PresentationDocument,
  PresentationSection,
  PresentationConclusion,
} from '../presentation/index.js';
import type { WhyPresentationProjection, WhyConclusionProjection } from './status-why-finish.js';

/**
 * Build a compact-card PresentationDocument for /why.
 */
export function buildWhyDocument(projection: WhyPresentationProjection): PresentationDocument {
  const sections: PresentationSection[] = [];

  // Status
  sections.push({
    kind: 'keyValue',
    heading: 'Status',
    items: [
      { label: 'Blocked', value: projection.blocker.blocked ? 'Blocked' : 'No' },
      { label: 'Phase', value: projection.phaseLabel },
    ],
  });

  // Blocker / Evidence-required detail
  const hasBlockerDetail =
    projection.blocker.reasonCode !== null || projection.blocker.reasonText !== null;

  if (hasBlockerDetail && projection.blocker.reasonText) {
    sections.push({
      kind: 'blocker',
      heading: projection.blocker.blocked ? 'Blocked' : 'Evidence required',
      code: projection.blocker.reasonCode,
      text: projection.blocker.reasonText,
      ...(projection.blocker.recoveryHint ? { recovery: projection.blocker.recoveryHint } : {}),
    });
  }

  // Missing evidence
  if (projection.evidenceSlots.length > 0) {
    sections.push({
      kind: 'artifactList',
      heading: 'Missing evidence',
      items: projection.evidenceSlots.map((slot) => ({
        slot: slot.slot,
        label: slot.label,
        status: slot.status,
        required: true,
        hint: slot.hint ?? undefined,
      })),
    });
  }

  // Conclusion — copied mechanically, not derived
  const conclusion = toPresentationConclusion(projection.conclusion);

  return {
    kind: 'compact_card',
    density: 'compact',
    sections,
    conclusion,
  };
}

function toPresentationConclusion(c: WhyConclusionProjection): PresentationConclusion {
  switch (c.kind) {
    case 'next_action':
      return { kind: 'next_action', action: { ...c.action } };
    case 'decision_required':
      return {
        kind: 'decision_required',
        question: c.question,
        actions: c.actions.map((a) => ({ ...a })),
      };
  }
}
