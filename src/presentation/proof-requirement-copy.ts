/**
 * @module presentation/proof-requirement-copy
 * @description Human-readable copy for evidence requirement kinds.
 *
 * Pure presentation label authority: maps canonical ProofProviderKind and
 * CounterexampleRequirementProjection kinds to human-facing prose. No
 * state dependency beyond type imports.
 *
 * @version v1
 */

import type { ProofProviderKind } from '../state/proofgraph-primitives.js';

const PROVIDER_KIND_LABELS: Readonly<Record<ProofProviderKind, string>> = {
  executed_test: 'Test evidence',
  structural_assertion: 'Structural assertion evidence',
  schema_compare: 'Schema consistency evidence',
  fault_injection: 'Mutation verification evidence',
};

export function humanProviderKindLabel(kind: ProofProviderKind): string {
  return PROVIDER_KIND_LABELS[kind];
}

export function humanRequiredEvidenceText(positiveKinds: readonly ProofProviderKind[]): string {
  if (positiveKinds.length === 0) return '';
  const labels = positiveKinds.map((k) => PROVIDER_KIND_LABELS[k]).join(', ');
  return labels;
}

/**
 * Human label for a counterexample requirement kind.
 *
 * Uses the canonical domain discriminator — no new Presentation-only kind.
 * `legacy_assertion` renders identically to `assertion` but is preserved
 * as a distinct diagnostic fact so it cannot be silently conflated with v2.
 */
export function humanCounterexampleKindLabel(kind: string): string {
  switch (kind) {
    case 'assertion':
    case 'legacy_assertion':
      return 'Assertion-level check';
    case 'aggregate_check':
      return 'Complete-check coverage';
    default:
      return kind;
  }
}

export function humanCounterexampleRequirementText(requirement: {
  readonly kind: string;
  readonly checkId: string;
}): string {
  const kindLabel = humanCounterexampleKindLabel(requirement.kind);
  return `Counterexample: ${kindLabel} from \`${requirement.checkId}\``;
}
