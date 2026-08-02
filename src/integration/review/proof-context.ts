/**
 * @module integration/review/proof-context
 * @description Reviewer-facing ProofGraph context sections (#762).
 *
 * Single renderer for every reviewer transport. The SDK prompt builders and the
 * host-task Task prompt MUST both source their ProofGraph section here so the
 * reviewer sees identical context regardless of invocation policy; a transport
 * that renders its own variant would silently reintroduce an unreviewed prompt.
 *
 * Everything rendered here is persisted, advisory context:
 * - it never evaluates providers or derives fresh evidence;
 * - it never carries a verdict, acceptance, or approval;
 * - declarations are stated intent and are explicitly NOT evidence.
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { evaluateProofGraphGate } from '../../audit/proofgraph/gate.js';

/** Bound on rendered list entries so a large graph cannot dominate the prompt. */
const MAX_RENDERED_ENTRIES = 20;

/** Render at most {@link MAX_RENDERED_ENTRIES} entries, with an explicit overflow note. */
function bounded(entries: readonly string[], label: string): string[] {
  if (entries.length <= MAX_RENDERED_ENTRIES) return [...entries];
  const omitted = entries.length - MAX_RENDERED_ENTRIES;
  return [
    ...entries.slice(0, MAX_RENDERED_ENTRIES),
    `  - ... ${omitted} further ${label} omitted for prompt length; inspect flowguard_status for the full set.`,
  ];
}

/**
 * Render the stored projection without deriving fresh evidence or provider results.
 *
 * An absent projection is rendered as an explicit NOT_DECLARED line rather than
 * being omitted: "no persisted graph" is itself a review signal.
 */
export function renderPersistedProofGraphContext(
  proofGraph: ProofGraphProjection | undefined,
): string[] {
  if (!proofGraph) {
    return [
      '## ProofGraph Context (persisted, advisory)',
      '',
      '- Coverage: NOT_DECLARED (no persisted ProofGraph projection is available).',
      '',
    ];
  }

  const provenCount = proofGraph.claims.filter(
    (claim) => claim.verificationState === 'PROVEN',
  ).length;
  const criticalUnresolved = proofGraph.claims.filter(
    (claim) => claim.critical && claim.verificationState !== 'PROVEN',
  );
  return [
    '## ProofGraph Context (persisted, advisory)',
    '',
    `- Coverage: ${provenCount}/${proofGraph.claims.length} claims PROVEN; ${proofGraph.claims.length - provenCount} unresolved.`,
    '- This is persisted advisory context, not a review verdict or reviewer authority. Independently assess every claim.',
    ...(criticalUnresolved.length === 0
      ? ['- Critical unresolved claims: none recorded.']
      : [
          '- Critical unresolved claims:',
          ...bounded(
            criticalUnresolved.map(
              (claim) => `  - [${claim.verificationState}] ${claim.claimId}: ${claim.statement}`,
            ),
            'critical unresolved claim(s)',
          ),
        ]),
    '',
  ];
}

function renderCertificateLine(
  flow: 'Plan' | 'Architecture',
  certificate:
    | {
        readonly certificateId: string;
        readonly authorityDigest: string;
        readonly claimDeclarationsDigest: string;
      }
    | undefined,
): string {
  if (!certificate) {
    return `- ${flow} approval certificate: none recorded — declarations are not yet certificate-bound.`;
  }
  return (
    `- ${flow} approval certificate: ${certificate.certificateId} ` +
    `(authorityDigest ${certificate.authorityDigest}, claimDeclarationsDigest ${certificate.claimDeclarationsDigest}).`
  );
}

function renderPlanDeclarations(state: SessionState): string[] {
  const declarations = state.plan?.claimDeclarations;
  if (!declarations || declarations.claims.length === 0) return [];
  return [
    `### Plan claim declarations (${declarations.claims.length})`,
    ...bounded(
      declarations.claims.map((claim) => {
        const detail = [
          `authority section: ${claim.authoritySectionId}`,
          `expected check: ${claim.expectedCheckId}`,
          ...(claim.counterexampleCheckId
            ? [`counterexample check: ${claim.counterexampleCheckId}`]
            : []),
          ...(claim.structuralSurface ? [`structural surface: ${claim.structuralSurface}`] : []),
          ...(claim.mutationProfile ? [`mutation profile: ${claim.mutationProfile}`] : []),
        ].join('; ');
        return `- [${claim.critical ? 'critical' : 'non-critical'}] ${claim.claimId}: ${claim.statement}\n  ${detail}`;
      }),
      'plan declaration(s)',
    ),
    renderCertificateLine('Plan', state.plan?.approvalCertificate),
    '',
  ];
}

function renderArchitectureDeclarations(state: SessionState): string[] {
  const declarations = state.architecture?.claimDeclarations;
  if (!declarations || declarations.claims.length === 0) return [];
  return [
    `### Architecture claim declarations (${declarations.claims.length})`,
    ...bounded(
      declarations.claims.map((claim) => {
        const detail = [
          `authority section: ${claim.authoritySectionId}`,
          `required review evidence: ${claim.requiredReviewEvidence.join(', ')}`,
          ...(claim.assumptions && claim.assumptions.length > 0
            ? [`assumptions: ${claim.assumptions.join(', ')}`]
            : []),
        ].join('; ');
        return `- [${claim.critical ? 'critical' : 'non-critical'}] ${claim.claimId}: ${claim.statement}\n  ${detail}`;
      }),
      'architecture declaration(s)',
    ),
    renderCertificateLine('Architecture', state.architecture?.approvalCertificate),
    '',
  ];
}

/**
 * Render pre-evidence claim declarations for the plan and architecture gates.
 *
 * Declarations exist before any implementation revision, so they deliberately do
 * NOT become graph claims here: a claim without a revision binding could never
 * be fresh. The reviewer receives them as the assertions to falsify.
 */
export function renderDeclarationPreview(state: SessionState): string[] {
  const sections = [...renderPlanDeclarations(state), ...renderArchitectureDeclarations(state)];
  if (sections.length === 0) return [];
  return [
    '## Declared Claims (pre-evidence, advisory)',
    '',
    '- These are stated intent, NOT evidence. Presence here proves nothing.',
    '- Treat each declaration as a claim to falsify, not as an established fact.',
    '',
    ...sections,
  ];
}

/** Render recorded coverage gaps so missing evidence is visible, never implied. */
export function renderCoverageGaps(state: SessionState): string[] {
  const coverage = state.proofContractCoverage ?? [];
  if (coverage.length === 0) return [];
  return [
    '## ProofGraph Coverage Gaps (persisted)',
    '',
    '- Recorded when approved declarations were materialized. Each entry marks missing or unverified evidence.',
    ...bounded(
      coverage.map((gap) => `- ${gap.cause}${gap.claimId ? ` (claim ${gap.claimId})` : ''}`),
      'coverage gap(s)',
    ),
    '',
  ];
}

/** Render the persisted critical-fact requirement without performing fresh classification. */
export function renderCriticalClaimRequirement(state: SessionState): string[] {
  if (!state.implementation) return [];
  const decision = evaluateProofGraphGate({
    projection: state.proofGraph ?? { version: 'proofgraph.v1', claims: [], evaluatedAt: '' },
    implementationDigest: state.implementation.digest,
    riskAssessment: state.implementationRiskAssessment,
  });
  if (decision.kind === 'risk_assessment_stale') {
    return [
      '## Critical Fact Claim Requirement (persisted)',
      '',
      '- Status: NOT_VERIFIED. The implementation risk assessment is missing, stale, or predates trigger classification.',
      '',
    ];
  }
  if (decision.relevantTriggers.length === 0) return [];
  return [
    '## Critical Fact Claim Requirement (persisted)',
    '',
    `- Relevant triggers: ${decision.relevantTriggers.join(', ')}.`,
    '- At least one critical, certificate-authorized fact claim is required before final evidence approval.',
    '',
  ];
}

/**
 * Compose the full reviewer-facing ProofGraph context.
 *
 * Used by every reviewer transport so the host-task Task prompt and the SDK
 * prompts stay structurally identical.
 */
export function buildReviewerProofContext(state: SessionState): string[] {
  return [
    ...renderPersistedProofGraphContext(state.proofGraph),
    ...renderDeclarationPreview(state),
    ...renderCoverageGaps(state),
    ...renderCriticalClaimRequirement(state),
  ];
}
