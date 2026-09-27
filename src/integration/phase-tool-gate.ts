/**
 * @module integration/phase-tool-gate
 * @description Phase-aware gate for host-platform tools.
 *
 * Host mutations are authorized exclusively during IMPLEMENTATION. Read-only
 * tools (read, glob, grep, webfetch, todowrite) are always allowed.
 *
 * FlowGuard's own tools (`flowguard_*`) and `task` subagent calls are
 * excluded — they have their own enforcement in review-enforcement.ts
 * and the plugin hook pipeline.
 *
 * Pure functions, no I/O, no side effects. Unit-testable without mocks.
 *
 * @version v1
 */

import type {
  Phase,
  ReducedCeremonyVerificationBasis,
  RiskTrigger,
  SessionState,
} from '../state/schema.js';
import { randomUUID } from 'node:crypto';
import { hasOutstandingReviewObligation } from '../state/review-dispatch.js';
import {
  resolveEffectiveTaskClass,
  ticketRiskDeclarationFloor,
  verifyTicketRiskDeclarationIntegrity,
  type TicketRiskDeclaration,
} from '../state/risk-declaration.js';
import { maxTaskClass, type TaskClass } from '../state/task-class.js';
import {
  assessMinimumTaskClass,
  normalizePathForRisk,
  reducedCeremonyEligible,
} from './risk-path-classifier.js';
import { evaluateImplValidationEvidence } from '../machine/impl-validation-evidence.js';
import type { GateDecision } from '../shared/gate-decision.js';
import { FLOWGUARD_TOOL_PREFIX, MCP_FLOWGUARD_TOOL_PREFIX } from './tool-names.js';
import { buildEnforcementError } from './blocked-result.js';
import { appendReviewAuditEvent } from './review/evidence/audit-events.js';

function riskClassificationFacts(input: {
  readonly state: SessionState;
  readonly decisionId: string;
  readonly computedMinimumTaskClass: TaskClass;
  readonly provisional: boolean;
  readonly unknownScope: boolean;
  readonly touchedSurfaces: readonly string[];
  readonly riskTriggers: readonly RiskTrigger[];
  readonly changedFiles: readonly string[];
}): RiskClassificationFacts {
  const ticket = input.state.ticket;
  const declaration: TicketRiskDeclaration = ticket?.riskDeclaration ?? { kind: 'absent' };
  const escalatedTaskClass = input.state.claimedTaskClass;
  const effectiveTaskClass = resolveEffectiveTaskClass({
    computed: input.computedMinimumTaskClass,
    declaration,
    escalated: escalatedTaskClass,
  });
  return {
    decisionId: input.decisionId,
    minimumTaskClass: input.computedMinimumTaskClass,
    effectiveTaskClass,
    declaredTaskClass: ticketRiskDeclarationFloor(declaration),
    declarationKind: declaration.kind,
    ticketDigest: ticket?.digest ?? null,
    ...(escalatedTaskClass !== undefined ? { escalatedTaskClass } : {}),
    provisional: input.provisional,
    unknownScope: input.unknownScope,
    touchedSurfaces: input.touchedSurfaces,
    riskTriggers: input.riskTriggers,
    changedFiles: input.changedFiles,
  };
}

export { maxTaskClass } from '../state/task-class.js';
export {
  assessMinimumTaskClass,
  isNonDomainConfigPath,
  reducedCeremonyEligible,
} from './risk-path-classifier.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Host-platform tools known to be mutating.
 *
 * These tools can write to the filesystem or execute arbitrary commands.
 * They are allowed only during IMPLEMENTATION, where the recorded
 * implementation evidence can bind their outcomes to a review subject.
 *
 * Intentionally does NOT include:
 * - `read`, `glob`, `grep`: read-only investigation tools
 * - `webfetch`: read-only (fetches URL content), useful for ticket research
 * - `task`: governed separately by subagent enforcement (BUG-08)
 * - `flowguard_*`: governed by FlowGuard's own command admissibility
 */
export const MUTATING_HOST_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'write',
  'edit',
  'apply_patch',
]);

export const READ_ONLY_HOST_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'glob',
  'grep',
  'webfetch',
  // todowrite is a host task-list / organization tool: it does not write
  // repository files, run commands, or mutate FlowGuard session/audit/evidence
  // state. Its risk profile matches read/glob/grep, so it is always allowed and
  // never triggers the unknown-host-tool default deny.
  'todowrite',
]);

function isGovernedOutsideHostPhaseGate(toolName: string): boolean {
  return (
    toolName === 'task' ||
    toolName.startsWith(FLOWGUARD_TOOL_PREFIX) ||
    toolName.startsWith(MCP_FLOWGUARD_TOOL_PREFIX)
  );
}

/**
 * The sole phase in which a host mutation may be authorized. This is a
 * positive authority boundary: allowing a mutation elsewhere can make the
 * reviewed implementation digest stale before human approval.
 */
export const HOST_MUTATION_PHASE: Phase = 'IMPLEMENTATION';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Denial codes emitted by the host phase gate. */
export type HostPhaseGateCode = 'HOST_TOOL_UNKNOWN_DENIED' | 'HOST_TOOL_PHASE_DENIED';

/** Result of a phase-tool gate check: fail-closed, denial code always present. */
export type PhaseGateResult = GateDecision<HostPhaseGateCode>;

/** Denial codes emitted by risk classification. */
export type RiskClassificationCode =
  | 'RISK_GATE_BLOCKED'
  | 'TICKET_RISK_DECLARATION_INVALID'
  | 'TICKET_RISK_DECLARATION_INCONSISTENT'
  | 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE';

/** Risk classification facts carried by both allow and deny outcomes. */
export interface RiskClassificationFacts {
  readonly decisionId: string;
  /** Runtime-computed minimum over the known file set. */
  readonly minimumTaskClass: TaskClass;
  /** Conservative effective class: max(computed, ticket floor, escalation). */
  readonly effectiveTaskClass: TaskClass;
  readonly declaredTaskClass: TaskClass | null;
  readonly declarationKind: TicketRiskDeclaration['kind'];
  readonly ticketDigest: string | null;
  readonly escalatedTaskClass?: TaskClass;
  /** Provisional (pre-implementation) vs final (actual changed files). */
  readonly provisional: boolean;
  /** True when the known scope is incomplete (unknown target paths). */
  readonly unknownScope: boolean;
  readonly touchedSurfaces: readonly string[];
  readonly riskTriggers: readonly RiskTrigger[];
  readonly changedFiles: readonly string[];
}

export type RiskClassificationDecision = GateDecision<RiskClassificationCode> &
  RiskClassificationFacts;

/** A denied risk decision: `code` and `reason` are guaranteed by the compiler. */
export type DeniedRiskClassificationDecision = Extract<
  RiskClassificationDecision,
  { allowed: false }
>;

export interface RiskClassificationInput {
  readonly state: SessionState;
  readonly changedFiles: readonly string[];
  readonly targetPaths?: readonly string[];
  /**
   * `provisional` runs before implementation: plan scope and observed targets
   * only, with unknown scope never treated as TRIVIAL. `final` runs over the
   * complete actual file set and is the only class that may justify reduction.
   */
  readonly mode?: 'provisional' | 'final';
  /** Set by the caller when target paths cannot be resolved (e.g. bash). */
  readonly unknownScope?: boolean;
  readonly now: string;
}

export type CeremonyProfile = 'full' | 'reduced';

interface CeremonyProfileFacts {
  readonly reason: string;
  /** Runtime-computed minimum over the complete actual file set. */
  readonly computedMinimumTaskClass: TaskClass;
  /** Conservative effective class: max(computed, ticket floor, escalation). */
  readonly effectiveTaskClass: TaskClass;
  readonly declaredTaskClass: TaskClass | null;
  readonly declarationKind: TicketRiskDeclaration['kind'];
  readonly ticketDigest: string | null;
  readonly escalatedTaskClass?: TaskClass;
  readonly touchedSurfaces: readonly string[];
  readonly riskTriggers: readonly RiskTrigger[];
}

/**
 * Final ceremony decision. `reduced` carries the full evidence binding; the
 * machine guard re-verifies every field and never trusts the decision alone.
 */
export interface ReducedCeremonyProfileDecision extends CeremonyProfileFacts {
  readonly profile: 'reduced';
  readonly implementationId: string;
  readonly implementationDigest: string;
  readonly policyDigest: string;
  readonly verificationBasis: ReducedCeremonyVerificationBasis;
}

export interface FullCeremonyProfileDecision extends CeremonyProfileFacts {
  readonly profile: 'full';
}

export type CeremonyProfileDecision = ReducedCeremonyProfileDecision | FullCeremonyProfileDecision;

/**
 * Pre-verification projection recorded by `/implement`. The pending state is
 * derived, never persisted: only the final decision is state evidence.
 */
export type CeremonyEligibilityProjection =
  | { readonly status: 'pending_post_implementation_verification'; readonly reason: string }
  | { readonly status: 'ineligible'; readonly reason: string };

export interface CeremonyProfileInput {
  readonly state: SessionState;
  readonly changedFiles: readonly string[];
}

/**
 * Ticket-declaration gate projection: derived purely from the persisted ticket
 * (never an independent authority) and bound to the ticket digest. An invalid
 * declaration or a declaration/text inconsistency blocks risk-relevant
 * mutations before execution, independent of `enforceRiskClassification`.
 * Re-capturing the ticket via `/task` replaces the ticket and thereby clears
 * exactly a ticket-derived block; an independent `riskGate` block is never
 * touched.
 */
export type TicketDeclarationGate =
  | { readonly status: 'clear' }
  | {
      readonly status: 'blocked';
      readonly code: 'TICKET_RISK_DECLARATION_INVALID' | 'TICKET_RISK_DECLARATION_INCONSISTENT';
      readonly reason: string;
    };

/** Ticket-declared floor for obligation/challenge classification. */
export function declaredTaskClassFor(state: SessionState): TaskClass | null {
  return ticketRiskDeclarationFloor(state.ticket?.riskDeclaration ?? { kind: 'absent' });
}

/**
 * Pre-execution enforcement of the ticket-declaration gate: an invalid or
 * inconsistent declaration blocks risk-relevant mutations independently of
 * `enforceRiskClassification`. The block is audited WITHOUT latching the
 * independent `riskGate`, so re-capturing the ticket via `/task` clears it.
 */
export async function enforceTicketDeclarationGate(
  sessDir: string,
  state: SessionState,
  toolName: string,
): Promise<void> {
  const gate = ticketDeclarationGate(state);
  if (gate.status !== 'blocked') return;
  try {
    await appendReviewAuditEvent(
      sessDir,
      state.binding.hostSessionId,
      state.phase,
      'risk:classification_checked',
      ticketBlockAuditDetail(state, gate),
    );
  } catch (err) {
    throw buildEnforcementError(
      'AUDIT_PERSISTENCE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
  throw buildEnforcementError(gate.code, gate.reason, {
    sessionId: state.binding.hostSessionId,
    tool: toolName,
    declarationKind: state.ticket?.riskDeclaration.kind ?? 'absent',
    ticketDigest: state.ticket?.digest ?? 'none',
  });
}

function ticketBlockAuditDetail(
  state: SessionState,
  gate: Extract<TicketDeclarationGate, { status: 'blocked' }>,
): Record<string, unknown> {
  const digest = state.ticket?.digest;
  return {
    decisionId: `TICKET-${Date.now()}-${digest?.slice(0, 12) ?? 'no-ticket'}`,
    decision: 'blocked',
    reasonCode: gate.code,
    reason: gate.reason,
    declarationKind: state.ticket?.riskDeclaration.kind ?? 'absent',
    ticketDigest: digest ?? null,
    changedFilesSummary: [],
  };
}

export function ticketDeclarationGate(state: SessionState): TicketDeclarationGate {
  const ticket = state.ticket;
  if (ticket === null) return { status: 'clear' };
  if (!verifyTicketRiskDeclarationIntegrity(ticket)) {
    return {
      status: 'blocked',
      code: 'TICKET_RISK_DECLARATION_INCONSISTENT',
      reason:
        'the stored ticket risk declaration does not match the parser result over the ticket text ' +
        '(or the ticket digest does not hash that text); re-run /task to re-capture the ticket',
    };
  }
  if (ticket.riskDeclaration.kind === 'invalid') {
    return {
      status: 'blocked',
      code: 'TICKET_RISK_DECLARATION_INVALID',
      reason:
        `the ticket declares an invalid risk class ('${ticket.riskDeclaration.raw}'); ` +
        'risk-relevant mutations are blocked until the ticket is corrected',
    };
  }
  return { status: 'clear' };
}

export function isRiskClassificationAllowed(
  input: RiskClassificationInput,
): RiskClassificationDecision {
  const { state, now } = input;
  const decisionId = `RISK-${now.replace(/[^0-9]/g, '')}-${randomUUID()}`;
  const combinedPaths = [...input.changedFiles, ...(input.targetPaths ?? [])].map(
    normalizePathForRisk,
  );
  const uniquePaths = [...new Set(combinedPaths)].sort();
  const assessment = assessMinimumTaskClass(uniquePaths);
  const provisional = (input.mode ?? 'final') === 'provisional';
  const unknownScope = input.unknownScope === true;
  // Missing scope information is never interpreted as low risk: the
  // provisional class is floored at STANDARD when targets are unknown.
  const computedMinimumTaskClass =
    provisional && unknownScope
      ? maxTaskClass(assessment.minimumTaskClass, 'STANDARD')
      : assessment.minimumTaskClass;

  const facts = riskClassificationFacts({
    state,
    decisionId,
    computedMinimumTaskClass,
    provisional,
    unknownScope,
    touchedSurfaces: assessment.touchedSurfaces,
    riskTriggers: assessment.riskTriggers,
    changedFiles: uniquePaths,
  });

  if (state.riskGate?.status === 'blocked') {
    return {
      allowed: false,
      code: 'RISK_GATE_BLOCKED',
      reason: state.riskGate.message,
      ...facts,
      decisionId: state.riskGate.lastDecisionId,
    };
  }

  const declarationGate = ticketDeclarationGate(state);
  if (declarationGate.status === 'blocked') {
    return {
      allowed: false,
      code: declarationGate.code,
      reason: declarationGate.reason,
      ...facts,
    };
  }

  return { allowed: true, ...facts };
}

/**
 * Static ceremony ineligibility reason, or null when the change is a candidate
 * pending post-implementation verification. Performs no evidence evaluation.
 */
function staticCeremonyIneligibilityReason(input: CeremonyProfileInput): string | null {
  const policy = input.state.policySnapshot;
  if (policy.allowReducedCeremony !== true) return 'POLICY_REDUCED_CEREMONY_DISABLED';
  if (policy.requireHumanGates !== true) return 'POLICY_HUMAN_GATE_REQUIRED_FOR_REDUCED_CEREMONY';
  const declarationGate = ticketDeclarationGate(input.state);
  if (declarationGate.status === 'blocked') return declarationGate.code;
  if (input.state.ticket?.riskDeclaration.kind === 'conflict') {
    return 'TICKET_RISK_DECLARATION_CONFLICT';
  }
  if (input.state.riskGate?.status === 'blocked') return 'RISK_GATE_BLOCKED';
  if (input.changedFiles.length === 0) return 'RISK_EVIDENCE_MISSING';
  // Only the FINAL effective class may justify reduction: max over the complete
  // actual file set, the ticket-declared floor and an optional escalation.
  const effective = ceremonyEffectiveTaskClass(input.state, input.changedFiles);
  if (effective !== 'TRIVIAL') return 'RESOLVED_RISK_NOT_TRIVIAL';
  if (!reducedCeremonyEligible(input.changedFiles)) return 'REDUCED_CEREMONY_SURFACE_EXCLUDED';
  return null;
}

function ceremonyEffectiveTaskClass(
  state: SessionState,
  changedFiles: readonly string[],
): TaskClass {
  const declaration: TicketRiskDeclaration = state.ticket?.riskDeclaration ?? { kind: 'absent' };
  return resolveEffectiveTaskClass({
    computed: assessMinimumTaskClass(changedFiles).minimumTaskClass,
    declaration,
    escalated: state.claimedTaskClass,
  });
}

/**
 * `/implement` projection: a candidate awaiting post-implementation
 * verification, or the static ineligibility reason. This is never a ceremony
 * decision and is deliberately not persisted.
 */
export function projectCeremonyEligibility(
  input: CeremonyProfileInput,
): CeremonyEligibilityProjection {
  const reason = staticCeremonyIneligibilityReason(input);
  return reason === null
    ? {
        status: 'pending_post_implementation_verification',
        reason: 'AWAITING_POST_IMPLEMENTATION_VERIFICATION',
      }
    : { status: 'ineligible', reason };
}

/**
 * The single final ceremony authority. Called with the freshly merged
 * post-check state so the decision binds the actual delivered bytes and the
 * canonical latest-pass evidence. Never authorizes without complete passing
 * checks bound to the current implementation generation.
 */
export function resolveCeremonyProfile(input: CeremonyProfileInput): CeremonyProfileDecision {
  const assessment = assessMinimumTaskClass(input.changedFiles);
  const declaration: TicketRiskDeclaration = input.state.ticket?.riskDeclaration ?? {
    kind: 'absent',
  };
  const escalatedTaskClass = input.state.claimedTaskClass;
  const declaredTaskClass = ticketRiskDeclarationFloor(declaration);
  const effectiveTaskClass = resolveEffectiveTaskClass({
    computed: assessment.minimumTaskClass,
    declaration,
    escalated: escalatedTaskClass,
  });
  const base = {
    computedMinimumTaskClass: assessment.minimumTaskClass,
    effectiveTaskClass,
    declaredTaskClass,
    declarationKind: declaration.kind,
    ticketDigest: input.state.ticket?.digest ?? null,
    ...(escalatedTaskClass !== undefined ? { escalatedTaskClass } : {}),
    touchedSurfaces: assessment.touchedSurfaces,
    riskTriggers: assessment.riskTriggers,
  };

  const staticReason = staticCeremonyIneligibilityReason(input);
  if (staticReason !== null) return { ...base, profile: 'full', reason: staticReason };
  if (hasOutstandingReviewObligation(input.state.reviewAssurance)) {
    return { ...base, profile: 'full', reason: 'REVIEW_OBLIGATION_REQUIRED' };
  }
  const implementation = input.state.implementation;
  if (implementation === null) {
    return { ...base, profile: 'full', reason: 'IMPLEMENTATION_EVIDENCE_MISSING' };
  }
  const evidence = evaluateImplValidationEvidence(input.state);
  if (!evidence.satisfied) {
    return { ...base, profile: 'full', reason: 'VERIFICATION_EVIDENCE_INCOMPLETE' };
  }

  return {
    ...base,
    profile: 'reduced',
    reason: 'POST_IMPL_VERIFIED_TRIVIAL',
    implementationId: implementation.implementationId,
    implementationDigest: implementation.digest,
    policyDigest: input.state.policySnapshot.hash,
    verificationBasis: {
      checkIds: [...evidence.activeChecks],
      attempts: evidence.basis.map((entry) => ({ ...entry })),
    },
  };
}

// ─── Gate Functions ───────────────────────────────────────────────────────────

/**
 * Check if a tool name is in the mutating host tools set.
 *
 * Quick predicate used by the plugin hook to skip the full phase gate
 * check for non-mutating tools (avoids unnecessary async state reads).
 */
export function isMutatingHostTool(toolName: string): boolean {
  if (MUTATING_HOST_TOOLS.has(toolName)) return true;
  if (READ_ONLY_HOST_TOOLS.has(toolName)) return false;
  if (isGovernedOutsideHostPhaseGate(toolName)) return false;
  return true;
}

/**
 * Check if a host-platform tool is allowed in the given phase.
 *
 * Rules (evaluated in order):
 * 1. Non-mutating tools → always allowed.
 * 2. Mutating tools in IMPLEMENTATION → allowed.
 * 3. Mutating tools in every other phase → BLOCKED.
 *
 * @param toolName - Host-platform tool name (e.g. 'bash', 'write', 'read')
 * @param phase - Current session phase
 * @returns Gate result with allowed flag and optional reason code
 */
export function isHostToolAllowedInPhase(toolName: string, phase: Phase): PhaseGateResult {
  if (READ_ONLY_HOST_TOOLS.has(toolName) || isGovernedOutsideHostPhaseGate(toolName)) {
    return { allowed: true };
  }

  if (!MUTATING_HOST_TOOLS.has(toolName)) {
    return {
      allowed: false,
      code: 'HOST_TOOL_UNKNOWN_DENIED',
      reason: `'${toolName}' is not an explicitly allowed host tool. Unknown host tools are denied by default.`,
    };
  }

  if (phase === HOST_MUTATION_PHASE) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'HOST_TOOL_PHASE_DENIED',
    reason:
      `'${toolName}' is only allowed in phase ${HOST_MUTATION_PHASE}, not ${phase}. ` +
      'Use read-only tools (read, glob, grep) outside implementation.',
  };
}
