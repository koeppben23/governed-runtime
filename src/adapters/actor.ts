/**
 * @module actor
 * @description Resolve operator identity for audit attribution (P27/P33).
 *
 * Resolution priority:
 * 1. FLOWGUARD_ACTOR_CLAIMS_PATH present + valid claim -> source: 'claim', assurance: 'verified'
 * 2. FLOWGUARD_ACTOR_ID present -> source: 'env'
 * 3. git config user.name present -> source: 'git'
 * 4. Fallback -> { id: 'unknown', email: null, source: 'unknown' }
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
 */

import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ActorInfo } from '../audit/types.js';
import { gitUserEmail, gitUserName } from './git.js';

/**
 * Actor claim schema (P33).
 */
const ActorClaimSchema = z.object({
  schemaVersion: z.literal('v1'),
  actorId: z.string().min(1),
  actorEmail: z.string().optional().nullable(),
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

/**
 * Resolve actor identity from a verified claim file.
 *
 * P33: If FLOWGUARD_ACTOR_CLAIMS_PATH is set, read and validate the claim.
 * Fail closed: any invalid/expired/missing claim throws ActorClaimError.
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

/**
 * Resolve actor identity from environment variables, claim file, or git config.
 *
 * Priority (P33):
 * 1. FLOWGUARD_ACTOR_CLAIMS_PATH + valid claim -> 'claim' + 'verified'
 * 2. FLOWGUARD_ACTOR_ID -> 'env' + 'best_effort'
 * 3. git config -> 'git' + 'best_effort'
 * 4. fallback -> 'unknown' + 'best_effort'
 *
 * @param worktree - Git worktree path for git config lookup.
 * @returns Resolved ActorInfo; throws ActorClaimError when claim path is configured but invalid.
 */
export async function resolveActor(worktree: string): Promise<ActorInfo> {
  // Priority 1: Verified claim (P33)
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
      source: 'claim',
    };
  }

  // Priority 2: Environment variable
  const envId = process.env.FLOWGUARD_ACTOR_ID?.trim();
  if (envId) {
    const envEmail = process.env.FLOWGUARD_ACTOR_EMAIL?.trim() || null;
    return { id: envId, email: envEmail, source: 'env' };
  }

  // Priority 3: Git config (non-fatal)
  const gitName = await gitUserName(worktree);
  if (gitName) {
    const gitEmail = await gitUserEmail(worktree);
    return { id: gitName, email: gitEmail, source: 'git' };
  }

  // Priority 4: Unknown fallback
  return { id: 'unknown', email: null, source: 'unknown' };
}
