/**
 * @module diagnostics/types
 * @description Runtime diagnostics presentation types for blocked/error results.
 *
 * Diagnostics explain existing FlowGuard decisions. They are not authority for
 * command admissibility, policy, evidence validation, state transitions, or gates.
 */

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface RuntimeDiagnostics {
  readonly diagnosticCode: string;
  readonly severity: DiagnosticSeverity;
  readonly phase?: string;
  readonly command?: string;
  readonly policyMode?: string;
  readonly rootCause: string;
  readonly observed: readonly string[];
  readonly required: readonly string[];
  readonly missingEvidence?: readonly string[];
  readonly safeNextActions: readonly string[];
}
