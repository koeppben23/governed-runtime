/**
 * @module integration/identity
 * @description Host-context identity assertion resolution for /hydrate.
 *
 * WP2 contract:
 * - OIDC-first via trusted host assertion payload.
 * - Local fallback only for explicitly allowed modes.
 * - Fail-closed for disallowed/invalid identity contexts.
 *
 * Runtime note:
 * FlowGuard consumes host assertions; it does not perform OIDC protocol flows.
 */

import { IdentityAssertion } from '../state/evidence';
import type { IdentityAssertion as IdentityAssertionType, PolicyMode } from '../state/evidence';
import type { FlowGuardConfig } from '../config/flowguard-config';
import type { ToolContext } from './tools/helpers';

export interface IdentityResolution {
  readonly assertion: IdentityAssertionType;
  readonly source: 'host_assertion' | 'local_fallback';
}

export interface IdentityResolutionBlocked {
  readonly code: string;
  readonly vars: Record<string, string>;
}

type ResolutionResult =
  | { readonly ok: true; readonly value: IdentityResolution }
  | { readonly ok: false; readonly blocked: IdentityResolutionBlocked };

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function extractHostAssertion(context: ToolContext): unknown {
  const contextRecord = asRecord(context);
  if (!contextRecord) return undefined;

  const direct = contextRecord['identityAssertion'];
  if (direct !== undefined) return direct;

  const identity = contextRecord['identity'];
  if (identity !== undefined) return identity;

  const hostContext = asRecord(contextRecord['hostContext']);
  if (hostContext && hostContext['identityAssertion'] !== undefined) {
    return hostContext['identityAssertion'];
  }

  const claims = contextRecord['claims'];
  if (claims !== undefined) return claims;

  return undefined;
}

function validateOidcIssuer(
  assertion: IdentityAssertionType,
  config: FlowGuardConfig,
): ResolutionResult {
  if (assertion.identitySource !== 'oidc') {
    return {
      ok: true,
      value: {
        assertion,
        source: 'host_assertion',
      },
    };
  }

  if (!assertion.issuer || !assertion.issuer.trim()) {
    return {
      ok: false,
      blocked: {
        code: 'UNTRUSTED_IDENTITY_ISSUER',
        vars: { message: 'OIDC assertion missing issuer claim' },
      },
    };
  }

  const allowlist = config.identity.allowedIssuers;
  if (allowlist.length > 0 && !allowlist.includes(assertion.issuer)) {
    return {
      ok: false,
      blocked: {
        code: 'UNTRUSTED_IDENTITY_ISSUER',
        vars: { message: `issuer not allowlisted: ${assertion.issuer}` },
      },
    };
  }

  return {
    ok: true,
    value: {
      assertion,
      source: 'host_assertion',
    },
  };
}

function validateFreshness(
  assertion: IdentityAssertionType,
  config: FlowGuardConfig,
  nowIso: string,
): boolean {
  const assertedAt = Date.parse(assertion.assertedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(assertedAt) || Number.isNaN(now)) return false;
  if (assertedAt > now) return false;
  const ageMs = now - assertedAt;
  return ageMs <= config.identity.assertionMaxAgeSeconds * 1000;
}

function validateSessionBinding(
  assertion: IdentityAssertionType,
  context: ToolContext,
  config: FlowGuardConfig,
): boolean {
  if (!config.identity.requireSessionBinding) return true;
  return assertion.sessionBindingId === context.sessionID;
}

function isLocalFallbackAllowed(config: FlowGuardConfig, effectiveMode: PolicyMode): boolean {
  return config.identity.allowLocalFallbackModes.includes(effectiveMode);
}

function buildLocalFallbackAssertion(context: ToolContext, nowIso: string): IdentityAssertionType {
  const subjectId = context.agent?.trim() ? context.agent : context.sessionID;
  return {
    subjectId,
    identitySource: 'local',
    assertedAt: nowIso,
    assuranceLevel: 'basic',
    sessionBindingId: context.sessionID,
  };
}

/**
 * Resolve identity assertion for hydrate.
 *
 * Rules:
 * - Host assertion is preferred when present.
 * - Assertion must pass schema, issuer, freshness, and session-binding checks.
 * - Local fallback is allowed only when effective mode is in allowLocalFallbackModes.
 * - Otherwise fail-closed with identity reason code.
 */
export function resolveHydrateIdentity(
  context: ToolContext,
  config: FlowGuardConfig,
  effectiveMode: PolicyMode,
  nowIso: string,
): ResolutionResult {
  const rawAssertion = extractHostAssertion(context);

  if (rawAssertion !== undefined) {
    const parsed = IdentityAssertion.safeParse(rawAssertion);
    if (!parsed.success) {
      return {
        ok: false,
        blocked: {
          code: 'IDENTITY_UNVERIFIED',
          vars: {
            message: parsed.error.issues.map((i) => i.message).join('; ') || 'invalid assertion',
          },
        },
      };
    }

    const assertion = parsed.data;

    if (!validateFreshness(assertion, config, nowIso)) {
      return {
        ok: false,
        blocked: {
          code: 'IDENTITY_UNVERIFIED',
          vars: { message: 'identity assertion is stale or from the future' },
        },
      };
    }

    if (!validateSessionBinding(assertion, context, config)) {
      return {
        ok: false,
        blocked: {
          code: 'IDENTITY_UNVERIFIED',
          vars: { message: 'session binding mismatch or missing sessionBindingId' },
        },
      };
    }

    const issuerCheck = validateOidcIssuer(assertion, config);
    if (!issuerCheck.ok) return issuerCheck;

    if (assertion.identitySource === 'local' && !isLocalFallbackAllowed(config, effectiveMode)) {
      return {
        ok: false,
        blocked: {
          code: 'IDENTITY_SOURCE_NOT_ALLOWED',
          vars: {
            source: 'local',
            mode: effectiveMode,
            message: `local identity source not allowed for mode ${effectiveMode}`,
          },
        },
      };
    }

    return {
      ok: true,
      value: {
        assertion,
        source: 'host_assertion',
      },
    };
  }

  if (isLocalFallbackAllowed(config, effectiveMode)) {
    return {
      ok: true,
      value: {
        assertion: buildLocalFallbackAssertion(context, nowIso),
        source: 'local_fallback',
      },
    };
  }

  return {
    ok: false,
    blocked: {
      code: 'IDENTITY_UNVERIFIED',
      vars: {
        message: `no trusted host identity assertion provided for mode ${effectiveMode}`,
      },
    },
  };
}
