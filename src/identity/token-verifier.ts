/**
 * @module identity/token-verifier
 * @description JWT token verifier for P35a/P35b1 key verification.
 *
 * Design: TokenVerifier is separated from KeyResolver for future extensibility.
 * P35a/P35b1: JwtStaticTokenVerifier uses KeyResolver with Node.js crypto.
 * Future (P35b2/c): Could use remote JWKS and OIDC discovery resolvers.
 */

import * as crypto from 'node:crypto';
import { IdpError, type IdpErrorCode } from './errors.js';
import type { IdpConfig, VerifiedToken } from './types.js';
import type { KeyResolver } from './key-resolver.js';

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
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
    const signatureB64 = parts[2] ?? '';

    const header = this.decodeJson<JwtHeader>(headerB64, 'IDP_TOKEN_HEADER_INVALID');
    this.validateHeader(header);

    const payload = this.decodeJson<JwtPayload>(payloadB64, 'IDP_TOKEN_INVALID');
    this.validateTemporal(payload);

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

    this.verifySignature(headerB64, payloadB64, signatureB64, resolvedKey.key);

    this.validateIssuer(payload);
    this.validateAudience(payload);

    const claimMapping = this.config.claimMapping;
    const subject = this.extractClaim(payload, claimMapping.subjectClaim);
    if (!subject) {
      throw new IdpError('IDP_SUBJECT_MISSING', 'Required subject claim missing in token');
    }

    const email = this.extractClaimOrNull(payload, claimMapping.emailClaim);
    const displayName = this.extractClaimOrNull(payload, claimMapping.nameClaim);

    const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];

    const exp = payload.exp ?? Math.floor(Date.now() / 1000) + 3600;

    return {
      subject,
      email,
      displayName,
      issuer: typeof payload.iss === 'string' ? payload.iss : this.config.issuer,
      audience,
      issuedAt: payload.iat ? new Date(payload.iat * 1000) : null,
      notBefore: payload.nbf ? new Date(payload.nbf * 1000) : null,
      expiresAt: new Date(exp * 1000),
      keyId: kid,
      algorithm: header.alg,
      rawClaims: payload,
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

    if (payload.exp !== undefined && payload.exp < now) {
      throw new IdpError(
        'IDP_EXPIRED',
        `IdP token expired at ${new Date(payload.exp * 1000).toISOString()}`,
      );
    }

    if (payload.nbf !== undefined && payload.nbf > now) {
      throw new IdpError(
        'IDP_NOT_YET_VALID',
        `IdP token not yet valid until ${new Date(payload.nbf * 1000).toISOString()}`,
      );
    }
  }

  private verifySignature(
    headerB64: string,
    payloadB64: string,
    signatureB64: string,
    key: crypto.KeyObject,
  ): void {
    try {
      const signatureBytes = Buffer.from(signatureB64, 'base64url');
      const data = Buffer.from(`${headerB64}.${payloadB64}`);

      const algorithm = resolvedAlgorithm(key);

      const verify = crypto.verify(algorithm, data, key, signatureBytes);
      if (!verify) {
        throw new IdpError('IDP_SIGNATURE_INVALID', 'IdP token signature verification failed');
      }
    } catch (err) {
      if (err instanceof IdpError) throw err;
      throw new IdpError(
        'IDP_SIGNATURE_INVALID',
        `Signature verification error: ${(err as Error).message}`,
      );
    }
  }

  private validateIssuer(payload: JwtPayload): void {
    const tokenIssuer = payload.iss;
    if (tokenIssuer !== this.config.issuer) {
      throw new IdpError(
        'IDP_ISSUER_MISMATCH',
        `Token issuer '${tokenIssuer}' does not match configured issuer '${this.config.issuer}'`,
      );
    }
  }

  private validateAudience(payload: JwtPayload): void {
    const tokenAudience = payload.aud;
    const configuredAudience = this.config.audience;

    const tokenAudienceList = Array.isArray(tokenAudience)
      ? tokenAudience
      : tokenAudience
        ? [tokenAudience]
        : [];
    const hasMatch = tokenAudienceList.some((aud) => configuredAudience.includes(aud));

    if (!hasMatch) {
      throw new IdpError(
        'IDP_AUDIENCE_MISMATCH',
        `Token audience '${tokenAudienceList.join(', ')}' does not match any configured audience '${configuredAudience.join(', ')}'`,
      );
    }
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

function resolvedAlgorithm(key: crypto.KeyObject): string {
  const keyType = key.asymmetricKeyType;
  if (keyType === 'rsa' || keyType === 'rsa-pss') {
    return 'RSA-SHA256';
  }
  return 'ECDSA-SHA256';
}
