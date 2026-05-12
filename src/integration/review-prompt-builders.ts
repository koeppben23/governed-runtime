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

import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

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
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
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
  ].join('\n');
}

/**
 * Build a prompt for implementation review by the flowguard-reviewer subagent.
 */
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
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
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
    '## Instructions',
    '',
    'Review this implementation against the approved plan and ticket.',
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
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
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
}): string {
  const stackSection = buildStackProfileSection(opts.profileName, opts.profileRules);
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
  );
  return lines.join('\n');
}
