/** Category for blocked reason classification. */
export type BlockedCategory =
  'admissibility' | 'precondition' | 'input' | 'identity' | 'adapter' | 'state' | 'config';

/** A registered blocked reason with metadata. */
export interface BlockedReason {
  /** Unique reason code (e.g., "COMMAND_NOT_ALLOWED"). */
  readonly code: string;
  /** Category for reporting. */
  readonly category: BlockedCategory;
  /** Message template with {variable} placeholders. */
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
