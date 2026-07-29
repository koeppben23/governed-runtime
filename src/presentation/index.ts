/**
 * @module presentation
 * @description Presentation barrel — stable entry point for presentation layer.
 *              Import from this file instead of deep paths to specific presentation modules.
 *
 * @version v1
 */

export { PHASE_LABELS } from './phase-labels.js';
export { buildProductNextAction } from './next-action-copy.js';
export { buildPlanReviewCard } from './plan-review-card.js';
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
} from './model.js';
export { renderMarkdown } from './markdown.js';
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
