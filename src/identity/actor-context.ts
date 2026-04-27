/**
 * @module identity/actor-context
 * @description Policy-aware actor resolution for FlowGuard decision paths.
 *
 * Wraps resolveActor with IdP/policy context from the session's policy snapshot.
 * Centralizes the actor resolution pattern so Hydrate and Decision use the same
 * code path with full policy context.
 *
 * @version v1
 */

import { resolveActor, ActorIdentityError } from '../adapters/actor.js';
import type { ActorInfo } from '../audit/types.js';
import type { FlowGuardPolicy } from '../config/policy.js';

/**
 * Resolve actor identity with full IdP/policy context.
 *
 * Uses identityProvider and identityProviderMode from the session's
 * resolved FlowGuardPolicy to enable idp_verified actor resolution.
 *
 * @param worktree - Git worktree path for git config lookup.
 * @param policy - Resolved FlowGuardPolicy from session snapshot.
 * @returns ActorInfo with appropriate assurance tier.
 */
export async function resolveActorForPolicy(
  worktree: string,
  policy: FlowGuardPolicy,
): Promise<ActorInfo> {
  // Guard: required IdP mode without configured IdP is a configuration error
  if (policy.identityProviderMode === 'required' && !policy.identityProvider) {
    throw new ActorIdentityError(
      'ACTOR_IDP_CONFIG_REQUIRED',
      'identityProviderMode is required but no identityProvider is configured',
    );
  }

  return resolveActor(worktree, {
    idpConfig: policy.identityProvider,
    idpMode: policy.identityProviderMode,
  });
}
