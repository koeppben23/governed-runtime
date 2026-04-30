/**
 * @module identity/token-verifier
 * @description JWT token verifier for P35a/P35b1 key verification.
 *
 * Design: TokenVerifier is separated from KeyResolver for future extensibility.
 * P35a/P35b1: JwtStaticTokenVerifier uses KeyResolver with jose JWT verification.
 * Future (P35b2/c): Could use remote JWKS and OIDC discovery resolvers.
 */

import { jwtVerify, type JWTHeaderParameters, type JWTPayload } from 'jose';
import {
  JOSEError,
  JWTClaimValidationFailed,
  JWTExpired,
  JWSSignatureVerificationFailed,
} from 'jose/errors';
import type { KeyObject } from 'node:crypto';
import { IdpError, type IdpErrorCode } from './errors.js';
import type { IdpConfig, VerifiedToken } from './types.js';
import type { KeyResolver } from './key-resolver.js';

/** Default token TTL when exp claim is absent (1 hour). */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

interface JwtHeader extends JWTHeaderParameters {
  alg: string;
}

interface JwtPayload extends JWTPayload {
  [key: string]: unknown;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export class JwtStaticTokenVerifier implements TokenVerifier {
  constructor(
    private readonly config: IdpConfig,
    private readonly keyResolver: KeyResolver,
  ) {}

  async verify(token: string): Promise<VerifiedToken> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new IdpError(
        'IDP_TOKEN_INVALID',
        'IdP token is not valid JWT format: expected 3 parts',
      );
    }

    const headerB64 = parts[0] ?? '';
    const payloadB64 = parts[1] ?? '';

    const header = this.decodeJson<JwtHeader>(headerB64, 'IDP_TOKEN_HEADER_INVALID');
    this.validateHeader(header);
    this.decodeJson<JwtPayload>(payloadB64, 'IDP_TOKEN_INVALID');

    const kid = header.kid;
    if (!kid) {
      throw new IdpError('IDP_TOKEN_KID_MISSING', 'IdP token header missing kid');
    }

    const resolvedKey = this.keyResolver.resolveKey(kid, header.alg);

    if (header.alg !== resolvedKey.algorithm) {
      throw new IdpError(
        'IDP_ALGORITHM_NOT_ALLOWED',
        `Token algorithm '${header.alg}' does not match key algorithm '${resolvedKey.algorithm}'`,
      );
    }

    const verifiedPayload = await this.verifyJwt(token, resolvedKey.key, resolvedKey.algorithm);
    // Preserve FlowGuard's historic boundary semantics after jose verification.
    this.validateTemporal(verifiedPayload);

    const claimMapping = this.config.claimMapping;
    const subject = this.extractClaim(verifiedPayload, claimMapping.subjectClaim);
    if (!subject) {
      throw new IdpError('IDP_SUBJECT_MISSING', 'Required subject claim missing in token');
    }

    const email = this.extractClaimOrNull(verifiedPayload, claimMapping.emailClaim);
    const displayName = this.extractClaimOrNull(verifiedPayload, claimMapping.nameClaim);

    const audience = Array.isArray(verifiedPayload.aud)
      ? verifiedPayload.aud
      : verifiedPayload.aud
        ? [verifiedPayload.aud]
        : [];

    const exp =
      typeof verifiedPayload.exp === 'number'
        ? verifiedPayload.exp
        : Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;

    return {
      subject,
      email,
      displayName,
      issuer: typeof verifiedPayload.iss === 'string' ? verifiedPayload.iss : this.config.issuer,
      audience,
      issuedAt:
        typeof verifiedPayload.iat === 'number' ? new Date(verifiedPayload.iat * 1000) : null,
      notBefore:
        typeof verifiedPayload.nbf === 'number' ? new Date(verifiedPayload.nbf * 1000) : null,
      expiresAt: new Date(exp * 1000),
      keyId: kid,
      algorithm: header.alg,
      rawClaims: verifiedPayload as Record<string, unknown>,
    };
  }

  private decodeJson<T>(b64: string, errorCode: IdpErrorCode): T {
    try {
      const json = Buffer.from(b64, 'base64url').toString('utf-8');
      return JSON.parse(json) as T;
    } catch {
      throw new IdpError(errorCode, `Failed to decode base64url segment: ${b64}`);
    }
  }

  private validateHeader(header: JwtHeader): void {
    if (!header.alg) {
      throw new IdpError('IDP_TOKEN_HEADER_INVALID', 'IdP token header missing alg');
    }
  }

  private validateTemporal(payload: JwtPayload): void {
    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp === 'number' && payload.exp < now) {
      throw new IdpError(
        'IDP_EXPIRED',
        `IdP token expired at ${new Date(payload.exp * 1000).toISOString()}`,
      );
    }

    if (typeof payload.nbf === 'number' && payload.nbf > now) {
      throw new IdpError(
        'IDP_NOT_YET_VALID',
        `IdP token not yet valid until ${new Date(payload.nbf * 1000).toISOString()}`,
      );
    }
  }

  private async verifyJwt(
    token: string,
    key: CryptoKey | KeyObject | Uint8Array,
    algorithm: string,
  ): Promise<JwtPayload> {
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: [algorithm],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: 1,
      });
      return verified.payload as JwtPayload;
    } catch (err) {
      if (err instanceof IdpError) throw err;
      throw this.mapJoseError(err);
    }
  }

  private mapJoseError(err: unknown): IdpError {
    if (err instanceof JWTExpired) {
      return new IdpError('IDP_EXPIRED', `IdP token expired: ${err.message}`);
    }

    if (err instanceof JWTClaimValidationFailed) {
      if (err.claim === 'iss') {
        return new IdpError('IDP_ISSUER_MISMATCH', `Token issuer mismatch: ${err.message}`);
      }
      if (err.claim === 'aud') {
        return new IdpError('IDP_AUDIENCE_MISMATCH', `Token audience mismatch: ${err.message}`);
      }
      if (err.claim === 'nbf') {
        return new IdpError('IDP_NOT_YET_VALID', `IdP token not yet valid: ${err.message}`);
      }
      return new IdpError('IDP_TOKEN_INVALID', `Token claim validation failed: ${err.message}`);
    }

    if (err instanceof JWSSignatureVerificationFailed) {
      return new IdpError('IDP_SIGNATURE_INVALID', 'IdP token signature verification failed');
    }

    if (err instanceof JOSEError) {
      if (err.code === 'ERR_JOSE_ALG_NOT_ALLOWED') {
        return new IdpError(
          'IDP_ALGORITHM_NOT_ALLOWED',
          `Token algorithm not allowed: ${err.message}`,
        );
      }
      return new IdpError('IDP_TOKEN_INVALID', `Token verification failed: ${err.message}`);
    }

    return new IdpError(
      'IDP_SIGNATURE_INVALID',
      `Signature verification error: ${(err as Error).message}`,
    );
  }

  private extractClaim(payload: JwtPayload, claimName: string): string | null {
    const value = payload[claimName];
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    return value.trim();
  }

  private extractClaimOrNull(payload: JwtPayload, claimName: string): string | null {
    const value = payload[claimName];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return null;
  }
}
