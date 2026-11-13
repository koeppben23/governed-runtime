/**
 * @module verification/errors
 * @description Typed verification errors shared across execution and
 *              extraction.
 */

/** Compile-time validated verification error codes. */
export type VerificationErrorCode =
  | 'VERIFICATION_FALSIFICATION_UNAVAILABLE'
  | 'VERIFICATION_PROVIDER_FORMAT_UNSUPPORTED'
  | 'VERIFICATION_PARSER_NOT_REGISTERED'
  | 'VERIFICATION_REPORT_ISOLATION_FAILED';

/** Typed error shared by verification execution and extraction. */
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerificationError';
    this.code = code;
  }
}

/**
 * A declared falsification variant could not establish evidence. This is an
 * unmet evidence obligation (the claim stays NOT_VERIFIED), not a crash: the
 * surrounding validation attempt is still recorded.
 */
export class FalsificationUnavailableError extends VerificationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('VERIFICATION_FALSIFICATION_UNAVAILABLE', message, options);
    this.name = 'FalsificationUnavailableError';
  }
}
