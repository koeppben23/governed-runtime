# Actor Assurance Architecture

**Design Version:** 1.2
**Status:** Implemented — Three-tier assurance model with policy-snapshot authority, schema-hardened identity provider validation, and decision-path enforcement.
**Last Updated:** 2026-04-23
**Owner:** FlowGuard Core
**Audience:** Enterprise engineers, product, security review

---

## 1) Problem Statement

FlowGuard The original provides an actor identity bridge via `FLOWGUARD_ACTOR_CLAIMS_PATH`. The current `assurance` model is binary (`best_effort | verified`) and tied directly to the claim source.

For Bank/DATEV/Adorsys pilots, this is insufficient:

- `best_effort` covers `env`/`git`/`unknown` but has no tier for validated local claims.
- `verified` conflates "validated local claim file" with "IdP-verified identity", creating semantic ambiguity.
- The policy flag `requireVerifiedActorsForApproval` is a boolean — too blunt for enterprise-grade assurance requirements.
- No clear contract for future IdP/OIDC integration.

This document defines the canonical target model for actor assurance in FlowGuard.

---

## 2) Design Goals

- **Canonical Assurance Tiers** — three defined levels with clear semantics and ordering.
- **Source/Assurance Separation** — `source` tells WHERE the identity came from; `assurance` tells HOW STRONG it is. These are orthogonal.
- **Generalized Policy Contract** — policy gates specify minimum required assurance level, not a boolean.
- **Fail-Closed Semantics** — ambiguous or unverifiable identity always blocks regulated approvals.
- **Migration Path** — The original semantics map cleanly into the target model.
- **Extensible** — future tiers (`service_verified`, `ci_verified`) fit the model without breaking changes.

## 2a) Closure Scope

### Implemented (product truth)

- static keys (`identityProvider.mode: 'static'`)
- local pinned JWKS (`identityProvider.mode: 'jwks'` + `jwksPath`)
- remote JWKS (`identityProvider.mode: 'jwks'` + HTTPS `jwksUri`) with TTL cache and fail-closed refresh

### Not in scope

- OIDC discovery
- last-known-good or stale-on-error JWKS fallback
- RBAC/group-based authorization mapping

---

## 3) Assurance Tiers (Canonical)

The following tiers are defined in ascending order of assurance strength:

### 3.1 `best_effort`

**Semantics:** Operator-provided or derived identifier with no cryptographic verification.

**Sources that produce this tier:**

- `FLOWGUARD_ACTOR_ID` environment variable (`source: 'env'`)
- `git config user.name` (`source: 'git'`)
- No identity available (`source: 'unknown'`)

**When it applies:** The operator self-identifies. No third party has validated this identity. Suitable for solo and internal team workflows. NOT suitable for regulated approval gates that require verified human identity.

**Policy behavior:** Regulated approval gates that require `claim_validated` or `idp_verified` will reject `best_effort` actors.

### 3.2 `claim_validated`

**Semantics:** Identity validated from a structured local claim file. Schema validated, temporal bounds checked (issuedAt ≤ now < expiresAt). No cryptographic signature verification.

**Sources that produce this tier:**

- `FLOWGUARD_ACTOR_CLAIMS_PATH` with a valid claim JSON (`source: 'claim'`)

**When it applies:** An external system (HR system, identity provisioning tool, IdM) has written a structured claim to a local file. FlowGuard validates the schema and expiry. The claim is trusted as a locally-provisioned, policy-enforced identity artifact.

**Policy behavior:** Satisfies regulated approval gates that require `claim_validated` or lower. Does NOT satisfy gates that require `idp_verified`.

**The original mapping:** Current `verified` (from valid claim file) maps to `claim_validated`.

### 3.3 `idp_verified`

**Semantics:** Identity validated through a cryptographic proof from an external Identity Provider (IdP). JWT/JWKS verification is cryptographically enforced. Issuer, audience, and expiry are validated. The identity originates from a trusted IdP key authority configured in policy.

**Sources that produce this tier:**

- `policy.identityProvider` with static keys (`mode: 'static'`)
- `policy.identityProvider` with local pinned JWKS (`mode: 'jwks'` + `jwksPath`)
- `policy.identityProvider` with remote JWKS (`mode: 'jwks'` + HTTPS `jwksUri`)
- `FLOWGUARD_ACTOR_TOKEN_PATH` with a readable JWT token file

**When it applies:** The actor's identity has been established by a trusted IdP and the token/assertion has been cryptographically verified by FlowGuard. This is the strongest assurance level for human actor identity.

**Policy behavior:** Satisfies all approval gates. This is the target for Bank/DATEV regulated workflows.

---

## 4) Source/Assurance Matrix

| source    | best_effort | claim_validated | idp_verified |
| --------- | :---------: | :-------------: | :----------: |
| `env`     |      ✓      |                 |              |
| `git`     |      ✓      |                 |              |
| `unknown` |      ✓      |                 |              |
| `claim`   |             |        ✓        |              |
| `oidc`    |             |                 |      ✓       |

**Rule:** `source` and `assurance` are always consistent. A given `source` always produces a fixed `assurance` tier. The table above is the authoritative mapping.

---

## 5) ActorIdentity Contract

This is the canonical actor identity structure used throughout FlowGuard.

```typescript
interface ActorIdentity {
  /** Stable identifier for audit attribution. */
  id: string | null;
  /** Optional email for reviewer attribution. */
  email: string | null;
  /** Optional display name. */
  displayName: string | null;
  /**
   * WHERE the identity originates from.
   * - `env`: FLOWGUARD_ACTOR_ID environment variable
   * - `git`: git config user.name
   * - `claim`: Validated local claim file (FLOWGUARD_ACTOR_CLAIMS_PATH)
   * - `oidc`: Cryptographically verified IdP token (IdP token verification)
   * - `unknown`: No identity available
   */
  source: 'env' | 'git' | 'claim' | 'oidc' | 'unknown';
  /**
   * HOW STRONG the identity verification is.
   * - `best_effort`: operator-provided, no third-party verification
   * - `claim_validated`: schema + expiry validated, locally provisioned
   * - `idp_verified`: cryptographic proof from trusted IdP
   */
  assurance: 'best_effort' | 'claim_validated' | 'idp_verified';
}
```

---

## 6) DecisionIdentity Contract

For regulated approval attribution (four-eyes, review decisions).

```typescript
interface DecisionIdentity {
  actorId: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  actorSource: ActorIdentity['source'];
  actorAssurance: ActorIdentity['assurance'];
}
```

---

## 7) Policy Contract

### 7.1 `minimumActorAssuranceForApproval`

Replaces `requireVerifiedActorsForApproval: boolean`.

```typescript
type MinimumAssurance = 'best_effort' | 'claim_validated' | 'idp_verified';

interface FlowGuardPolicy {
  // ... existing fields ...
  /**
   * Minimum required actor assurance for regulated approval decisions.
   *
   * - 'best_effort'     → any actor may approve (default for Team, backward-compat with The original)
   * - 'claim_validated' → only claim-validated actors may approve (The original "verified" equivalent)
   * - 'idp_verified'    → only IdP-verified actors may approve (implemented)
   *
   * Applies at User Gates in regulated mode. Actors below the threshold are blocked
   * with reason `ACTOR_ASSURANCE_INSUFFICIENT`.
   *
   * For The original migration:
   *   requireVerifiedActorsForApproval: true  → minimumActorAssuranceForApproval: 'claim_validated'
   *   requireVerifiedActorsForApproval: false → minimumActorAssuranceForApproval: 'best_effort'
   */
  minimumActorAssuranceForApproval?: MinimumAssurance;
}
```

### 7.2 Approval Gate Evaluation

At a regulated User Gate, the rail evaluates:

```
if (decisionIdentity.actorAssurance < policy.minimumActorAssuranceForApproval) {
  block with reason: 'ACTOR_ASSURANCE_INSUFFICIENT'
  detail: `Current assurance '${decisionIdentity.actorAssurance}' is below required '${policy.minimumActorAssuranceForApproval}'`
}
```

**Assurance ordering:** `best_effort` < `claim_validated` < `idp_verified`

---

## 8) Fail-Closed Semantics

All three tiers share a common fail-closed guarantee:

| Scenario                                   | Behavior                                                        |
| ------------------------------------------ | --------------------------------------------------------------- |
| Claim file missing when path is configured | **BLOCK** — `ACTOR_CLAIM_MISSING`                               |
| Claim file unreadable                      | **BLOCK** — `ACTOR_CLAIM_UNREADABLE`                            |
| Claim JSON invalid                         | **BLOCK** — `ACTOR_CLAIM_INVALID`                               |
| Claim expired                              | **BLOCK** — `ACTOR_CLAIM_EXPIRED`                               |
| Claim issuedAt in future                   | **BLOCK** — `ACTOR_CLAIM_INVALID`                               |
| No IdP config, no claim, no env/git        | `unknown` + `best_effort` — allowed at non-regulated gates only |
| Assurance below policy threshold           | **BLOCK** — `ACTOR_ASSURANCE_INSUFFICIENT`                      |
| IdP token invalid/missing                  | **BLOCK** — `IDP_IDENTITY_INVALID`                              |

There is **no fallback** from higher to lower tiers when the configured path is active. If `FLOWGUARD_ACTOR_CLAIMS_PATH` is set, its failure is fatal. Only absence of the path triggers fallback to env/git.

---

## 9) Resolver/Validator/Mapper Separation

Runtime responsibility is split across three layers:

### 9.1 Resolver (adapters/actor.ts)

Loads raw identity data from environment, filesystem, or future IdP.

**Responsibilities:**

- Enumerate `FLOWGUARD_ACTOR_ID`, `FLOWGUARD_ACTOR_EMAIL`
- Enumerate `FLOWGUARD_ACTOR_CLAIMS_PATH` → load raw JSON
- Read `policy.identityProvider` from the active policy snapshot
- Enumerate `FLOWGUARD_ACTOR_TOKEN_PATH` → load JWT token file
- Enumerate `git config user.name/email`
- Return raw data + source to validator

**Failures:** Resolver throws typed errors (`ActorClaimError`, future `IdPConfigError`). Failures propagate — no fallback to best-effort within the same tier.

### 9.2 Validator

Checks schema, temporal bounds, and cryptographic signatures.

**Responsibilities:**

- Parse and validate claim schema (Zod)
- Validate temporal constraints (issuedAt ≤ now < expiresAt)
- Verify JWT signature, check issuer/audience
- Return validated claim data or throw

### 9.3 Mapper

Maps validated/verified identity data to canonical `ActorIdentity` structure.

**Responsibilities:**

- Map claim fields → canonical `ActorIdentity`
- Map IdP token claims → canonical `ActorIdentity`
- Apply display name / email normalization
- Add `source` and `assurance` tier

### 9.4 Policy Gate

Evaluates whether the actor's `assurance` tier satisfies the policy requirement.

**Responsibilities:**

- Compare `actorInfo.assurance` against `policy.minimumActorAssuranceForApproval`
- Return blocked outcome with `ACTOR_ASSURANCE_INSUFFICIENT` if below threshold

### 9.5 Session Freeze

`ActorIdentity` is frozen at hydrate time and remains immutable for the session lifecycle.

**Responsibilities:**

- Call Resolver/Validator/Mapper chain at hydrate time
- Persist canonical `ActorIdentity` to session state
- Re-hydrate on session reload (verify consistency, reject if IdP token expired mid-session)

---

## 10) The original → Current Migration

### 10.1 Schema Changes

| The original                                | Current                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `actorInfo.source: 'claim'`                 | `actorInfo.source: 'claim'` (unchanged)                                                  |
| `actorAssurance: 'verified'`                | `actorAssurance: 'claim_validated'`                                                      |
| `actorAssurance: 'best_effort'`             | `actorAssurance: 'best_effort'` (unchanged)                                              |
| `requireVerifiedActorsForApproval: boolean` | `minimumActorAssuranceForApproval: 'best_effort' \| 'claim_validated' \| 'idp_verified'` |

### 10.2 Migration Mapping

| Original Config                                     | Current Behavior                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `FLOWGUARD_ACTOR_CLAIMS_PATH` not set               | `source: 'env'/'git'/'unknown'`, `assurance: 'best_effort'` — unchanged |
| `FLOWGUARD_ACTOR_CLAIMS_PATH` set, valid claim      | `source: 'claim'`, `assurance: 'claim_validated'` (was `verified`)      |
| `requireVerifiedActorsForApproval: false` (default) | `minimumActorAssuranceForApproval: 'best_effort'`                       |
| `requireVerifiedActorsForApproval: true`            | `minimumActorAssuranceForApproval: 'claim_validated'`                   |

### 10.3 Backward Compatibility

- Original sessions loaded after upgrade: `actorAssurance: 'verified'` is accepted and treated as `claim_validated` (coercive parse in Zod schema).
- Policy field: `requireVerifiedActorsForApproval` is ignored if `minimumActorAssuranceForApproval` is set. If only the old field is present and the new is absent, the old field is translated at resolution time.
- This provides a safe migration window without breaking existing sessions or configs.

---

## 11) Future Tiers (Out of Scope)

### 11.1 `service_verified`

Service account identity from signed service token (e.g., CI pipeline token). Not a human actor, but a controlled workload identity. Future consideration.

### 11.2 `ci_verified`

CI pipeline identity (GitHub Actions OIDC, GitLab CI token). Automated approval in `team-ci` mode could use this tier. Future consideration.

These tiers do NOT change the current three-tier model. They extend it.

---

## 12) Implementation Roadmap

### Architecture & Design (This Document)

**Deliverable:** This document. Normative decisions on tiers, source/assurance separation, policy contract, state contract, and fail-closed semantics.

### Claim-Validated Cleanup

**Status:** Complete

**Deliverable:**

- ✅ Extend `ActorIdentitySchema` with `idp_verified` enum value
- ✅ Rename `verified` → `claim_validated` in Zod schemas and state
- ✅ Add `displayName` field to `ActorIdentity` and `DecisionIdentity`
- ✅ Replace `requireVerifiedActorsForApproval` with `minimumActorAssuranceForApproval` in policy schema
- ✅ Update `review-decision.ts` rail to use new threshold comparison
- ✅ Update `resolveActor` and `resolveActorFromClaim` JSDoc with new semantics
- ✅ Update `security-hardening.md`, `enterprise-readiness.md`, `PRODUCT_IDENTITY.md`, `PRODUCT_ONE_PAGER.md`
- ✅ Add coercion for `verified` → `claim_validated` in Zod parse for backward compatibility
- ✅ Add test coverage for new threshold logic

### Pinned Local JWKS

**Status:** Implemented

**Deliverable:**

- ✅ Discriminated IdP config authority: `mode: 'static' | 'jwks'`
- ✅ `jwks` mode with pinned local `jwksPath` (no network)
- ✅ Kid-based key resolution from JWKS (`no first-key fallback`)
- ✅ Explicit JWKS error taxonomy (`IDP_JWKS_*`, `IDP_TOKEN_KID_MISSING`)
- ✅ Fail-closed semantics preserved for `identityProviderMode: 'required'`
- ✅ Typed IdP config frozen in policy snapshot (no `unknown` pass-through)

### Remote JWKS Fetch

**Status:** Implemented

**Deliverable:**

- ✅ `jwksUri` support (HTTPS only)
- ✅ TTL cache (`cacheTtlSeconds`, default 300)
- ✅ Fail-closed refresh behavior (no stale-on-error fallback after expiry)
- ✅ Typed JWKS fetch/URI errors (`IDP_JWKS_URI_INVALID`, `IDP_JWKS_FETCH_FAILED`)

### OIDC Discovery (Future)

**Status:** Not started

**Deliverable:** OIDC discovery endpoint for dynamic IdP configuration.

### IdP-Verified Actors (Static Keys)

**Status:** Implemented

**Deliverable:**

- ✅ JWT/JOSE verification via Node.js crypto (RS256, ES256)
- ✅ Static JWK/PEM key binding in policy configuration
- ✅ `FLOWGUARD_ACTOR_TOKEN_PATH` for JWT token file
- ✅ IdP validator (signature, issuer, audience, expiry, nbf)
- ✅ `source: 'oidc'`, `assurance: 'idp_verified'`
- ✅ `ActorVerificationMeta` for IdP provenance
- ✅ `identityProviderMode: 'optional' | 'required'` for session creation control
- ✅ Fail-closed behavior with typed error codes

### Files Added/Extended

- `src/identity/types.ts` — discriminated IdP schema (`static` vs `jwks`) and JWKS schemas
- `src/identity/key-resolver.ts` — `JwksFileKeyResolver` (local/pinned JWKS)
- `src/identity/token-verifier.ts` — explicit `IDP_TOKEN_KID_MISSING`, resolver alg handoff
- `src/identity/errors.ts` — JWKS-specific fail-closed error taxonomy
- `src/state/evidence.ts` — typed `identityProvider` in `PolicySnapshotSchema`

**Files:**

- `src/identity/` — IdP module (errors, types, key-resolver, token-verifier, index)
- `src/adapters/actor.ts` — IdP resolver integrated
- `src/state/evidence.ts` — `ActorVerificationMeta` schema
- `src/config/policy.ts` — `identityProvider`, `identityProviderMode` fields
- `src/config/flowguard-config.ts` — IdP config surface

---

## 13) Non-Goals

- FlowGuard does NOT become an IdP or authentication provider.
- FlowGuard does NOT manage key rotation, token revocation, or nonce/state for IdP flows.
- FlowGuard does NOT integrate with LDAP, SAML, or Kerberos directly — it trusts IdP-issued tokens.
- `best_effort` does NOT become a valid tier for regulated approval without explicit policy override.

---

## 14) Related Documents

- `src/adapters/actor.ts` — IdP-aware actor resolver with IdP integration
- `src/identity/` — IdP identity module
- `src/state/evidence.ts` — `DecisionIdentity` schema with `ActorVerificationMeta`
- `src/config/policy.ts` — policy schema with typed `identityProvider` and `identityProviderMode`
- `src/rails/review-decision.ts` — regulated approval gate with `ACTOR_ASSURANCE_INSUFFICIENT`
- `docs/security-hardening.md` — actor identity hardening guidance
- `docs/enterprise-readiness.md` — threat model and regulated guarantees
- `PRODUCT_IDENTITY.md` — product capabilities
