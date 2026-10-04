/**
 * @module cli/errors
 * @description Typed domain errors for the FlowGuard CLI install/uninstall boundary.
 *
 * @version v1
 */

/**
 * Error raised by CLI install, rollback, ownership, and platform-uninstall paths.
 *
 * Carries a stable SCREAMING_SNAKE `code` so failures can be classified without
 * parsing the message. This is distinct from `InstallError`, whose codes are the
 * user-facing recovery vocabulary for tarball and reviewer-config failures.
 */
export class CliInstallError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliInstallError';
    this.code = code;
  }
}
