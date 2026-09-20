/**
 * @module verification/errors
 * @description Typed verification errors shared across execution and
 *              extraction.
 */

/** Compile-time validated verification error codes. */
export type VerificationErrorCode =
  'VERIFICATION_PROVIDER_FORMAT_UNSUPPORTED' | 'VERIFICATION_PARSER_NOT_REGISTERED';

/** Typed error shared by verification execution and extraction. */
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerificationError';
    this.code = code;
  }
}
