/**
 * @module config/reasons
 * @description Blocked reason registry — structured error catalog for FlowGuard rails.
 *
 * Every blocked/error state in the FlowGuard system has a registered reason code.
 * The registry provides:
 * - Human-readable message templates with {variable} interpolation
 * - Recovery steps (actionable guidance for the user)
 * - Optional quick-fix commands
 * - Categorization for reporting and analytics
 *
 * Design:
 * - All rails use `blocked(code, vars)` instead of inline error strings.
 *   This ensures consistent messaging and structured recovery guidance.
 * - New codes can be registered at runtime (extension point for profiles/addons).
 * - Unknown codes fall back to a generic message (fail-open for messaging;
 *   the block itself is already enforced by the rail logic, not by the registry).
 *
 * Categories:
 * - admissibility: Command not allowed in current phase
 * - precondition:  Required evidence or state is missing
 * - input:         User input validation failed
 * - identity:      Four-eyes or authorization check failed
 * - adapter:       External system (git, filesystem) error
 * - state:         Session state error
 *
 * Dependency: leaf module — no imports from other FlowGuard modules.
 *
 * @version v1
 */

import { PRECONDITION_REASONS } from './reasons-precondition.js';
import { VALIDATION_REASONS } from './reasons-validation.js';
import { INFRA_REASONS } from './reasons-infra.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Category for blocked reason classification. */
export type BlockedCategory =
  | 'admissibility'
  | 'precondition'
  | 'input'
  | 'identity'
  | 'adapter'
  | 'state'
  | 'config';

/** A registered blocked reason with metadata. */
export interface BlockedReason {
  /** Unique reason code (e.g., "COMMAND_NOT_ALLOWED"). */
  readonly code: string;
  /** Category for reporting. */
  readonly category: BlockedCategory;
  /**
   * Message template with {variable} placeholders.
   * Example: "{command} is not allowed in phase {phase}"
   */
  readonly messageTemplate: string;
  /** Ordered recovery steps for the user. */
  readonly recoverySteps: readonly string[];
  /** Optional command that fixes the issue. */
  readonly quickFixCommand?: string;
}

/** Formatted blocked result (structured, ready for RailBlocked construction). */
export interface FormattedBlock {
  readonly code: string;
  readonly reason: string;
  readonly recovery: readonly string[];
  readonly quickFix?: string;
}

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Replace {variable} placeholders in a template string.
 * Unknown variables are left as-is (visible in output for debugging).
 */
function interpolate(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Blocked reason registry.
 *
 * Central catalog of all known blocked/error codes.
 * Pre-seeded with built-in codes, extensible at runtime.
 */
export class BlockedReasonRegistry {
  private readonly reasons = new Map<string, BlockedReason>();

  /** Register a blocked reason. Overwrites existing entries with the same code. */
  register(reason: BlockedReason): void {
    this.reasons.set(reason.code, reason);
  }

  /** Register multiple reasons at once. */
  registerAll(reasons: readonly BlockedReason[]): void {
    for (const r of reasons) this.register(r);
  }

  /** Look up a reason by code. Returns undefined if not registered. */
  get(code: string): BlockedReason | undefined {
    return this.reasons.get(code);
  }

  /**
   * Format a blocked reason with variable interpolation.
   *
   * Returns a structured result ready for RailBlocked construction.
   * Falls back to generic message for unknown codes — the block itself
   * is already enforced by the rail logic, not by the registry.
   */
  format(code: string, vars?: Record<string, string>): FormattedBlock {
    const reason = this.reasons.get(code);
    if (!reason) {
      return {
        code,
        reason: vars?.message ?? `Blocked: ${code}`,
        recovery: [],
      };
    }
    return {
      code: reason.code,
      reason: interpolate(reason.messageTemplate, vars),
      recovery: reason.recoverySteps.map((step) => interpolate(step, vars)),
      quickFix: reason.quickFixCommand ? interpolate(reason.quickFixCommand, vars) : undefined,
    };
  }

  /** All registered codes. */
  codes(): string[] {
    return Array.from(this.reasons.keys());
  }

  /** Number of registered reasons. */
  get size(): number {
    return this.reasons.size;
  }
}

/** The default registry, pre-seeded with all built-in codes (103).
 *  P10c: Reason codes split by category into 3 files.
 *  Registration order: precondition, validation, infra.
 */
export const defaultReasonRegistry = new BlockedReasonRegistry();
defaultReasonRegistry.registerAll(PRECONDITION_REASONS);
defaultReasonRegistry.registerAll(VALIDATION_REASONS);
defaultReasonRegistry.registerAll(INFRA_REASONS);

// ─── Convenience Helper ───────────────────────────────────────────────────────

/**
 * Create a RailBlocked result from a registered reason code.
 *
 * Usage in rails:
 *   return blocked("COMMAND_NOT_ALLOWED", { command: "/plan", phase: state.phase });
 *
 * Replaces inline blocked returns:
 *   return { kind: "blocked", code: "COMMAND_NOT_ALLOWED", reason: `...` };
 *
 * The returned object is structurally compatible with RailBlocked.
 * Recovery steps and quickFix are included for LLM and user guidance.
 */
export function blocked(
  code: string,
  vars?: Record<string, string>,
): {
  readonly kind: 'blocked';
  readonly code: string;
  readonly reason: string;
  readonly recovery: readonly string[];
  readonly quickFix?: string;
} {
  const formatted = defaultReasonRegistry.format(code, vars);
  return {
    kind: 'blocked' as const,
    code: formatted.code,
    reason: formatted.reason,
    recovery: formatted.recovery,
    quickFix: formatted.quickFix,
  };
}
