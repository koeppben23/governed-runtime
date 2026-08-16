/**
 * @module integration/review/impl-review-prompt
 * @description Prompt construction for implementation review by the
 *              flowguard-reviewer subagent.
 *
 * Extracted from prompt-builders.ts along the implementation-review boundary
 * to keep both modules within the file-size budget. Pure functions only: no
 * SDK, state, or enforcement dependencies.
 *
 * The subject anchor contract binds the reviewer to the exact
 * implementationDigest; the repository evidence rule derives from the SAME
 * authority enforcement uses (the host-minted observation capability is only
 * minted when at least one frozen revision resolves) — no separate heuristic.
 *
 * @version v1
 */

import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { renderPersistedProofGraphContext } from './proof-context.js';
import { renderRepositoryObservationContract } from './observation-contract-prompt.js';
import {
  buildDiscoveryContextSection,
  type DiscoveryReviewContext,
} from './discovery-context-prompt.js';
import { buildStackProfileSection, CORE_REVIEW_PROFILE_MARKER } from './prompt-sections.js';

/** Options for building an implementation review prompt. */
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
  /** Persisted advisory projection only; prompt construction never evaluates providers. */
  readonly proofGraph?: ProofGraphProjection;
  readonly challengeResolutions?: ReadonlyArray<{
    challengeId: string;
    implementationDigest: string;
    validationAttemptIds: string[];
    resolvedAt: string;
  }>;
  /**
   * Runtime-executed verification evidence bound to the implementation under
   * review (FlowGuard-executed, digest-bound by the caller).
   */
  readonly verificationEvidence?: readonly ReviewVerificationEvidenceItem[];
  /** Opaque host-minted observation capability of the attempt under review. */
  readonly observationCapability?: string;
  readonly observationRevisions?: readonly ('base' | 'head')[];
  /** Canonical implementation subject digest for the host-enforced anchor contract. */
  readonly implementationDigest?: string;
}

/** A single runtime-executed verification result projected for the reviewer
 * prompt (immutable ValidationAttempt.result fields; tamper-evident via
 * `outputDigest`; no raw stdout/stderr is carried).
 */
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

/**
 * Build a prompt for implementation review by the flowguard-reviewer subagent.
 */
/**
 * Render the executed verification evidence section for the implementation
 * review prompt.
 *
 * Fail-closed: an empty list renders an explicit NOT_VERIFIED line instead of
 * omitting the section, so the reviewer is told that no runtime evidence is
 * bound to the current implementation — a genuine review signal, not silence.
 *
 * Enforcement safety: this section is emitted AFTER the attestation/context
 * block and BEFORE the CORE_REVIEW_PROFILE_MARKER. Its own field LABELS are
 * neutral (`durationMs`, `digest`, `exitCode`, `kind`) — no "iteration"/"version"
 * adjacent to digits. The `command` and `detail` VALUES are executor-derived and
 * NOT sanitized, so they could in principle contain such a token. That is safe:
 * the L3 matcher (promptContainsValue in enforcement/extraction.ts) is a positive
 * `.test()` presence check on the whole prompt, so an extra token here cannot
 * REMOVE the legitimate iteration=/planVersion= tokens emitted by
 * renderReviewContext, and injecting the CORRECT expected value is not a bypass.
 * The section therefore cannot flip enforcement in either direction.
 */
export function renderVerificationEvidence(
  evidence: readonly ReviewVerificationEvidenceItem[],
): string[] {
  if (evidence.length === 0) {
    return [
      '## Verification Evidence (executed)',
      '',
      '- NOT_VERIFIED: no executed verification evidence is bound to the current implementation digest.',
      '  Treat every plan verification claim as NOT_VERIFIED unless you can independently confirm it; do not assume checks passed.',
      '',
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
    '## Verification Evidence (executed)',
    '',
    'FlowGuard executed these checks itself (not agent-reported); exitCode/digest are tamper-evident.',
    'Verify plan verification claims against these results. A claim not supported by a PASS here is NOT_VERIFIED.',
    '',
    ...rows,
    '',
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
    `You are reviewing an implementation for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    '## Approved Plan',
    '',
    planText,
    '',
    '## Changed Files',
    '',
    changedFiles.map((f) => `- ${f}`).join('\n'),
    '',
    ...(stackSection ? [stackSection, ''] : []),
    ...(discoverySection ? [discoverySection, ''] : []),
    ...renderPersistedProofGraphContext(proofGraph),
    ...(challengeResolutions.length > 0
      ? [
          '## Advisory Challenge Resolutions (NOT_VERIFIED)',
          '',
          'These author-recorded bindings do not establish correctness or alter acceptance. Inspect the referenced challenge and validation attempts independently:',
          JSON.stringify(challengeResolutions),
          '',
        ]
      : []),
    ...renderVerificationEvidence(verificationEvidence),
    '## Instructions',
    '',
    'Review this implementation against the approved plan and ticket.',
    'Treat any challenge resolution as advisory NOT_VERIFIED evidence; independently verify it.',
    'Read the changed files using the read/glob/grep tools to verify correctness.',
    'Follow your review criteria for implementations.',
    ...(implementationDigest
      ? [
          '## Implementation Subject Anchor Contract (host-enforced)',
          'The review subject is the recorded implementation. The host binder enforces this exact contract:',
          '- subjectAnchors MUST use kind "implementation"',
          `- implementationDigest MUST be "${implementationDigest}"`,
          '- Repository paths are evidenceLocations only — never subjectAnchors.',
          observationCapability
            ? 'evidenceLocations are admissible ONLY when their frozen bytes were obtained through flowguard_observe_repository during this review attempt.'
            : 'evidenceLocations MUST be []. Do not convert working-tree reads into repository evidence.',
        ]
      : []),
    ...renderRepositoryObservationContract(observationCapability, observationRevisions ?? []),
    'Return your findings as a single ReviewerFindingsInput JSON object.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy; the host stamps them after strict validation.',
    '',
    CORE_REVIEW_PROFILE_MARKER,
  ].join('\n');
}
