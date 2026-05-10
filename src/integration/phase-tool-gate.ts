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

import type { Phase } from '../state/schema.js';

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
export const MUTATING_HOST_TOOLS: ReadonlySet<string> = new Set(['bash', 'write', 'edit']);

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
