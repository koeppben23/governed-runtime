/**
 * @module actor
 * @description Resolve operator identity for audit attribution (P27/P33/P34/P35a).
 *
 * Resolution priority (P35a three-tier model):
 * 1. FLOWGUARD_ACTOR_TOKEN_PATH + valid IdP token + identityProvider config -> source: 'oidc', assurance: 'idp_verified' (P35a)
 * 2. FLOWGUARD_ACTOR_CLAIMS_PATH + valid claim -> source: 'claim', assurance: 'claim_validated'
 * 3. FLOWGUARD_ACTOR_ID -> source: 'env', assurance: 'best_effort'
 * 4. git config user.name -> source: 'git', assurance: 'best_effort'
 * 5. Fallback -> source: 'unknown', assurance: 'best_effort'
 *
 * P35a: IdP verification via static keys in policy.identityProvider.
 * If identityProvider is configured and TOKEN_PATH is set, JWT is verified against static keys.
 * If identityProviderMode is 'required', session creation fails when verification fails.
 *
 * P34: Source and assurance are orthogonal. A given source always produces a fixed
 * assurance tier. The source tells WHERE, assurance tells HOW STRONG.
 *
 * P33: Verified actor claims via FLOWGUARD_ACTOR_CLAIMS_PATH.
 * If the path is configured but the claim is invalid/expired/missing, fail closed.
 * Only when path is NOT configured, fall back to env/git/unknown.
 *
 * FLOWGUARD_ACTOR_ID is an operator-provided identifier, not a verified login claim.
 * FLOWGUARD_ACTOR_EMAIL without ACTOR_ID falls through to git / unknown.
 *
 * Resolved once at hydrate time, immutable for the session lifecycle.
 * Changing FLOWGUARD_ACTOR_* or git config after hydrate does not affect
 * the current session. Re-run /hydrate to resolve a new actor.
 *
 * P35a design: docs/actor-assurance-architecture.md
 */

import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ActorInfo } from '../audit/types.js';
import { gitUserEmail, gitUserName } from './git.js';
import { IdpError } from '../identity/errors.js';
import { resolveIdpToken, isIdpConfigured } from '../identity/index.js';
import type { IdpConfig } from '../identity/types.js';

/**
 * Actor claim schema (P33/P34).
 * A validated local claim file. P34: maps to source='claim', assurance='claim_validated'.
 */
const ActorClaimSchema = z.object({
  schemaVersion: z.literal('v1'),
  actorId: z.string().min(1),
  actorEmail: z.string().optional().nullable(),
  actorDisplayName: z.string().optional().nullable(),
  issuer: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type ActorClaim = z.infer<typeof ActorClaimSchema>;

/**
 * Actor claim resolution errors (P33).
 */
export class ActorClaimError extends Error {
  constructor(
    public readonly code:
      | 'ACTOR_CLAIM_MISSING'
      | 'ACTOR_CLAIM_UNREADABLE'
      | 'ACTOR_CLAIM_INVALID'
      | 'ACTOR_CLAIM_EXPIRED'
      | 'ACTOR_CLAIM_PATH_EMPTY',
    message: string,
  ) {
    super(message);
    this.name = 'ActorClaimError';
  }
}

export class ActorIdentityError extends Error {
  constructor(
    public readonly code:
      | 'ACTOR_IDENTITY_UNAVAILABLE'
      | 'ACTOR_IDP_MODE_REQUIRED'
      | 'ACTOR_IDP_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ActorIdentityError';
  }
}

/**
 * Resolve actor identity from a verified claim file.
 *
 * P33/P34: If FLOWGUARD_ACTOR_CLAIMS_PATH is set, read and validate the claim.
 * Fail closed: any invalid/expired/missing claim throws ActorClaimError.
 * Maps to ActorInfo with source='claim', assurance='claim_validated'.
 *
 * @param claimsPath - Absolute path to the actor claim JSON file.
 * @returns Validated ActorClaim.
 * @throws ActorClaimError if claim is missing, unreadable, invalid, or expired.
 */
export async function resolveActorFromClaim(claimsPath: string): Promise<ActorClaim> {
  // Check file exists and is readable
  let fileContent: string;
  try {
    fileContent = await fs.readFile(claimsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ActorClaimError('ACTOR_CLAIM_MISSING', `Actor claim file not found: ${claimsPath}`);
    }
    throw new ActorClaimError(
      'ACTOR_CLAIM_UNREADABLE',
      `Cannot read actor claim file: ${claimsPath}`,
    );
  }

  // Parse JSON
  let claim: unknown;
  try {
    claim = JSON.parse(fileContent);
  } catch {
    throw new ActorClaimError('ACTOR_CLAIM_INVALID', 'Actor claim is not valid JSON');
  }

  // Validate schema
  const parseResult = ActorClaimSchema.safeParse(claim);
  if (!parseResult.success) {
    throw new ActorClaimError(
      'ACTOR_CLAIM_INVALID',
      `Actor claim schema validation failed: ${parseResult.error.message}`,
    );
  }

  const validClaim = parseResult.data;

  // Validate temporal constraints (strict - no tolerance)
  const now = new Date();
  const issuedAt = new Date(validClaim.issuedAt);
  const expiresAt = new Date(validClaim.expiresAt);

  if (issuedAt > now) {
    throw new ActorClaimError(
      'ACTOR_CLAIM_INVALID',
      `Actor claim issuedAt is in the future: ${validClaim.issuedAt}`,
    );
  }

  if (expiresAt <= now) {
    throw new ActorClaimError(
      'ACTOR_CLAIM_EXPIRED',
      `Actor claim expired at: ${validClaim.expiresAt}`,
    );
  }

  return validClaim;
}

export interface ResolveActorOptions {
  idpConfig?: IdpConfig | null;
  idpMode?: 'optional' | 'required';
}

/**
 * Resolve actor identity from IdP token, claim file, environment, or git config.
 *
 * P35a Priority (stronger mechanism wins):
 * 1. identityProvider configured + FLOWGUARD_ACTOR_TOKEN_PATH + valid JWT -> idp_verified
 *    (fail-closed if mode='required' and verification fails)
 * 2. FLOWGUARD_ACTOR_CLAIMS_PATH configured + valid claim -> claim_validated
 *    (fail-closed if path is set but claim is invalid/missing/expired)
 * 3. FLOWGUARD_ACTOR_ID -> best_effort
 * 4. git config -> best_effort
 * 5. fallback -> best_effort
 *
 * @param worktree - Git worktree path for git config lookup.
 * @param options - Optional IdP configuration and mode.
 * @returns Resolved ActorInfo with optional verificationMeta for idp_verified actors.
 * @throws ActorIdentityError when IdP mode is 'required' but verification fails.
 * @throws ActorClaimError when claim path is configured but invalid.
 */
export async function resolveActor(
  worktree: string,
  options?: ResolveActorOptions,
): Promise<ActorInfo> {
  const { idpConfig, idpMode = 'optional' } = options ?? {};

  const tokenPath = process.env.FLOWGUARD_ACTOR_TOKEN_PATH;
  if (isIdpConfigured(idpConfig)) {
    if (!tokenPath) {
      if (idpMode === 'required') {
        throw new ActorIdentityError(
          'ACTOR_IDP_MODE_REQUIRED',
          'IdP mode is required but FLOWGUARD_ACTOR_TOKEN_PATH is not set',
        );
      }
      // optional mode: fall through to next priority
    } else {
      try {
        const idpActor = await resolveIdpToken(tokenPath, idpConfig);
        return {
          id: idpActor.id,
          email: idpActor.email,
          displayName: idpActor.displayName,
          source: 'oidc',
          assurance: 'idp_verified',
          verificationMeta: idpActor.verificationMeta,
        };
      } catch (err) {
        if (err instanceof IdpError) {
          if (idpMode === 'required') {
            throw new ActorIdentityError(
              'ACTOR_IDP_MODE_REQUIRED',
              `IdP verification required but failed: ${err.code} - ${err.message}`,
            );
          }
        } else {
          throw err;
        }
      }
    }
  }

  const rawClaimsPath = process.env.FLOWGUARD_ACTOR_CLAIMS_PATH;
  if (rawClaimsPath !== undefined) {
    const claimsPath = rawClaimsPath.trim();
    if (!claimsPath) {
      throw new ActorClaimError(
        'ACTOR_CLAIM_PATH_EMPTY',
        'FLOWGUARD_ACTOR_CLAIMS_PATH is empty or whitespace only',
      );
    }
    const claim = await resolveActorFromClaim(claimsPath);
    return {
      id: claim.actorId,
      email: claim.actorEmail ?? null,
      displayName: (claim.actorDisplayName ?? null) as string | null,
      source: 'claim',
      assurance: 'claim_validated',
    };
  }

  const envId = process.env.FLOWGUARD_ACTOR_ID?.trim();
  if (envId) {
    const envEmail = process.env.FLOWGUARD_ACTOR_EMAIL?.trim() || null;
    const envDisplayName = process.env.FLOWGUARD_ACTOR_DISPLAY_NAME?.trim() || null;
    return {
      id: envId,
      email: envEmail,
      displayName: envDisplayName,
      source: 'env',
      assurance: 'best_effort',
    };
  }

  const gitName = await gitUserName(worktree);
  if (gitName) {
    const gitEmail = await gitUserEmail(worktree);
    return {
      id: gitName,
      email: gitEmail,
      displayName: null,
      source: 'git',
      assurance: 'best_effort',
    };
  }

  return {
    id: 'unknown',
    email: null,
    displayName: null,
    source: 'unknown',
    assurance: 'best_effort',
  };
}
