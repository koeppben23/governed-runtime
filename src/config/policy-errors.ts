/**
 * @module config/policy-errors
 * @description Typed policy configuration errors.
 */

/**
 * Typed policy configuration error codes.
 * Compile-time validated -- no arbitrary strings allowed.
 */
export type PolicyConfigurationErrorCode =
  | 'EXISTING_POLICY_WEAKER_THAN_CENTRAL'
  | 'INVALID_POLICY_DIGEST'
  | 'INVALID_POLICY_DIGEST_VERSION'
  | 'INVALID_POLICY_MODE'
  | 'CENTRAL_POLICY_INVALID_MODE'
  | 'CENTRAL_POLICY_INVALID_JSON'
  | 'CENTRAL_POLICY_INVALID_SCHEMA'
  | 'CENTRAL_POLICY_PATH_EMPTY'
  | 'CENTRAL_POLICY_MISSING'
  | 'CENTRAL_POLICY_UNREADABLE'
  | 'EXPLICIT_WEAKER_THAN_CENTRAL';

/**
 * Thrown when policy configuration is invalid or contains an unsupported mode.
 *
 * Fail-stop: invalid policy must surface immediately, never silently degrade.
 *
 * Carries optional structured `details` so a logging boundary can emit
 * diagnostics (e.g. `{ received, allowed }`) WITHOUT parsing the message string.
 * The error stays a pure value — it performs no I/O and no logging itself.
 */
export class PolicyConfigurationError extends Error {
  readonly code: PolicyConfigurationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: PolicyConfigurationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PolicyConfigurationError';
    this.code = code;
    this.details = details;
  }
}
