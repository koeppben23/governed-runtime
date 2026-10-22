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

import type { RiskTrigger, SessionState } from '../../../state/schema.js';
import type { SpecificRiskTrigger } from '../../../state/risk-trigger.js';
import type { ProofGraphProjection } from '../../../state/proofgraph.js';
import type {
  AuthorizedClaimBinding,
  PlanClaimDeclarations,
} from '../../../state/proofgraph-approval.js';
import { authorizedCriticalPlanClaimIds } from '../../../state/proofgraph-approval-context.js';

/**
 * Structural ProofGraph gate port. review/ must not import audit/; the host
 * composition injects the canonical gate authority.
 */
export interface ReviewProofGraphGateInput {
  readonly contract: SessionState['proofContract'];
  readonly validationAttempts: SessionState['validationAttempts'];
  readonly projection?: ProofGraphProjection;
  readonly authorizedCriticalClaimIds?: readonly string[];
  /** Certificate-bound coverage relation; mirrors the canonical gate input. */
  readonly authorizedRiskTriggerCoverage?: ReadonlyMap<string, readonly SpecificRiskTrigger[]>;
  /** Expected certificate binding per authorized critical claim. */
  readonly authorizedClaimBindings?: ReadonlyMap<string, AuthorizedClaimBinding>;
  readonly certificateValid?: boolean;
  readonly implementationDigest: string | undefined;
  readonly riskAssessment?: {
    readonly implementationDigest: string;
    /** Required trigger taxonomy of the v8 assessment; mirrors the canonical gate input. */
    readonly riskTriggers: readonly RiskTrigger[];
  };
}

export interface ReviewProofGraphGateDecision {
  readonly kind: string;
  readonly relevantTriggers: readonly string[];
  /** Detected triggers without approved critical-claim coverage, when projected. */
  readonly uncoveredTriggers?: readonly string[];
}

export type ReviewProofGraphGateEvaluator = (
  input: ReviewProofGraphGateInput,
) => ReviewProofGraphGateDecision;

/** Injected lower-layer authorities for reviewer ProofGraph context. */
export interface ReviewerProofGraphAuthorities {
  readonly evaluateProofGraphGate: ReviewProofGraphGateEvaluator;
  readonly renderPlanClaimDeclarations: (declarations: PlanClaimDeclarations | undefined) => string;
}

/** Bound on rendered list entries so a large graph cannot dominate the prompt. */
const MAX_RENDERED_ENTRIES = 20;

/** Render at most {@link MAX_RENDERED_ENTRIES} entries, with an explicit overflow note. */
function bounded(
  entries: readonly string[],
  label: string,
  maxEntries: number = MAX_RENDERED_ENTRIES,
): string[] {
  if (entries.length <= maxEntries) return [...entries];
  const omitted = entries.length - maxEntries;
  return [
    ...entries.slice(0, maxEntries),
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
  maxEntries?: number,
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
            maxEntries,
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

function renderPlanDeclarations(
  state: SessionState,
  authorities: ReviewerProofGraphAuthorities,
): string[] {
  const declarations = state.plan?.claimDeclarations;
  if (!declarations || declarations.claims.length === 0) return [];
  return [
    `### Plan claim declarations (${declarations.claims.length})`,
    authorities.renderPlanClaimDeclarations(declarations),
    renderCertificateLine('Plan', state.plan?.approvalCertificate),
    '',
  ];
}

function renderArchitectureDeclarations(state: SessionState, maxEntries?: number): string[] {
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
      maxEntries,
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
export function renderDeclarationPreview(
  state: SessionState,
  authorities: ReviewerProofGraphAuthorities,
  maxEntries?: number,
): string[] {
  const sections = [
    ...renderPlanDeclarations(state, authorities),
    ...renderArchitectureDeclarations(state, maxEntries),
  ];
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
export function renderCoverageGaps(state: SessionState, maxEntries?: number): string[] {
  const coverage = state.proofContractCoverage ?? [];
  if (coverage.length === 0) return [];
  return [
    '## ProofGraph Coverage Gaps (persisted)',
    '',
    '- Recorded when approved declarations were materialized. Each entry marks missing or unverified evidence.',
    ...bounded(
      coverage.map((gap) => `- ${gap.cause}${gap.claimId ? ` (claim ${gap.claimId})` : ''}`),
      'coverage gap(s)',
      maxEntries,
    ),
    '',
  ];
}

/**
 * Render the persisted, digest-bound implementation risk assessment as reviewer
 * focus. This is advisory prioritization context: it reclassifies nothing,
 * evaluates no evidence, and never gates approval. Scale the verification depth
 * of the review to these triggers instead of applying a uniform heavy check.
 */
export function renderImplementationRiskFocus(state: SessionState): string[] {
  if (!state.implementation) return [];
  const assessment = state.implementationRiskAssessment;
  if (!assessment || assessment.implementationDigest !== state.implementation.digest) {
    return [
      '## Implementation Risk Focus (persisted, advisory)',
      '',
      '- Status: NOT_VERIFIED. The implementation risk assessment is missing or stale for the current implementation revision.',
      '',
    ];
  }
  const declared = assessment.declaredTaskClass
    ? `, ticket-declared floor ${assessment.declaredTaskClass}`
    : '';
  const escalated = assessment.escalatedTaskClass
    ? `, escalated ${assessment.escalatedTaskClass}`
    : '';
  return [
    '## Implementation Risk Focus (persisted, advisory)',
    '',
    `- Effective risk class: ${assessment.effectiveTaskClass} (computed ${assessment.computedMinimumTaskClass}${declared}${escalated}).`,
    `- Risk triggers: ${assessment.riskTriggers.length > 0 ? assessment.riskTriggers.join(', ') : 'none detected'}.`,
    `- Touched surfaces: ${assessment.touchedSurfaces.length > 0 ? assessment.touchedSurfaces.join(', ') : 'none recorded'}.`,
    '- This persisted context does not lower or raise any approval requirement; it only prioritizes where independent falsification matters most.',
    '',
  ];
}

/** Render the trigger requirement section from an evaluated gate decision. */ function renderTriggerRequirement(
  decision: ReviewProofGraphGateDecision,
): string[] {
  if (decision.relevantTriggers.length === 0) return [];
  const header = ['## Critical Fact Claim Requirement (persisted)', ''];
  if (decision.kind === 'risk_trigger_uncovered') {
    const uncovered = decision.uncoveredTriggers ?? decision.relevantTriggers;
    return [
      ...header,
      `- Relevant triggers: ${decision.relevantTriggers.join(', ')}.`,
      `- Triggers without approved critical-claim coverage: ${uncovered.join(', ')}.`,
      '- Declare coversRiskTriggers for every trigger on a critical plan claim and obtain plan approval for the new declaration set.',
      '',
    ];
  }
  return [
    ...header,
    `- Relevant triggers: ${decision.relevantTriggers.join(', ')}.`,
    '- At least one critical, certificate-authorized fact claim is required before final evidence approval.',
    '',
  ];
}

/** Render the persisted critical-fact requirement without performing fresh classification. */
function renderCriticalClaimRequirement(
  state: SessionState,
  authorities: ReviewerProofGraphAuthorities,
): string[] {
  if (!state.implementation) return [];
  const authorization = authorizedCriticalPlanClaimIds(state);
  const riskAssessment = state.implementationRiskAssessment;
  const decision = authorities.evaluateProofGraphGate({
    contract: state.proofContract,
    validationAttempts: state.validationAttempts,
    projection: state.proofGraph,
    authorizedCriticalClaimIds: authorization.kind === 'authorized' ? authorization.claimIds : [],
    ...(authorization.kind === 'authorized'
      ? { authorizedRiskTriggerCoverage: authorization.coverage }
      : {}),
    ...(authorization.kind === 'authorized'
      ? { authorizedClaimBindings: authorization.bindings }
      : {}),
    certificateValid: authorization.kind === 'authorized',
    implementationDigest: state.implementation.digest,
    ...(riskAssessment !== null
      ? {
          riskAssessment: {
            implementationDigest: riskAssessment.implementationDigest,
            riskTriggers: riskAssessment.riskTriggers,
          },
        }
      : {}),
  });
  if (decision.kind === 'risk_assessment_stale') {
    return [
      '## Critical Fact Claim Requirement (persisted)',
      '',
      '- Status: NOT_VERIFIED. The implementation risk assessment is missing or stale.',
      '',
    ];
  }
  return renderTriggerRequirement(decision);
}

/**
 * Compose the full reviewer-facing ProofGraph context.
 *
 * Used by every reviewer transport so the host-task Task prompt and the SDK
 * prompts stay structurally identical.
 */
export function buildReviewerProofContext(
  state: SessionState,
  authorities: ReviewerProofGraphAuthorities,
  options: { readonly includeDeclarationPreview?: boolean; readonly unbounded?: boolean } = {},
): string[] {
  // Only frozen PLAN material already carries the claim declarations. ADR
  // material contains the ticket and ADR body, so architecture declarations
  // still need this preview, including their evidence requirements/assumptions.
  const includePreview = options.includeDeclarationPreview !== false;
  const maxEntries = options.unbounded ? Number.MAX_SAFE_INTEGER : undefined;
  return [
    ...renderPersistedProofGraphContext(state.proofGraph, maxEntries),
    ...renderImplementationRiskFocus(state),
    ...(includePreview ? renderDeclarationPreview(state, authorities, maxEntries) : []),
    ...renderCoverageGaps(state, maxEntries),
    ...renderCriticalClaimRequirement(state, authorities),
  ];
}
