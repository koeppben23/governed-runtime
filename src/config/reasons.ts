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
 * - Built-in codes are registered during module initialization, then frozen.
 * - Unknown codes are marked as unregistered so audit output cannot look like
 *   catalog-backed governance messaging.
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

/** Warning event emitted by the reason registry without depending on logging layers. */
export interface ReasonWarningEvent {
  readonly kind: 'missing_interpolation_variable';
  readonly code: string;
  readonly placeholder: string;
}

/** Minimal optional warning sink for deterministic tests and outer-layer logging adapters. */
export type ReasonWarningSink = (event: ReasonWarningEvent) => void;

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Replace {variable} placeholders in a template string.
 * Unknown variables are left as-is (visible in output for debugging) and reported.
 */
function interpolate(
  code: string,
  template: string,
  vars: Record<string, string> | undefined,
  warn: ReasonWarningSink | undefined,
): string {
  const values = vars ?? {};
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      try {
        warn?.({ kind: 'missing_interpolation_variable', code, placeholder: key });
      } catch {
        // Warning sinks must not turn formatting into a secondary failure.
      }
      return match;
    }
    return value;
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Blocked reason registry.
 *
 * Central catalog of all known blocked/error codes.
 * Pre-seeded with built-in codes and frozen after initialization.
 */
export class BlockedReasonRegistry {
  private readonly reasons = new Map<string, BlockedReason>();
  private frozen = false;

  constructor(private readonly warn?: ReasonWarningSink) {}

  /** Register a blocked reason. Duplicate codes and frozen registries fail fast. */
  register(reason: BlockedReason): void {
    if (this.frozen) {
      throw new Error(`Reason registry is frozen; cannot register ${reason.code}`);
    }
    if (this.reasons.has(reason.code)) {
      throw new Error(`Reason code ${reason.code} is already registered`);
    }
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

  /** Prevent further registration after the registry has been initialized. */
  freeze(): void {
    this.frozen = true;
  }

  /**
   * Format a blocked reason with variable interpolation.
   *
   * Returns a structured result ready for RailBlocked construction.
   * Unknown codes are marked explicitly so they cannot be confused with
   * catalog-backed governance messages.
   */
  format(code: string, vars?: Record<string, string>): FormattedBlock {
    const reason = this.reasons.get(code);
    if (!reason) {
      const context = vars?.message ? ` Context: ${vars.message}` : '';
      return {
        code,
        reason: `[UNREGISTERED_REASON: ${code}] No registered reason found.${context}`,
        recovery: [
          '[UNREGISTERED_REASON] Register this code in the FlowGuard reason catalog before emitting it.',
        ],
      };
    }
    return {
      code: reason.code,
      reason: interpolate(reason.code, reason.messageTemplate, vars, this.warn),
      recovery: reason.recoverySteps.map((step) => interpolate(reason.code, step, vars, this.warn)),
      quickFix: reason.quickFixCommand
        ? interpolate(reason.code, reason.quickFixCommand, vars, this.warn)
        : undefined,
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

/** The default registry, pre-seeded with all built-in codes.
 *  P10c: Reason codes split by category into 3 files.
 *  Registration order: precondition, validation, infra.
 */
export const defaultReasonRegistry = new BlockedReasonRegistry();
defaultReasonRegistry.registerAll(PRECONDITION_REASONS);
defaultReasonRegistry.registerAll(VALIDATION_REASONS);
defaultReasonRegistry.registerAll(INFRA_REASONS);
defaultReasonRegistry.freeze();

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
