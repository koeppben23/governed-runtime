/**
 * @module providers/assertion-parsers/errors
 * @description Provider-owned error for assertion report parsing.
 */

export type AssertionParseErrorCode =
  'VERIFICATION_REPORT_PARSE_FAILED' | 'VERIFICATION_REPORT_SHAPE_INVALID';

export class AssertionParseError extends Error {
  readonly code: AssertionParseErrorCode;

  constructor(code: AssertionParseErrorCode, message: string) {
    super(message);
    this.name = 'AssertionParseError';
    this.code = code;
  }
}
