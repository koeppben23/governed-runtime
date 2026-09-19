/**
 * @module integration/errors
 * @description Typed error for integration-layer invariants and boundary
 *              failures. Every instance carries a stable machine-readable
 *              `code` so tool boundaries and callers can branch on it
 *              without inspecting message text.
 *
 * Registry-backed codes (e.g. `NO_SESSION`, `POLICY_SNAPSHOT_MISSING`)
 * keep their canonical registry semantics; projection and review
 * invariants use their existing domain codes.
 *
 * @version v1
 */

export class IntegrationInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IntegrationInvariantError';
    this.code = code;
  }
}
