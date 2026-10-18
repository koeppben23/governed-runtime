/**
 * @module integration/review/reviewer-context
 * @description Freeze host-owned comparison context into reviewer material.
 */

import type { SessionState } from '../../../state/schema.js';
import type { PlanClaimDeclarations } from '../../../state/proofgraph-approval.js';
import type { MarkdownSectionPath } from '../../../state/evidence-findings.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { indexMarkdownSections } from '../../../shared/markdown-sections.js';
import { IntegrationInvariantError } from '../../errors.js';
import { stateVerificationEvidence } from '../shared-helpers.js';

/**
 * Presentation cleanup (NOT requirement provenance): when no ticket was
 * recorded, the frozen material renders an explicit marker instead of the
 * JSON literal `null`. Referenced ticket documents such as ADR_TICKET.md
 * remain unfrozen working-tree content and are deliberately not part of the
 * review material.
 */
/**
 * Host-owned section headings. Both the material builder and the deterministic
 * navigation index read these constants, so the two views of the frozen
 * material can never drift apart.
 */
export const REVIEW_MATERIAL_SECTIONS = {
  ticket: 'Ticket Under Review (originating request)',
  planArtifact: 'Plan Artifact',
  planClaims: 'Plan Claim Declarations Under Review',
  approvedPlan: 'Approved Plan (identity and content)',
  changedFiles: 'Changed Files',
  verificationEvidence: 'Verification Evidence (host-executed)',
  implementationMetadata: 'Implementation Subject Metadata',
  implementationArtifact: 'Implementation Artifact',
} as const;

/**
 * Canonical material value for "no ticket was recorded". It is a deliberate
 * presentation state, not a malformed ticket: the navigation index reports it
 * as a coverage note instead of failing.
 */
export const NO_TICKET_MATERIAL_TEXT = 'No ticket recorded for this session.';

function ticketProjection(state: SessionState): unknown {
  const ticket = state.ticket;
  return ticket ? { digest: ticket.digest, text: ticket.text } : NO_TICKET_MATERIAL_TEXT;
}

function section(heading: string, content: string): string[] {
  return [`## ${heading}`, '', content, ''];
}

/** Shared input shape for the canonical frozen reviewer material. */
interface FrozenReviewMaterialInput {
  readonly state: SessionState;
  readonly artifact: string;
  /** Effective plan claim declarations for a fresh plan submission. */
  readonly planClaimDeclarations?: PlanClaimDeclarations;
  /** Injected presentation authority (review/ must not import presentation/). */
  readonly renderPlanClaimDeclarations: (declarations: PlanClaimDeclarations | undefined) => string;
}

/**
 * Frozen artifact-review material parts for plan and ADR obligations.
 *
 * `content` is the single canonical Markdown view; `subjectSectionPaths` are
 * the section identities of the review SUBJECT as indexed from `content`
 * itself (artifact text plus the claim-declarations section), so the frozen
 * anchor whitelist and the reviewer-visible `plan_adr_section` evidence refs
 * share identical identities. Context sections (the originating ticket and
 * the presentation wrapper heading) stay visible in `content` but carry no
 * subject authority.
 */
export interface FrozenArtifactReviewMaterial {
  readonly content: string;
  readonly subjectSectionPaths: readonly MarkdownSectionPath[];
}

/**
 * Build the canonical artifact-review material together with the exact
 * subject section paths the anchor whitelist must contain. Both are derived
 * from the same assembled bytes — callers must use `subjectSectionPaths` for
 * the review-subject scope and `content` for the frozen review material.
 */
export function buildFrozenArtifactReviewMaterial(
  input: FrozenReviewMaterialInput & { readonly obligationType: 'plan' | 'architecture' },
): FrozenArtifactReviewMaterial {
  const ticket = section(
    REVIEW_MATERIAL_SECTIONS.ticket,
    canonicalJsonStringify(ticketProjection(input.state)),
  );
  if (input.obligationType === 'plan') {
    const wrapperHeading = `## ${REVIEW_MATERIAL_SECTIONS.planArtifact}`;
    const claims = section(
      REVIEW_MATERIAL_SECTIONS.planClaims,
      input.renderPlanClaimDeclarations(
        input.planClaimDeclarations ?? input.state.plan?.claimDeclarations,
      ),
    );
    const content = [...ticket, wrapperHeading, '', input.artifact, '', ...claims].join('\n');
    // Subject regions: the artifact text and the claims section (heading
    // included). The context ticket and the wrapper heading are excluded.
    const artifactStartLine = [...ticket, wrapperHeading, ''].join('\n').split('\n').length;
    const artifactEndLine = artifactStartLine + input.artifact.split('\n').length;
    const claimsStartLine = [...ticket, wrapperHeading, '', input.artifact, '']
      .join('\n')
      .split('\n').length;
    const claimsEndLine = claimsStartLine + claims.join('\n').split('\n').length;
    const materialSections = indexMarkdownSections(content);
    const artifactSectionPaths = materialSections
      .filter(
        (section_) =>
          section_.lineIndex >= artifactStartLine && section_.lineIndex < artifactEndLine,
      )
      .map((section_) => section_.sectionPath);
    // Fail closed: the claims section is appended by the host and must never
    // substitute for a plan artifact without its own anchorable sections.
    if (artifactSectionPaths.length === 0) {
      throw new IntegrationInvariantError(
        'REVIEW_ARTIFACT_SUBJECT_SECTIONS_MISSING',
        'FAIL_CLOSED: cannot review a plan artifact without ATX headings; artifact ' +
          'review findings must anchor to concrete plan sections.',
      );
    }
    const claimsSectionPaths = materialSections
      .filter(
        (section_) => section_.lineIndex >= claimsStartLine && section_.lineIndex < claimsEndLine,
      )
      .map((section_) => section_.sectionPath);
    return {
      content,
      subjectSectionPaths: [...artifactSectionPaths, ...claimsSectionPaths],
    };
  }
  const wrapperHeading = '## Architecture Decision Artifact';
  const content = [...ticket, wrapperHeading, '', input.artifact, ''].join('\n');
  const artifactStartLine = [...ticket, wrapperHeading, ''].join('\n').split('\n').length;
  const artifactEndLine = artifactStartLine + input.artifact.split('\n').length;
  const artifactSectionPaths = indexMarkdownSections(content)
    .filter(
      (section_) => section_.lineIndex >= artifactStartLine && section_.lineIndex < artifactEndLine,
    )
    .map((section_) => section_.sectionPath);
  if (artifactSectionPaths.length === 0) {
    throw new IntegrationInvariantError(
      'REVIEW_ARTIFACT_SUBJECT_SECTIONS_MISSING',
      'FAIL_CLOSED: cannot review an ADR artifact without ATX headings; artifact ' +
        'review findings must anchor to concrete sections.',
    );
  }
  return { content, subjectSectionPaths: artifactSectionPaths };
}

/**
 * Canonical, self-contained material delivered to plan, architecture, and
 * implementation reviewers. This is created before the obligation, rather than
 * reconstructed from mutable session state while a reviewer attempt is running.
 * Plan and architecture content delegates to
 * {@link buildFrozenArtifactReviewMaterial} so the material and its subject
 * section paths can never be composed independently.
 */
export function buildFrozenReviewMaterialContent(input: {
  readonly obligationType: 'plan' | 'architecture' | 'implement';
  readonly state: SessionState;
  readonly artifact: string;
  /** Effective plan claim declarations for a fresh plan submission. */
  readonly planClaimDeclarations?: PlanClaimDeclarations;
  /** Injected presentation authority (review/ must not import presentation/). */
  readonly renderPlanClaimDeclarations: (declarations: PlanClaimDeclarations | undefined) => string;
}): string {
  if (input.obligationType === 'plan' || input.obligationType === 'architecture') {
    return buildFrozenArtifactReviewMaterial({
      ...input,
      obligationType: input.obligationType,
    }).content;
  }

  const ticket = section(
    REVIEW_MATERIAL_SECTIONS.ticket,
    canonicalJsonStringify(ticketProjection(input.state)),
  );
  const plan = input.state.plan?.current;
  const changedFiles = [...(input.state.implementation?.changedFiles ?? [])].sort();
  return [
    ...ticket,
    ...section(
      REVIEW_MATERIAL_SECTIONS.approvedPlan,
      canonicalJsonStringify(
        plan ? { digest: plan.digest, planVersion: plan.planVersion, body: plan.body } : null,
      ),
    ),
    ...section(REVIEW_MATERIAL_SECTIONS.changedFiles, canonicalJsonStringify(changedFiles)),
    ...section(
      REVIEW_MATERIAL_SECTIONS.verificationEvidence,
      canonicalJsonStringify(stateVerificationEvidence(input.state)),
    ),
    ...section(
      REVIEW_MATERIAL_SECTIONS.implementationMetadata,
      canonicalJsonStringify(input.state.implementation),
    ),
    ...section(REVIEW_MATERIAL_SECTIONS.implementationArtifact, input.artifact),
  ].join('\n');
}
