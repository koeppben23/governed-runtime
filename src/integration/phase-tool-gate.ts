/**
 * @module integration/phase-tool-gate
 * @description Phase-aware gate for host-platform tools.
 *
 * Investigation-only phases (TICKET, PLAN, ARCHITECTURE) restrict mutating
 * host tools (bash, write, edit) to prevent premature execution during
 * planning and investigation. Read-only tools (read, glob, grep, webfetch)
 * are always allowed.
 *
 * FlowGuard's own tools (`flowguard_*`) and `task` subagent calls are
 * excluded — they have their own enforcement in review-enforcement.ts
 * and the plugin hook pipeline.
 *
 * Pure functions, no I/O, no side effects. Unit-testable without mocks.
 *
 * @version v1
 */

import type { Phase, SessionState, TaskClass } from '../state/schema.js';
import { randomUUID } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Host-platform tools known to be mutating.
 *
 * These tools can write to the filesystem or execute arbitrary commands.
 * They are blocked during investigation-only phases where the agent should
 * only read and analyze — not execute or modify.
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

/**
 * Phases where only investigation (read-only) tools are allowed.
 *
 * In these phases, the agent is gathering information and formulating
 * plans — not executing changes. Mutating host tools are blocked.
 *
 * - TICKET: gathering requirements, reading codebase
 * - PLAN: writing a plan, reading code to understand structure
 * - ARCHITECTURE: writing an ADR, reading code and docs
 *
 * Phases NOT included (mutating tools allowed):
 * - IMPLEMENTATION: agent implements changes → full tool access
 * - VALIDATION: agent runs tests → needs bash for test execution
 * - READY: entry phase, agent may explore → no restriction
 * - *_REVIEW: reviewer subagent has platform-level permission restrictions
 * - COMPLETE, *_COMPLETE: terminal phases, no active work
 */
export const INVESTIGATION_ONLY_PHASES: ReadonlySet<Phase> = new Set([
  'TICKET',
  'PLAN',
  'ARCHITECTURE',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of a phase-tool gate check. */
export interface PhaseGateResult {
  readonly allowed: boolean;
  readonly code?: string;
  readonly reason?: string;
}

export interface RiskClassificationDecision extends PhaseGateResult {
  readonly decisionId: string;
  readonly claimedTaskClass?: TaskClass;
  readonly minimumTaskClass: TaskClass;
  readonly touchedSurfaces: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface RiskClassificationInput {
  readonly state: SessionState;
  readonly changedFiles: readonly string[];
  readonly targetPaths?: readonly string[];
  readonly now: string;
}

export type CeremonyProfile = 'full' | 'reduced';

export interface CeremonyProfileDecision {
  readonly profile: CeremonyProfile;
  readonly reason: string;
  readonly claimedTaskClass?: TaskClass;
  readonly computedMinimumTaskClass: TaskClass;
  readonly touchedSurfaces: readonly string[];
}

export interface CeremonyProfileInput {
  readonly state: SessionState;
  readonly changedFiles: readonly string[];
}

const TASK_CLASS_ORDER: Readonly<Record<TaskClass, number>> = {
  TRIVIAL: 0,
  STANDARD: 1,
  'HIGH-RISK': 2,
};

const HIGH_RISK_PREFIXES = [
  'src/state/',
  'src/machine/',
  'src/audit/',
  'src/archive/',
  'src/config/',
  'src/evidence/',
  'src/identity/',
  'src/security/',
  'src/adapters/persistence',
  'src/adapters/persistence-lock',
  'src/adapters/persistence-audit',
  'src/adapters/persistence-config',
  'src/adapters/persistence-discovery',
  'src/cli/uninstall',
  'src/integration/review/',
  'src/integration/plugin',
  'src/integration/phase-tool-gate',
  'src/rails/review',
  'src/templates/commands/',
  'scripts/release',
  'scripts/install',
  'scripts/uninstall',
  '.github/',
  '.opencode/',
] as const;

const HIGH_RISK_EXACT = new Set([
  'AGENTS.md',
  'docs/admin-model.md',
  'docs/commands.md',
  'docs/configuration.md',
  'docs/data-classification.md',
  'docs/phases.md',
  'docs/policies.md',
  'docs/profiles.md',
  'docs/retention-recovery.md',
  'docs/release-policy.md',
  'docs/security-hardening.md',
  'docs/trust-boundaries.md',
  'docs/upgrade-rollback.md',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'src/templates/mandates.ts',
  'src/templates/mandates-renderer.ts',
  'src/templates/mandates-reviewer-criteria.ts',
]);

const HIGH_RISK_RE = [
  /^docs\/agent-guidance\/.*(mandate|guidance|high-risk|review)/,
  /^docs\/.*(mandates?|governance|mapping)\.md$/,
  /^src\/cli\/(install|uninstall|doctor|release)/,
  /^src\/config\/policy/,
  /^src\/integration\/(phase-tool-gate|plugin|review|.*policy)/,
  /^src\/migration(s)?\//,
  /^src\/rails\/(review|review-decision)/,
  /^src\/templates\/commands\//,
  /(^|\/)release(\/|[-_].*)/,
  /(^|\/)installer?(\/|[-_].*)/,
  /(^|\/)migration(s)?(\/|[-_].*)/,
] as const;

const GOVERNANCE_DOC_RE =
  /(^|\/)(architecture|security|compliance|release|governance|policy)(\/|[-_].*\.md$|\.md$)/;

function normalizePathForRisk(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function maxTaskClass(a: TaskClass, b: TaskClass): TaskClass {
  return TASK_CLASS_ORDER[a] >= TASK_CLASS_ORDER[b] ? a : b;
}

function classifyPath(filePath: string): { minimumTaskClass: TaskClass; surface: string } {
  const p = normalizePathForRisk(filePath);
  if (
    HIGH_RISK_EXACT.has(p) ||
    HIGH_RISK_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
    HIGH_RISK_RE.some((pattern) => pattern.test(p))
  ) {
    return { minimumTaskClass: 'HIGH-RISK', surface: p };
  }
  if (p === 'CHANGELOG.md' || GOVERNANCE_DOC_RE.test(p)) {
    return { minimumTaskClass: 'STANDARD', surface: p };
  }
  if (p.endsWith('.test.ts') || p.endsWith('.spec.ts')) {
    return { minimumTaskClass: 'STANDARD', surface: p };
  }
  if (p.endsWith('.md')) {
    return { minimumTaskClass: 'TRIVIAL', surface: p };
  }
  return { minimumTaskClass: 'STANDARD', surface: p };
}

export function assessMinimumTaskClass(paths: readonly string[]): {
  readonly minimumTaskClass: TaskClass;
  readonly touchedSurfaces: readonly string[];
} {
  if (paths.length === 0) return { minimumTaskClass: 'TRIVIAL', touchedSurfaces: [] };
  let minimumTaskClass: TaskClass = 'TRIVIAL';
  const touchedSurfaces = new Set<string>();
  for (const filePath of paths) {
    const classified = classifyPath(filePath);
    minimumTaskClass = maxTaskClass(minimumTaskClass, classified.minimumTaskClass);
    touchedSurfaces.add(classified.surface);
  }
  return { minimumTaskClass, touchedSurfaces: [...touchedSurfaces].sort() };
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

  if (state.riskGate?.status === 'blocked') {
    return {
      allowed: false,
      code: 'RISK_GATE_BLOCKED',
      reason: state.riskGate.message,
      decisionId: state.riskGate.lastDecisionId,
      claimedTaskClass: state.claimedTaskClass,
      minimumTaskClass: assessment.minimumTaskClass,
      touchedSurfaces: assessment.touchedSurfaces,
      changedFiles: uniquePaths,
    };
  }

  const claimedTaskClass = state.claimedTaskClass;
  if (!claimedTaskClass) {
    return {
      allowed: false,
      code: 'RISK_CLASSIFICATION_REQUIRED',
      reason: 'No task-class provided. Enforced policies require an explicit claimedTaskClass.',
      decisionId,
      minimumTaskClass: assessment.minimumTaskClass,
      touchedSurfaces: assessment.touchedSurfaces,
      changedFiles: uniquePaths,
    };
  }

  if (TASK_CLASS_ORDER[claimedTaskClass] < TASK_CLASS_ORDER[assessment.minimumTaskClass]) {
    const downgradeOverrideDenied = state.policySnapshot.allowRiskDowngradeOverride === true;
    return {
      allowed: false,
      code: downgradeOverrideDenied
        ? 'RISK_DOWNGRADE_OVERRIDE_DENIED'
        : 'RISK_CLASSIFICATION_MISMATCH',
      reason:
        `Task classified as ${claimedTaskClass} but touches ${assessment.touchedSurfaces.join(', ') || 'runtime-sensitive surface'}. ` +
        `Reclassify as ${assessment.minimumTaskClass}. Downgrade overrides are not accepted in this slice.`,
      decisionId,
      claimedTaskClass,
      minimumTaskClass: assessment.minimumTaskClass,
      touchedSurfaces: assessment.touchedSurfaces,
      changedFiles: uniquePaths,
    };
  }

  return {
    allowed: true,
    decisionId,
    claimedTaskClass,
    minimumTaskClass: assessment.minimumTaskClass,
    touchedSurfaces: assessment.touchedSurfaces,
    changedFiles: uniquePaths,
  };
}

function validationEvidenceComplete(state: SessionState): boolean {
  if (state.activeChecks.length === 0) return false;
  const passed = new Set(state.validation.filter((result) => result.passed).map((r) => r.checkId));
  return state.activeChecks.every((checkId) => passed.has(checkId));
}

function hasOutstandingReviewObligation(state: SessionState): boolean {
  return (
    state.reviewAssurance?.obligations.some(
      (obligation) => obligation.status !== 'consumed' && obligation.consumedAt == null,
    ) ?? false
  );
}

export function resolveCeremonyProfile(input: CeremonyProfileInput): CeremonyProfileDecision {
  const assessment = assessMinimumTaskClass(input.changedFiles);
  const base = {
    claimedTaskClass: input.state.claimedTaskClass,
    computedMinimumTaskClass: assessment.minimumTaskClass,
    touchedSurfaces: assessment.touchedSurfaces,
  };

  if (input.state.policySnapshot.allowReducedCeremony !== true) {
    return { ...base, profile: 'full', reason: 'POLICY_REDUCED_CEREMONY_DISABLED' };
  }
  if (input.state.claimedTaskClass == null) {
    return { ...base, profile: 'full', reason: 'TASK_CLASS_CLAIM_MISSING' };
  }
  if (input.state.claimedTaskClass !== 'TRIVIAL') {
    return { ...base, profile: 'full', reason: 'CLAIMED_CLASS_NOT_TRIVIAL' };
  }
  if (input.state.policySnapshot.reviewInvocationPolicy === 'host_task_required') {
    return { ...base, profile: 'full', reason: 'POLICY_REVIEW_REQUIRED' };
  }
  if (input.state.riskGate?.status === 'blocked') {
    return { ...base, profile: 'full', reason: 'RISK_GATE_BLOCKED' };
  }
  if (input.changedFiles.length === 0) {
    return { ...base, profile: 'full', reason: 'RISK_EVIDENCE_MISSING' };
  }
  if (assessment.minimumTaskClass !== 'TRIVIAL') {
    return { ...base, profile: 'full', reason: 'COMPUTED_MINIMUM_NOT_TRIVIAL' };
  }
  if (!validationEvidenceComplete(input.state)) {
    return { ...base, profile: 'full', reason: 'VERIFICATION_EVIDENCE_INCOMPLETE' };
  }
  if (hasOutstandingReviewObligation(input.state)) {
    return { ...base, profile: 'full', reason: 'REVIEW_OBLIGATION_REQUIRED' };
  }

  return { ...base, profile: 'reduced', reason: 'RUNTIME_VERIFIED_TRIVIAL' };
}

// ─── Gate Functions ───────────────────────────────────────────────────────────

/**
 * Check if a tool name is in the mutating host tools set.
 *
 * Quick predicate used by the plugin hook to skip the full phase gate
 * check for non-mutating tools (avoids unnecessary async state reads).
 */
export function isMutatingHostTool(toolName: string): boolean {
  return MUTATING_HOST_TOOLS.has(toolName);
}

/**
 * Check if a host-platform tool is allowed in the given phase.
 *
 * Rules (evaluated in order):
 * 1. Non-mutating tools → always allowed.
 * 2. Mutating tools in non-investigation phases → allowed.
 * 3. Mutating tools in investigation-only phases → BLOCKED.
 *
 * @param toolName - Host-platform tool name (e.g. 'bash', 'write', 'read')
 * @param phase - Current session phase
 * @returns Gate result with allowed flag and optional reason code
 */
export function isHostToolAllowedInPhase(toolName: string, phase: Phase): PhaseGateResult {
  if (!MUTATING_HOST_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  if (!INVESTIGATION_ONLY_PHASES.has(phase)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'HOST_TOOL_PHASE_DENIED',
    reason:
      `'${toolName}' is not allowed in phase ${phase}. ` +
      `Use read-only tools (read, glob, grep) for investigation during planning.`,
  };
}
