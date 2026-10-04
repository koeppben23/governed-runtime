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
  | 'TSA_CONFIG_INVALID'
  | 'TSA_MOCK_FAILURE';

export class TsaError extends Error {
  readonly code: TsaErrorCode;

  constructor(code: TsaErrorCode, message: string) {
    super(message);
    this.name = 'TsaError';
    this.code = code;
  }
}

// ─── NTP Clock Check Errors ──────────────────────────────────────────────────

export type NtpErrorCode =
  | 'NTP_RESPONSE_TOO_SHORT'
  | 'NTP_RESPONSE_UNSYNCHRONIZED'
  | 'NTP_RESPONSE_VERSION_UNSUPPORTED'
  | 'NTP_RESPONSE_MODE_UNEXPECTED'
  | 'NTP_RESPONSE_STRATUM_INVALID'
  | 'NTP_RESPONSE_ORIGINATE_MISMATCH'
  | 'NTP_RESPONSE_TRANSMIT_MISSING'
  | 'NTP_QUERY_TIMEOUT'
  | 'NTP_QUERY_FAILED';

export class NtpError extends Error {
  readonly code: NtpErrorCode;

  constructor(code: NtpErrorCode, message: string) {
    super(message);
    this.name = 'NtpError';
    this.code = code;
  }
}

// ─── Audit Query Errors ──────────────────────────────────────────────────────

export type AuditQueryErrorCode = 'AUDIT_DECISION_RECEIPT_INVALID';

export class AuditQueryError extends Error {
  readonly code: AuditQueryErrorCode;

  constructor(code: AuditQueryErrorCode, message: string) {
    super(message);
    this.name = 'AuditQueryError';
    this.code = code;
  }
}
