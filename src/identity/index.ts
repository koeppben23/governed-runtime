/**
 * @module identity
 * @description IdP identity resolver for P35a (static keys, no JWKS, no Remote Fetch).
 *
 * Entry point for IdP token verification.
 * Combines StaticKeyResolver + JwtStaticTokenVerifier.
 *
 * Usage:
 * ```typescript
 * import { resolveIdpToken, type IdpConfig } from '../identity/index.js';
 *
 * const idpConfig: IdpConfig = { ... };
 * const token = await fs.readFile(tokenPath, 'utf-8');
 * const verified = await resolveIdpToken(token, idpConfig);
 * ```
 */

import * as fs from 'node:fs/promises';
import { IdpError } from './errors.js';
import { StaticKeyResolver, type KeyResolver } from './key-resolver.js';
import { JwtStaticTokenVerifier, type TokenVerifier } from './token-verifier.js';
import type { IdpConfig, ResolvedIdpActor } from './types.js';

export { IdpError, type IdpErrorCode } from './errors.js';
export {
  IdpConfigSchema,
  IdentityProviderModeSchema,
  SigningKeySchema,
  ClaimMappingSchema,
  type IdpConfig,
  type IdentityProviderMode,
  type SigningKey,
  type ClaimMapping,
  type VerifiedToken,
  type ActorVerificationMeta,
  type ResolvedIdpActor,
  type KeyAlgorithm,
  type KeyKind,
} from './types.js';

export interface IdpResolutionResult {
  kind: 'resolved';
  actor: ResolvedIdpActor;
}

export type IdpResolutionOutcome = IdpResolutionResult | { kind: 'not_configured' };

/**
 * Resolve IdP token using static key verification.
 *
 * @param tokenPath - Path to JWT token file (FLOWGUARD_ACTOR_TOKEN_PATH).
 * @param config - IdP configuration from policy.
 * @returns Resolved IdP actor with verification metadata.
 * @throws IdpError on verification failure (fail-closed).
 */
export async function resolveIdpToken(
  tokenPath: string,
  config: IdpConfig,
): Promise<ResolvedIdpActor> {
  let token: string;
  try {
    token = (await fs.readFile(tokenPath, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IdpError('IDP_TOKEN_MISSING', `IdP token file not found at path: ${tokenPath}`);
    }
    throw new IdpError(
      'IDP_TOKEN_MISSING',
      `Cannot read IdP token file: ${(err as Error).message}`,
    );
  }

  if (!token) {
    throw new IdpError('IDP_TOKEN_MISSING', 'IdP token file is empty');
  }

  const keyResolver: KeyResolver = new StaticKeyResolver(config.signingKeys);
  const tokenVerifier: TokenVerifier = new JwtStaticTokenVerifier(config, keyResolver);

  const verifiedToken = await tokenVerifier.verify(token);

  return {
    id: verifiedToken.subject,
    email: verifiedToken.email,
    displayName: verifiedToken.displayName,
    source: 'oidc',
    assurance: 'idp_verified',
    verificationMeta: {
      issuer: verifiedToken.issuer,
      audience: verifiedToken.audience,
      keyId: verifiedToken.keyId,
      algorithm: verifiedToken.algorithm,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * Check if IdP configuration is present and active.
 *
 * @param config - IdP configuration (nullable).
 * @returns true if IdP is configured with at least one signing key.
 */
export function isIdpConfigured(config: IdpConfig | undefined | null): config is IdpConfig {
  return config !== undefined && config !== null && config.signingKeys.length > 0;
}
