/**
 * @module identity/errors
 * @description IdP verification error codes (P35a/P35b1).
 *
 * All errors are fail-closed. No silent degradation.
 */

export class IdpError extends Error {
  constructor(
    public readonly code: IdpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdpError';
  }
}

export type IdpErrorCode =
  | 'IDP_TOKEN_MISSING'
  | 'IDP_TOKEN_INVALID'
  | 'IDP_TOKEN_KID_MISSING'
  | 'IDP_TOKEN_HEADER_INVALID'
  | 'IDP_KEY_NOT_FOUND'
  | 'IDP_JWKS_PATH_MISSING'
  | 'IDP_JWKS_URI_INVALID'
  | 'IDP_JWKS_READ_FAILED'
  | 'IDP_JWKS_FETCH_FAILED'
  | 'IDP_JWKS_INVALID'
  | 'IDP_JWKS_KEY_NOT_FOUND'
  | 'IDP_JWKS_ALGORITHM_MISMATCH'
  | 'IDP_ALGORITHM_NOT_ALLOWED'
  | 'IDP_SIGNATURE_INVALID'
  | 'IDP_ISSUER_MISMATCH'
  | 'IDP_AUDIENCE_MISMATCH'
  | 'IDP_EXPIRED'
  | 'IDP_NOT_YET_VALID'
  | 'IDP_SUBJECT_MISSING'
  | 'IDP_CLAIM_MAPPING_INVALID'
  | 'IDP_NOT_CONFIGURED'
  | 'IDP_CONFIG_INVALID';

export const IDP_ERROR_MESSAGES: Record<IdpErrorCode, string> = {
  IDP_TOKEN_MISSING: 'No IdP token found at configured path',
  IDP_TOKEN_INVALID: 'IdP token is not valid JWT format',
  IDP_TOKEN_KID_MISSING: 'IdP token header is missing kid',
  IDP_TOKEN_HEADER_INVALID: 'IdP token header is invalid or missing alg/kid',
  IDP_KEY_NOT_FOUND: 'Signing key with matching kid not found in IdP configuration',
  IDP_JWKS_PATH_MISSING: 'JWKS mode requires a non-empty jwksPath',
  IDP_JWKS_URI_INVALID: 'JWKS URI is invalid or not allowed',
  IDP_JWKS_READ_FAILED: 'JWKS file could not be read',
  IDP_JWKS_FETCH_FAILED: 'JWKS URI fetch failed',
  IDP_JWKS_INVALID: 'JWKS document is invalid',
  IDP_JWKS_KEY_NOT_FOUND: 'No matching kid key found in JWKS document',
  IDP_JWKS_ALGORITHM_MISMATCH: 'JWT alg does not match JWKS key alg',
  IDP_ALGORITHM_NOT_ALLOWED: 'Token algorithm does not match any configured key algorithm',
  IDP_SIGNATURE_INVALID: 'IdP token signature verification failed',
  IDP_ISSUER_MISMATCH: 'Token issuer does not match configured issuer',
  IDP_AUDIENCE_MISMATCH: 'Token audience does not match any configured audience',
  IDP_EXPIRED: 'IdP token has expired',
  IDP_NOT_YET_VALID: 'IdP token is not yet valid (nbf claim in future)',
  IDP_SUBJECT_MISSING: 'Required subject claim missing in token',
  IDP_CLAIM_MAPPING_INVALID: 'Configured claim mapping targets missing or invalid JWT claim',
  IDP_NOT_CONFIGURED: 'IdP configuration not present in policy',
  IDP_CONFIG_INVALID: 'IdP configuration validation failed',
};
