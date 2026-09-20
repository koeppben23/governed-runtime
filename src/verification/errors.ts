/**
 * @module verification/errors
 * @description Typed verification errors shared across execution, extraction,
 *              and assertion report parsing.
 */

/** Compile-time validated verification error codes. */
export type VerificationErrorCode =
  | 'VERIFICATION_PROVIDER_FORMAT_UNSUPPORTED'
  | 'VERIFICATION_PARSER_NOT_REGISTERED'
  | 'VERIFICATION_REPORT_PARSE_FAILED'
  | 'VERIFICATION_REPORT_SHAPE_INVALID';

/** Typed error shared by verification execution, extraction, and report parsers. */
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerificationError';
    this.code = code;
  }
}
