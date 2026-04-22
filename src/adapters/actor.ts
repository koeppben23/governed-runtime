/**
 * @module actor
 * @description Resolve operator identity for audit attribution (P27).
 *
 * Resolution priority:
 * 1. FLOWGUARD_ACTOR_ID present -> source: 'env'
 * 2. git config user.name present -> source: 'git'
 * 3. Fallback -> { id: 'unknown', email: null, source: 'unknown' }
 *
 * FLOWGUARD_ACTOR_ID is an operator-provided identifier, not a verified login claim.
 * FLOWGUARD_ACTOR_EMAIL without ACTOR_ID falls through to git / unknown.
 *
 * Resolved once at hydrate time, immutable for the session lifecycle.
 * Changing FLOWGUARD_ACTOR_* or git config after hydrate does not affect
 * the current session. Re-run /hydrate to resolve a new actor.
 */

import type { ActorInfo } from '../audit/types';
import { gitUserEmail, gitUserName } from './git';

/**
 * Resolve actor identity from environment variables or git config.
 *
 * @param worktree - Git worktree path for git config lookup.
 * @returns Resolved ActorInfo — never throws.
 */
export async function resolveActor(worktree: string): Promise<ActorInfo> {
  // Priority 1: Environment variable
  const envId = process.env.FLOWGUARD_ACTOR_ID?.trim();
  if (envId) {
    const envEmail = process.env.FLOWGUARD_ACTOR_EMAIL?.trim() || null;
    return { id: envId, email: envEmail, source: 'env' };
  }

  // Priority 2: Git config (non-fatal)
  const gitName = await gitUserName(worktree);
  if (gitName) {
    const gitEmail = await gitUserEmail(worktree);
    return { id: gitName, email: gitEmail, source: 'git' };
  }

  // Priority 3: Unknown fallback
  return { id: 'unknown', email: null, source: 'unknown' };
}
