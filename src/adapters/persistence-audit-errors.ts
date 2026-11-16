/**
 * @module adapters/persistence-audit-errors
 * @description Typed append-boundary errors for the canonical audit trail.
 */

/** A canonical envelope can still contain a malformed or non-appendable trail. */
export class AuditFormatError extends Error {
  readonly code = 'AUDIT_ENVELOPE_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuditFormatError';
  }
}

/** A canonical envelope can still contain tampered or reordered evidence. */
export class AuditChainError extends Error {
  readonly code = 'CHAIN_BREAK' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuditChainError';
  }
}
