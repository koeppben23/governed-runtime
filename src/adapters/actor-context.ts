/**
 * @module adapters/actor-context
 * @description Policy-aware actor resolution for FlowGuard decision paths.
 *
 * Wraps resolveActor with IdP/policy context from the session's policy snapshot.
 * Centralizes the actor resolution pattern so Hydrate and Decision use the same
 * code path with full policy context.
 *
 * Moved from identity/ to adapters/ (P4b) because this is glue code bridging
 * adapters/actor and config/policy — not identity-layer logic.
 *
 * @version v2
 */

import { resolveActor, ActorIdentityError } from './actor.js';
import { isIdpConfigured } from '../identity/index.js';
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
  // Guard: required IdP mode without a valid identityProvider is a configuration error.
  // Uses isIdpConfigured() which validates via IdpConfigSchema.safeParse().
  if (policy.identityProviderMode === 'required') {
    const config = policy.identityProvider;
    if (!isIdpConfigured(config)) {
      throw new ActorIdentityError(
        'ACTOR_IDP_CONFIG_REQUIRED',
        'identityProviderMode is required but no valid identityProvider is configured',
      );
    }
  }

  return resolveActor(worktree, {
    idpConfig: policy.identityProvider,
    idpMode: policy.identityProviderMode,
  });
}
