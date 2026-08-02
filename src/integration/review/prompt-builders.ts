/**
 * @module integration/review-prompt-builders
 * @description Prompt construction for reviewer subagent invocation.
 *
 * Extracted from review-orchestrator.ts (FG-REL-038) for single-responsibility.
 * Pure functions that build structured prompt strings for plan, implementation,
 * architecture, and content review. No SDK, state, or enforcement dependencies.
 *
 * P9c: Each builder injects phase-specific stack review rules when a stack
 * profile is active.
 *
 * @version v1
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { renderPersistedProofGraphContext } from './proof-context.js';
import {
  buildDiscoveryContextSection,
  type DiscoveryReviewContext,
} from './discovery-context-prompt.js';

/**
 * Mandatory-baseline marker appended as the final line of every reviewer prompt.
 *
 * This declares that the review runs under the canonical 'core' coverage
 * profile — the non-optional baseline whose criteria are owned by
 * src/templates/mandates-reviewer-criteria.ts (REVIEWER_CRITERIA). It adds NO
 * new criteria (no duplicate review authority); it only names the profile and
 * marks it mandatory.
 *
 * Enforcement safety (verified against promptContainsValue in
 * enforcement/extraction.ts): this string MUST NOT contain the tokens
 * "iteration" or "version" followed within 30 non-digit characters by a number,
 * and it is always appended AFTER the attestation/context block so it can never
 * displace the real iteration=/planVersion= tokens the enforcement matcher
 * requires. It is intentionally digit-free.
 */
export const CORE_REVIEW_PROFILE_MARKER =
  'Review coverage profile: core (mandatory baseline; not optional). ' +
  'Apply your full reviewer criteria for this review type as the required floor.';

// ─── Canonical Review Context Serializer ─────────────────────────────────────

/**
 * Canonical serialization of the review cycle-binding context (F9).
 *
 * The `iteration` / `planVersion` values an agent must echo into the reviewer
 * subagent prompt are emitted by multiple blocked-output builders
 * (pending-instruction.ts, host-task-policy.ts) and validated by a third code
 * path (enforcement `promptContainsValue`). Previously each builder produced a
 * subtly different string ("iteration=X, and planVersion=Y" vs.
 * "Context: iteration=X, planVersion=Y"), the exact divergence class behind
 * BUG-16 and the observed first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT block.
 *
 * This is the single canonical form. Both builders MUST use it so the emitted
 * context is byte-identical and always satisfies enforcement on the first
 * attempt. `planVersion` is optional because standalone /review obligations may
 * not carry one.
 */
export function renderReviewContext(input: {
  iteration: number;
  planVersion?: number | null;
}): string {
  const parts = [`iteration=${input.iteration}`];
  if (input.planVersion != null) {
    parts.push(`planVersion=${input.planVersion}`);
  }
  return parts.join(', ');
}

/** Inputs for the canonical, copy-ready reviewer Task prompt (F10). */
export interface ReviewerTaskPromptInput {
  readonly iteration: number;
  readonly planVersion?: number | null;
  readonly obligationId: string;
  readonly mandateDigest: string;
  readonly criteriaVersion: string;
  /** Short human label of what is under review, e.g. "the plan", "the branch diff". */
  readonly subjectLabel: string;
  /** Frozen challenge contract and host-authoritative references, when available. */
  readonly challengeContract?: ReviewerChallengePromptContract;
  /**
   * Persisted, advisory ProofGraph context lines (#762), produced by
   * {@link buildReviewerProofContext}. Supplied by the caller so this renderer
   * stays free of state access. Omitted only when no session state is resolvable;
   * the host-task prompt would otherwise silently drop the reviewer's claim
   * context while the SDK path retains it.
   */
  readonly proofContext?: readonly string[];
}

export interface ReviewerChallengePromptContract {
  readonly requiredChallengeCount: number;
  readonly requiredChallengeKind?:
    'design_challenge' | 'implementation_challenge' | 'content_challenge';
  /** Canonical evidence objects the reviewer may copy into a challenge. */
  readonly evidenceRefs?: readonly Record<string, unknown>[];
}

function challengeOutcome(kind: ReviewerChallengePromptContract['requiredChallengeKind']): string {
  switch (kind) {
    case 'implementation_challenge':
      return 'pass';
    case 'content_challenge':
    case 'design_challenge':
      return 'supported';
    case undefined:
      return 'not_verified';
    default:
      return 'not_verified';
  }
}

function renderChallengeContract(
  contract: ReviewerChallengePromptContract | undefined,
  obligationId: string,
): string[] {
  if (!contract) {
    return ['- Omit the optional challenges field; no Challenge contract was supplied.'];
  }
  if (contract.requiredChallengeCount === 0) {
    return [
      '- Challenge contract: requiredChallengeCount=0. Omit the optional challenges field entirely.',
    ];
  }
  const evidenceRefs = contract.evidenceRefs ?? [];
  const challenge = {
    clientReference: '<your-ref>',
    obligationId,
    scenario: '<falsification scenario>',
    claim: '<reviewed claim>',
    locations: ['<concrete file or artifact location>'],
    kind: contract.requiredChallengeKind,
    evidenceRefs,
    outcome: challengeOutcome(contract.requiredChallengeKind),
  };
  return [
    `- Challenge contract: return exactly ${contract.requiredChallengeCount} ${contract.requiredChallengeKind} challenge(s).`,
    '- Every challenge MUST use a fresh, unique clientReference (e.g. "c1", "c2") and the exact obligationId below.',
    '- Copy evidenceRefs exactly from the schema below. Do not invent or alter a digest, sectionPath, or attemptId.',
    '- Omit challengeResolutionVerdicts unless the Task prompt explicitly supplies prior challenge IDs to resolve.',
    `- Required challenge object shape: ${JSON.stringify(challenge)}`,
    ...(evidenceRefs.length === 0
      ? ['- No usable evidence reference was supplied; return unable_to_review.']
      : []),
  ];
}

/**
 * Render the canonical, verbatim copy-ready reviewer Task prompt (F10).
 *
 * Root-cause fix for the first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT block: in
 * the host-task path the agent otherwise free-composes the reviewer Task prompt
 * from prose and routinely omits the literal iteration=/planVersion= tokens the
 * enforcement matcher (promptContainsValue) requires, forcing a wasted retry.
 *
 * FlowGuard now hands the agent a ready-to-paste prompt whose review context is
 * produced by the SAME renderReviewContext serializer the enforcement matcher
 * validates against — making the emitter/validator agreement structural rather
 * than dependent on the agent echoing the values. The agent only appends the
 * subject content (diff/plan/ADR) to this block.
 *
 * The prompt intentionally does NOT include any verdict or findings text
 * (anti-fabrication) and stays above MIN_SUBAGENT_PROMPT_LENGTH so it clears the
 * prompt-length gate on its own.
 */
export function renderReviewerTaskPrompt(input: ReviewerTaskPromptInput): string {
  const context = renderReviewContext({
    iteration: input.iteration,
    planVersion: input.planVersion,
  });
  return [
    `You are the ${REVIEWER_SUBAGENT_TYPE} subagent performing an independent, ` +
      `falsification-first review of ${input.subjectLabel}.`,
    `Review context: ${context}.`,
    '',
    'Required attestation (return these exact values in your ReviewFindings.attestation):',
    `  reviewedBy: "${REVIEWER_SUBAGENT_TYPE}"`,
    `  toolObligationId: "${input.obligationId}"`,
    `  mandateDigest: "${input.mandateDigest}"`,
    `  criteriaVersion: "${input.criteriaVersion}"`,
    `  iteration: ${input.iteration}`,
    ...(input.planVersion != null ? [`  planVersion: ${input.planVersion}`] : []),
    '',
    'Rules:',
    `- You MUST NOT call any FlowGuard tools (flowguard_plan, flowguard_implement, ` +
      `flowguard_review_implementation, flowguard_architecture, flowguard_review) in your session.`,
    '- Check Discovery health and drift before any repo-dependent quality claim; mark claims',
    '  NOT_VERIFIED when they cannot be correlated to the local repository Discovery snapshot.',
    '- Do not fabricate a verdict of convenience; ground every finding in concrete evidence.',
    '- Return a complete ReviewFindings JSON object with overallVerdict, blockingIssues,',
    '  majorRisks, missingVerification, scopeCreep, unknowns, reviewedBy, reviewedAt, and',
    `  attestation set to the values above (iteration=${input.iteration}` +
      `${input.planVersion != null ? `, planVersion=${input.planVersion}` : ''}).`,
    '- Output ONLY the ReviewFindings JSON object as the final content of your reply:',
    '  no prose, no reasoning, and no markdown code fences before or after it.',
    ...renderChallengeContract(input.challengeContract, input.obligationId),
    '',
    ...(input.proofContext && input.proofContext.length > 0 ? [...input.proofContext] : []),
    `Append the ${input.subjectLabel} content to review below this line:`,
  ].join('\n');
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Options for building a plan review prompt. */
export interface PlanReviewPromptOpts {
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
}

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
   * review. These are FlowGuard-executed (not agent-reported) check results, so
   * the reviewer can falsify verification claims against ground truth instead of
   * inferring them. Digest binding is the caller's responsibility: only evidence
   * for the current implementation digest must be passed. When absent or empty,
   * the section fails closed to an explicit NOT_VERIFIED line rather than being
   * silently omitted, because "no bound evidence" is itself a review signal.
   */
  readonly verificationEvidence?: readonly ReviewVerificationEvidenceItem[];
}

/**
 * A single runtime-executed verification result projected for the reviewer
 * prompt. Fields are drawn from the immutable `ValidationAttempt.result`
 * (executor-produced, tamper-evident via `outputDigest`). No raw stdout/stderr
 * is carried — only the bounded `detail` summary and the integrity digest — so
 * the section stays token-bounded while remaining independently verifiable.
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

/** Options for building an architecture (ADR) review prompt. F13 slice 6. */
export interface ArchitectureReviewPromptOpts {
  readonly adrText: string;
  readonly adrTitle: string;
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
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Build a Stack Profile section for reviewer prompts.
 * Returns empty string if no profile data is available (null-safe).
 *
 * P9c: injects phase-specific stack guidance so the reviewer receives
 * stack review rules relevant to the current workflow phase.
 */
function buildStackProfileSection(
  profileName: string | undefined,
  profileRules: string | undefined,
): string {
  if (!profileName && !profileRules) return '';
  const lines: string[] = [];
  if (profileName) {
    lines.push('## Active Stack Profile', '', profileName, '');
  }
  if (profileRules) {
    lines.push('## Stack Review Rules', '', profileRules, '');
  }
  return lines.join('\n');
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Select phase-specific reviewer profile rules from the session state.
 *
 * P9c: mapping between workflow phases and phaseRuleContent slots ensures
 * each reviewer prompt gets the correct stack guidance for PLAN_REVIEW,
 * IMPL_REVIEW, ARCH_REVIEW, and REVIEW phases.
 */
export function selectReviewerProfileRules(
  activeProfile: { name: string; phaseRuleContent?: Record<string, string> } | null | undefined,
  phase: 'PLAN_REVIEW' | 'IMPL_REVIEW' | 'ARCH_REVIEW' | 'REVIEW',
): { profileName?: string; profileRules?: string } {
  if (!activeProfile) return {};
  return {
    profileName: activeProfile.name,
    profileRules: activeProfile.phaseRuleContent?.[phase],
  };
}

/**
 * Build a prompt for plan review by the flowguard-reviewer subagent.
 *
 * The prompt includes all context needed for a meaningful review:
 * plan text, ticket text, iteration, and planVersion. These values
 * are also used by Level 3 (Prompt Integrity) enforcement.
 */
export function buildPlanReviewPrompt(opts: PlanReviewPromptOpts): string {
  const {
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
    proofGraph,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
  const discoverySection = buildDiscoveryContextSection(discoveryContext);
  return [
    `You are reviewing a plan for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    '## Plan to Review',
    '',
    planText,
    '',
    ...(stackSection ? [stackSection, ''] : []),
    ...(discoverySection ? [discoverySection, ''] : []),
    ...renderPersistedProofGraphContext(proofGraph),
    '## Instructions',
    '',
    'Review this plan against the ticket requirements. Follow your review criteria',
    'for plans. Return your findings as a single JSON object matching the',
    'ReviewFindings schema. Use the exact iteration and planVersion values above.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
    `Set attestation.reviewedBy="${REVIEWER_SUBAGENT_TYPE}".`,
    '',
    CORE_REVIEW_PROFILE_MARKER,
  ].join('\n');
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
    criteriaVersion,
    mandateDigest,
    profileName,
    profileRules,
    discoveryContext,
    challengeResolutions = [],
    verificationEvidence = [],
    proofGraph,
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
    'Return your findings as a single JSON object matching the ReviewFindings schema.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
    `Set attestation.reviewedBy="${REVIEWER_SUBAGENT_TYPE}".`,
    '',
    CORE_REVIEW_PROFILE_MARKER,
  ].join('\n');
}

/**
 * Build a prompt for architecture (ADR) review by the flowguard-reviewer subagent.
 * F13 slice 6: parity with plan/impl review prompts.
 */
export function buildArchitectureReviewPrompt(opts: ArchitectureReviewPromptOpts): string {
  const {
    adrText,
    adrTitle,
    ticketText,
    iteration,
    planVersion,
    obligationId,
    criteriaVersion,
    mandateDigest,
    profileName,
    profileRules,
    discoveryContext,
    proofGraph,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
  const discoverySection = buildDiscoveryContextSection(discoveryContext);
  return [
    `You are reviewing an architecture decision (ADR) for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    `## ADR to Review: ${adrTitle}`,
    '',
    adrText,
    '',
    ...(stackSection ? [stackSection, ''] : []),
    ...(discoverySection ? [discoverySection, ''] : []),
    ...renderPersistedProofGraphContext(proofGraph),
    '## Instructions',
    '',
    'Review this ADR against the ticket and your review criteria for Architecture',
    'Decisions (ADRs). Focus on problem framing, alternatives considered, decision',
    'rationale, consequences, reversibility, compatibility, out-of-scope clarity,',
    'and verification path. Use the read/glob/grep tools to verify any claims about',
    'existing files, schemas, or contracts referenced in the ADR.',
    'Return your findings as a single JSON object matching the ReviewFindings schema.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
    `Set attestation.reviewedBy="${REVIEWER_SUBAGENT_TYPE}".`,
    '',
    CORE_REVIEW_PROFILE_MARKER,
  ].join('\n');
}

/**
 * Build a review prompt for content-aware standalone /review.
 * Used by the plugin-orchestrator when it detects a CONTENT_ANALYSIS_REQUIRED
 * blocked response with requiredReviewAttestation.
 */
export function buildReviewContentPrompt(opts: {
  content: string;
  ticketText: string;
  obligationId: string;
  mandateDigest: string;
  criteriaVersion: string;
  iteration: number;
  planVersion: number;
  profileName?: string;
  profileRules?: string;
  // #401: Discovery context is REQUIRED for standalone PR/content review so external
  // diffs are evaluated against repo-native stack/verification/health/drift evidence.
  // The loader always returns a populated (possibly "unavailable") context, so the
  // section renders even when Discovery is degraded — never silently omitted.
  discoveryContext: DiscoveryReviewContext;
  /** Persisted advisory projection only; prompt construction never evaluates providers. */
  proofGraph?: ProofGraphProjection;
}): string {
  const stackSection = buildStackProfileSection(opts.profileName, opts.profileRules);
  const discoverySection = buildDiscoveryContextSection(opts.discoveryContext);
  const lines: string[] = [
    'You are ' + REVIEWER_SUBAGENT_TYPE + ' - a governance reviewer subagent.',
    'Review the following content for issues, risks, and missing verification.',
    'Obligation: ' + opts.obligationId,
    'Iteration: ' + String(opts.iteration) + ', PlanVersion: ' + String(opts.planVersion),
    '',
    'ATTESTATION (include these exact values in your ReviewFindings output):',
    '  reviewedBy: "' + REVIEWER_SUBAGENT_TYPE + '"',
    '  mandateDigest: "' + opts.mandateDigest + '"',
    '  criteriaVersion: "' + opts.criteriaVersion + '"',
    '  toolObligationId: "' + opts.obligationId + '"',
    '',
  ];
  if (opts.ticketText) {
    lines.push('Ticket context: ' + opts.ticketText, '');
  }
  if (stackSection) {
    lines.push(stackSection, '');
  }
  if (discoverySection) {
    lines.push(discoverySection, '');
  }
  lines.push(...renderPersistedProofGraphContext(opts.proofGraph));
  lines.push(
    'CONTENT TO REVIEW:',
    '```',
    opts.content,
    '```',
    '',
    'Return a complete ReviewFindings JSON object (no markdown fences, no extra text).',
    'Fields: reviewMode: "subagent", iteration, planVersion, overallVerdict,',
    '  blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns,',
    '  reviewedBy: { sessionId }, reviewedAt, attestation.',
    'Use ONLY these categories: completeness, correctness, feasibility, risk, quality.',
    '',
    CORE_REVIEW_PROFILE_MARKER,
  );
  return lines.join('\n');
}
