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
  PresentationBuildOptions,
  PresentationDetailLevel,
  ReasonProjection,
} from '../presentation/index.js';
import { projectReasonFromRegistry } from '../presentation/index.js';
import type { WhyPresentationProjection, WhyConclusionProjection } from './status-why-finish.js';
import type { CompactProofPresentation } from '../presentation/proof-model.js';
import { buildProofGraphSection } from '../presentation/proof-summary.js';
import type { ProofGraphRenderOptions } from '../presentation/proof-summary.js';

/**
 * Build a compact-card PresentationDocument for /why.
 *
 * `detail` controls information density:
 *   explanation — default: cause, impact, recovery, relevant unresolved claims
 *   diagnostic  — full canonical codes, raw states, structured detail
 */
export function buildWhyDocument(
  projection: WhyPresentationProjection,
  options: PresentationBuildOptions = { detail: 'explanation' },
): PresentationDocument {
  const detail = options.detail;
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
  const blockerSection = buildBlockerSection(projection, detail);
  if (blockerSection) sections.push(blockerSection);

  // Missing evidence — show in explanation+ detail
  if (detail !== 'summary' && projection.evidenceSlots.length > 0) {
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

  sections.push(
    buildProofGraphSection(
      projection.proofSummary,
      whyProofGraphOpts(detail, projection.proofSummary),
    ),
  );

  // Conclusion — copied mechanically, not derived
  const conclusion = toPresentationConclusion(projection.conclusion);

  return {
    kind: 'compact_card',
    density: 'compact',
    form:
      conclusion.kind === 'decision_required'
        ? 'decision'
        : projection.blocker.blocked
          ? 'blocked'
          : 'success',
    sections,
    conclusion,
  };
}

function whyProofGraphOpts(
  detail: PresentationBuildOptions['detail'],
  proofSummary: CompactProofPresentation,
): ProofGraphRenderOptions {
  if (detail === 'diagnostic') return { detail: 'diagnostic' };

  // explanation: show only unresolved critical claims (structured fallback)
  const humanSummary = proofSummary.kind === 'evaluation' ? proofSummary.humanSummary : undefined;
  if (!humanSummary) return { claimVisibility: 'none' };

  const unresolvedCriticalIds = humanSummary.claims
    .filter((c) => c.critical && c.status !== 'verified')
    .map((c) => c.claimId);

  if (unresolvedCriticalIds.length === 0) return { claimVisibility: 'none' };

  return {
    claimVisibility: 'selected',
    selectedClaimIds: unresolvedCriticalIds,
  };
}

/**
 * Build the blocker / evidence-required section for /why.
 *
 * Recovery guidance: registry-backed recovery (canonical reason steps from
 * the Human Projection) takes precedence over the phase-derived next-action
 * hint, which remains the fallback for blockers without a canonical reason
 * code. Returns null when there is no blocker detail to present.
 *
 * In diagnostic mode the reason code is always visible; in explanation mode
 * it is secondary (code field null, canonicalMessage rendered in Details).
 */
function buildBlockerSection(
  projection: WhyPresentationProjection,
  detail: PresentationBuildOptions['detail'],
): PresentationSection | null {
  const hasBlockerDetail =
    projection.blocker.reasonCode !== null || projection.blocker.reasonText !== null;
  if (!hasBlockerDetail || !projection.blocker.reasonText) return null;

  const reasonProjection = projection.blocker.reasonCode
    ? projectReasonFromRegistry(projection.blocker.reasonCode)
    : null;
  const recovery = resolveRecovery(reasonProjection, projection.blocker.recoveryHint);
  return {
    kind: 'blocker',
    heading: projection.blocker.blocked ? 'Blocked' : 'Evidence required',
    code: detail === 'diagnostic' ? projection.blocker.reasonCode : null,
    text: reasonProjection?.headline ?? projection.blocker.reasonText,
    ...(recovery ? { recovery } : {}),
    ...blockerDetailFields(reasonProjection, detail),
  };
}

function blockerDetailFields(
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
        ...(projection.impact ? { impact: impactLabel(projection.impact) } : {}),
      };

    case 'diagnostic':
      return {
        ...(projection.explanation ? { explanation: projection.explanation } : {}),
        ...(projection.canonicalMessage ? { canonicalMessage: projection.canonicalMessage } : {}),
        ...(projection.impact ? { impact: impactLabel(projection.impact) } : {}),
      };
  }
}

function impactLabel(impact: string): string {
  switch (impact) {
    case 'workflow_blocked':
      return 'Further progress is blocked until this condition is resolved.';
    case 'verification_incomplete':
      return 'Verification cannot complete without satisfying this requirement.';
    case 'review_required':
      return 'A human review decision is required before progress can continue.';
    case 'decision_required':
      return 'A human decision is required.';
    case 'degraded_only':
      return 'The workflow can continue, but some capabilities are degraded.';
    default:
      return impact;
  }
}

/** Canonical recovery with the caller-provided hint as a last-resort fallback. */
function resolveRecovery(
  projection: ReasonProjection | null,
  hint: string | null,
): string | undefined {
  return projection?.recovery.primary ?? hint ?? undefined;
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
