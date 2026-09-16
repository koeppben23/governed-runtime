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
 * - adapter:       External system (git, filesystem, host transport) error
 * - state:         Session state error
 *
 * Dependency: leaf module — no imports from other FlowGuard modules.
 *
 * @version v1
 */

import { PRECONDITION_REASONS } from './reasons-precondition.js';
import { ARCHITECTURE_REASONS } from './reasons-architecture.js';
import { VALIDATION_REASONS } from './reasons-validation.js';
import { INFRA_REASONS } from './reasons-infra.js';
import { PROOFGRAPH_REASONS } from './reasons-proofgraph.js';
import { MUTATION_REASONS } from './reasons-mutation.js';
import type { BlockedReason, FormattedBlock, ReasonWarningSink } from './reasons-types.js';

export type {
  BlockedCategory,
  BlockedReason,
  FormattedBlock,
  ReasonWarningEvent,
  ReasonWarningSink,
} from './reasons-types.js';

export type ReasonRegistryErrorCode = 'REGISTRY_FROZEN' | 'REGISTRY_DUPLICATE';

export class ReasonRegistryError extends Error {
  readonly code: ReasonRegistryErrorCode;

  constructor(code: ReasonRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ReasonRegistryError';
    this.code = code;
  }
}

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

export class BlockedReasonRegistry {
  private readonly reasons = new Map<string, BlockedReason>();
  private frozen = false;

  constructor(private readonly warn?: ReasonWarningSink) {}

  register(reason: BlockedReason): void {
    if (this.frozen) {
      throw new ReasonRegistryError(
        'REGISTRY_FROZEN',
        `Reason registry is frozen; cannot register ${reason.code}`,
      );
    }
    if (this.reasons.has(reason.code)) {
      throw new ReasonRegistryError(
        'REGISTRY_DUPLICATE',
        `Reason code ${reason.code} is already registered`,
      );
    }
    this.reasons.set(reason.code, reason);
  }

  registerAll(reasons: readonly BlockedReason[]): void {
    for (const r of reasons) this.register(r);
  }

  get(code: string): BlockedReason | undefined {
    return this.reasons.get(code);
  }

  freeze(): void {
    this.frozen = true;
  }

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

  codes(): string[] {
    return Array.from(this.reasons.keys());
  }

  get size(): number {
    return this.reasons.size;
  }
}

/**
 * Default registry, pre-seeded with all built-in codes.
 * Review-transport failures are a distinct infrastructure concern rather than
 * reviewer verdicts; their catalog stays separate from domain review reasons.
 */
export const defaultReasonRegistry = new BlockedReasonRegistry();
defaultReasonRegistry.registerAll(PRECONDITION_REASONS);
defaultReasonRegistry.registerAll(ARCHITECTURE_REASONS);
defaultReasonRegistry.registerAll(VALIDATION_REASONS);
defaultReasonRegistry.registerAll(INFRA_REASONS);
defaultReasonRegistry.registerAll(PROOFGRAPH_REASONS);
defaultReasonRegistry.registerAll(MUTATION_REASONS);
defaultReasonRegistry.freeze();

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
