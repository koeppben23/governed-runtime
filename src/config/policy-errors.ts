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
 */
export class PolicyConfigurationError extends Error {
  readonly code: PolicyConfigurationErrorCode;

  constructor(code: PolicyConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'PolicyConfigurationError';
    this.code = code;
  }
}
