/**
 * @module presentation
 * @description Presentation barrel — stable entry point for presentation layer.
 *              Import from this file instead of deep paths to specific presentation modules.
 *
 * @version v1
 */

export { PHASE_LABELS } from './phase-labels.js';
export { buildProductNextAction } from './next-action-copy.js';
export type { UserImpact, HumanExplanation, RecoveryProjection } from './human-projection.js';
export { USER_IMPACT_COPY, humanImpactText } from './human-projection.js';
export { REASON_COPY, isMigratedReasonCode, lookupReasonCopy } from './reason-copy.js';
export type { MigratedReasonCopy } from './reason-copy.js';
export {
  projectReasonFromRegistry,
  projectImpact,
  toRecoveryProjection,
  projectDetailFields,
} from './reason-projection.js';
export type { ReasonProjection } from './reason-projection.js';
export { buildPlanReviewCard } from './plan-review-card.js';
export {
  buildReviewDecisionConclusion,
  projectReviewDecision,
  REVIEW_DECISION_COPY,
} from './review-decision.js';
export type {
  ReviewDecisionReadiness,
  ReviewDecisionProjection,
  ReviewDecisionInput,
  DecisionIssue,
  DecisionIssueSource,
  DecisionAdvisory,
} from './review-decision.js';
export {
  buildEvidenceReviewCard,
  buildEvidenceApprovalCompletionDocument,
} from './evidence-review-card.js';
export { buildArchitectureReviewCard } from './architecture-review-card.js';
export { buildReviewReportCard } from './review-report-card.js';
export { normalizedMarkdown, validateCodeLanguage, PresentationContractError } from './model.js';
export type {
  NormalizedMarkdown,
  PresentationAction,
  KeyValueItem,
  ArtifactItem,
  FindingItem,
  FindingGroup,
  ChecklistItem,
  KeyValueSection,
  CommandListSection,
  BlockerSection,
  ArtifactListSection,
  FindingsSection,
  ChecklistSection,
  TextSection,
  CodeSection,
  NoticeSection,
  BulletListSection,
  GuidanceSection,
  GuidanceItem,
  GuidanceStatus,
  DetailedCommandVisibility,
  DetailedCommandItem,
  DetailedCommandListSection,
  HelpSummarySection,
  HelpArtifactSection,
  EmbeddedMarkdownSection,
  PresentationSection,
  PresentationConclusion,
  PresentationForm,
  CompactCardDocument,
  ReviewCardDocument,
  DiagnosticCardDocument,
  PlanDocument,
  HelpDocument,
  PresentationDocument,
  PresentationDetailLevel,
  PresentationBuildOptions,
} from './model.js';
export { renderMarkdown } from './markdown.js';
export type {
  ClaimVerificationState,
  CompactProofClaim,
  CompactProofPresentation,
  ProofApprovalPresentation,
  ProofGraphPresentationStatus,
} from './proof-model.js';
export type {
  HumanProofSummary,
  ClaimHumanProjection,
  ClaimDiagnosticProjection,
} from './claim-human-projection.js';
export type {
  ClaimResolutionFacts,
  CounterexampleRequirementProjection,
  RequiredEvidenceProjection,
  AssertionIdentityProjection,
  FreshnessProjection,
  ClaimProvenanceProjection,
  ApprovedTicketProjection,
  PlanAdrSectionProjection,
  CanonicalAuthorityProjection,
} from './claim-resolution.js';
export { projectClaimResolutionFacts } from './claim-resolution.js';
export { projectClaimHumanProjection, projectHumanProofSummary } from './claim-human-projection.js';
export {
  projectHumanVerificationStatus,
  humanVerificationLabel,
  humanVerificationExplanation,
} from './human-verification.js';
export type { HumanVerificationStatus } from './human-verification.js';
export { BINDING_DIAGNOSTIC_COPY } from './claim-diagnostic-copy.js';
export type { BindingDiagnosticCopy } from './claim-diagnostic-copy.js';
export {
  humanProviderKindLabel,
  humanCounterexampleKindLabel,
  humanCounterexampleRequirementText,
  humanRequiredEvidenceText,
} from './proof-requirement-copy.js';
export { buildProofGraphSection } from './proof-summary.js';
export type { ProofGraphRenderOptions, ClaimVisibility } from './proof-summary.js';
export {
  STATUS_LABELS,
  lookupStatusLabel,
  parseStatusLabel,
  parseArchiveLabel,
  GUIDANCE_STATUS_LABELS,
  type KnownPresentationStatusInput,
  type PresentationStatus,
  type KnownArchiveStatus,
} from './labels.js';
