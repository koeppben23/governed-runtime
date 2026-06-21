/**
 * @module audit/errors
 * @description Typed error classes for the audit subsystem.
 *              Follows the code pattern established by PersistenceError,
 *              GitError, and other adapter-layer errors.
 *
 * @version v1
 */

// ─── RFC3161 / TSA Errors ────────────────────────────────────────────────────

export type TsaErrorCode =
  | 'TSA_URL_REQUIRED'
  | 'TSA_UNSUPPORTED_DIGEST'
  | 'TSA_MALFORMED_ASN1'
  | 'TSA_HTTP_FAILURE'
  | 'TSA_RESPONSE_EMPTY'
  | 'TSA_REJECTED'
  | 'TSA_MISSING_TOKEN'
  | 'TSA_HEX_ODD_LENGTH'
  | 'TSA_HEX_INVALID'
  | 'TSA_CONFIG_INVALID';

export class TsaError extends Error {
  readonly code: TsaErrorCode;

  constructor(code: TsaErrorCode, message: string) {
    super(message);
    this.name = 'TsaError';
    this.code = code;
  }
}
