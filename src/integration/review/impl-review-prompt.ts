/**
 * @module integration/review-impl-review-prompt
 * @description Task-local implementation review prompt construction.
 */

import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { renderReviewerCriteria } from '../../templates/mandates-reviewer-criteria.js';
import { renderPersistedProofGraphContext } from './proof-context.js';
import { renderRepositoryObservationContract } from './observation-contract-prompt.js';
import {
  buildDiscoveryContextSection,
  type DiscoveryReviewContext,
} from './discovery-context-prompt.js';
import { buildStackProfileSection, CORE_REVIEW_PROFILE_MARKER } from './prompt-sections.js';

export interface ImplReviewPromptOpts {
  readonly changedFiles: string[];
  readonly planText: string;
  readonly ticketText: string;
  readonly iteration: number;
  readonly planVersion: number;
  readonly obligationId: string;
  readonly criteriaVersion: string;
  readonly mandateDigest: string;
  readonly profileName?: string;
  readonly profileRules?: string;
  readonly discoveryContext: DiscoveryReviewContext;
  readonly proofGraph?: ProofGraphProjection;
  readonly challengeResolutions?: ReadonlyArray<{
    challengeId: string;
    implementationDigest: string;
    validationAttemptIds: string[];
    resolvedAt: string;
  }>;
  readonly verificationEvidence?: readonly ReviewVerificationEvidenceItem[];
  readonly observationCapability?: string;
  readonly observationRevisions?: readonly ('base' | 'head')[];
  readonly implementationDigest?: string;
}

export interface ReviewVerificationEvidenceItem {
  readonly attemptId: string;
  readonly kind: string;
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly executionMs: number;
  readonly outputDigest: string;
  readonly detail: string;
  readonly executedAt: string;
}

export function renderVerificationEvidence(
  evidence: readonly ReviewVerificationEvidenceItem[],
): string[] {
  if (evidence.length === 0) {
    return [
      '### Verification Evidence (executed)',
      '- NOT_VERIFIED: no executed verification evidence is bound to the current implementation digest.',
      '  Treat every plan verification claim as NOT_VERIFIED unless independently confirmed.',
    ];
  }
  const rows = evidence.map((item) => {
    const status = item.timedOut ? 'TIMED_OUT' : item.passed ? 'PASS' : 'FAIL';
    return (
      `- [${status}] kind=${item.kind} exitCode=${item.exitCode} durationMs=${item.executionMs} ` +
      `digest=${item.outputDigest}\n` +
      `  command: ${item.command}\n` +
      `  detail: ${item.detail}`
    );
  });
  return [
    '### Verification Evidence (executed)',
    'FlowGuard executed these checks itself; a plan claim not supported by a PASS here remains NOT_VERIFIED.',
    ...rows,
  ];
}

function renderImplementationAnchorContract(
  implementationDigest: string | undefined,
  observationCapability: string | undefined,
): string[] {
  if (!implementationDigest) return [];
  return [
    '### Implementation Subject Anchor Contract (host-enforced)',
    '- subjectAnchors MUST use kind "implementation".',
    `- implementationDigest MUST be "${implementationDigest}".`,
    '- Repository paths are evidenceLocations only — never subjectAnchors.',
    observationCapability
      ? '- evidenceLocations are admissible only when their frozen bytes were obtained through flowguard_observe_repository during this review attempt.'
      : '- evidenceLocations MUST be []; working-tree reads are investigation only.',
  ];
}

export function buildImplReviewPrompt(opts: ImplReviewPromptOpts): string {
  const {
    changedFiles,
    planText,
    ticketText,
    iteration,
    planVersion,
    obligationId,
    criteriaVersion,
    mandateDigest,
    profileName,
    profileRules,
    discoveryContext,
    challengeResolutions = [],
    verificationEvidence = [],
    proofGraph,
    observationCapability,
    observationRevisions,
    implementationDigest,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
  const discoverySection = buildDiscoveryContextSection(discoveryContext);

  return [
    '## Instructions',
    renderReviewerCriteria('implementation'),
    'Review the implementation against the approved contract, not against incidental step-by-step mechanics.',
    'Falsify correctness, scope, authority, negative paths, test integrity, and verification claims before accepting.',
    'Treat challenge resolutions as advisory NOT_VERIFIED evidence; inspect them independently.',
    'Return one ReviewerFindingsInput result using the active output transport.',
    '',
    '## Trusted Runtime Context',
    `iteration=${iteration}, planVersion=${planVersion}`,
    `obligationId=${obligationId}`,
    `mandateDigest=${mandateDigest}`,
    `criteriaVersion=${criteriaVersion}`,
    ...(stackSection ? [stackSection] : []),
    ...(discoverySection ? [discoverySection] : []),
    ...renderPersistedProofGraphContext(proofGraph),
    ...(challengeResolutions.length > 0
      ? ['### Advisory Challenge Resolutions (NOT_VERIFIED)', JSON.stringify(challengeResolutions)]
      : []),
    ...renderVerificationEvidence(verificationEvidence),
    ...renderImplementationAnchorContract(implementationDigest, observationCapability),
    ...renderRepositoryObservationContract(observationCapability, observationRevisions ?? []),
    '',
    '## Frozen Untrusted Subject Context',
    '### Ticket',
    ticketText,
    '### Approved Plan',
    planText,
    '### Changed Files',
    changedFiles.map((file) => `- ${file}`).join('\n'),
    '',
    CORE_REVIEW_PROFILE_MARKER,
  ].join('\n');
}
