# Security Hardening

This document provides recommendations for securing FlowGuard deployments.

---

## Overview

FlowGuard is designed to run locally with no network access. Security hardening focuses on host-level controls and operational practices.

---

## Delivery Scope

| Category                 | Description                  | Example                                  |
| ------------------------ | ---------------------------- | ---------------------------------------- |
| **Technically Enforced** | Guarantees by implementation | Fail-closed, hash chain, phase gates     |
| **Currently Delivered**  | Available in current release | CLI, state validation, audit             |
| **Not Covered**          | Customer implements          | OS hardening, encryption, access control |

---

## Host-Level Hardening

### Filesystem Permissions

| Path                    | Recommended Permissions | Notes                  |
| ----------------------- | ----------------------- | ---------------------- |
| `~/.config/opencode/`   | 700 (owner only)        | Contains session state |
| `.opencode/`            | 700 (owner only)        | Project-scoped install |
| `.opencode/audit.jsonl` | 600 (owner read/write)  | Audit trail            |
| `.opencode/state.json`  | 600 (owner read/write)  | Session state          |

**Customer Responsibility:**

- Set appropriate filesystem permissions
- Audit permissions regularly
- Restrict access to authorized users only

### Installation Directory

| Path                    | Purpose             | Hardening               |
| ----------------------- | ------------------- | ----------------------- |
| `~/.config/opencode/`   | Global installation | User-owned, not shared  |
| `vendor/`               | Vendored artifacts  | Read-only after install |
| `flowguard-mandates.md` | Managed mandates    | Content-digested        |

---

## Operational Security

### Session Isolation

| Practice                      | Recommendation                              |
| ----------------------------- | ------------------------------------------- |
| **One session per workspace** | Avoid concurrent sessions in same directory |
| **Clean completion**          | Archive and close sessions when done        |
| **State protection**          | Don't modify `.opencode/` files directly    |

### Access Control

| Resource                | Control                             |
| ----------------------- | ----------------------------------- |
| **FlowGuard execution** | OS user permissions                 |
| **Session state**       | Filesystem permissions              |
| **Audit trail**         | Filesystem permissions              |
| **Archives**            | Archive permissions, storage access |

---

## Network Security

### Air-Gapped Deployment

| Step | Action                                                |
| ---- | ----------------------------------------------------- | --- |
| 1    | Operator downloads artifact from release source       |
| 2    | Verify checksum                                       |
| 3    | Transfer to air-gapped environment                    |
| 4    | Install via `flowguard install --core-tarball <path>` |     |

**Customer Responsibility:**

- Verify network isolation
- Configure firewall rules
- Monitor for unauthorized connections

### No Outbound Connections

FlowGuard runs offline by default. If remote JWKS is configured (`identityProvider.mode = jwks` + `jwksUri`), FlowGuard performs bounded HTTPS fetches for JWKS refresh; fetch failures are fail-closed in `identityProviderMode: required`.

**Verification:**

```bash
# Monitor for network activity during FlowGuard execution
# (flowguard should make no network calls after install)
```

---

## Data Security

### Encryption at Rest

FlowGuard stores session data as plaintext JSON. If encryption is required:

**Customer Responsibility:**

- Enable filesystem-level encryption (LUKS, BitLocker, etc.)
- Use encrypted storage volumes
- Manage encryption keys separately

### Backup Security

| Asset                      | Security Measure                    |
| -------------------------- | ----------------------------------- |
| **Session archives**       | Encrypt before off-site storage     |
| **Installation artifacts** | Store in secure artifact repository |
| **Configuration**          | Version control with access control |

---

## Operational Practices

### Secure Development

| Practice              | Recommendation                                     |
| --------------------- | -------------------------------------------------- |
| **Minimize exposure** | Don't share `.opencode/` directories               |
| **Clean up**          | Archive completed sessions, remove temporary files |
| **Audit access**      | Log who accesses session directories               |

### Incident Response

| Phase             | Action                                          |
| ----------------- | ----------------------------------------------- |
| **Detect**        | Monitor for unauthorized access to `.opencode/` |
| **Respond**       | Isolate affected sessions, revoke access        |
| **Recover**       | Restore from verified archive                   |
| **Post-incident** | Review access logs, update permissions          |

---

## Strict Audit Chain Verification

The `verifyChain` function supports a strict verification mode via `{ strict: true }`.

**Default (legacy-tolerant):** Events without hash chain fields (`prevHash`, `chainHash`) are
skipped and counted in `skippedCount`. The chain remains valid. This mode supports migration
and diagnostic workflows with mixed legacy/chained trails.

**Strict mode:** Events without hash chain fields are treated as integrity failures.
`skippedCount > 0` makes the chain invalid with reason `LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`.
Regulated verification paths must use strict mode to ensure no unchained events are silently
tolerated in new sessions.

| Mode    | Legacy events    | Chain break | Result                                         |
| ------- | ---------------- | ----------- | ---------------------------------------------- |
| Default | Skipped, counted | Detected    | `valid: true` (if no chain break)              |
| Strict  | Rejected         | Detected    | `valid: false`, reason identifies failure type |

Failure reason priority: `CHAIN_BREAK` > `LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`.
A tampered chain is a harder failure than unchained events.

Legacy audit tolerance exists only for migration/diagnostic workflows and is reported
explicitly via `skippedCount` in the verification result.

### Archive Verification Call-Site

Archive verification (`verifyArchive`) is the first production call-site for strict chain
verification. When the archive manifest declares `policyMode: "regulated"`, the verifier
passes `{ strict: true }` to `verifyChain`. Unknown or non-regulated policy modes remain
legacy-tolerant for backward compatibility.

On failure, the verifier emits an `audit_chain_invalid` finding with error severity. The
finding message includes the chain verification reason (`CHAIN_BREAK` or
`LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`) and event counts for diagnosis.

| Manifest policyMode | Strict? | Legacy events tolerated? |
| ------------------- | ------- | ------------------------ |
| `regulated`         | Yes     | No — error finding       |
| `team`, `solo`, etc | No      | Yes — backward-compat    |
| `unknown`           | No      | Yes — backward-compat    |

### Regulated Archive Completion Guarantee

Regulated clean completion (`EVIDENCE_REVIEW → APPROVE → COMPLETE`) now requires archive
creation **and** verification success. The decision tool owns the synchronous archive
lifecycle for regulated sessions:

1. State set to `archiveStatus: 'pending'`
2. `session_completed` audit event appended to trail (before archive)
3. `archiveSession()` called synchronously (not fire-and-forget)
4. `verifyArchive()` validates archive integrity
5. State updated to `archiveStatus: 'verified'` or `archiveStatus: 'failed'`

The `session_completed` event is emitted **before** `archiveSession()` so the archive
contains the terminal lifecycle event. The audit plugin detects `archiveStatus` on the
persisted state and skips its own `session_completed` emission and auto-archive to avoid
duplication. The plugin's chain hash cache is invalidated for regulated completions to
prevent chain forks.

A regulated session with `phase: 'COMPLETE'` and `archiveStatus !== 'verified'` (without
`error`) is NOT a clean regulated completion — it is a degraded terminal state.

**Checksum sidecar hardening:** In regulated mode, `.sha256` sidecar write failure is
fatal (`ARCHIVE_FAILED`). Non-regulated mode remains tolerant.

**Scope exclusions:** Aborted sessions (`error.code === 'ABORTED'`) do not trigger the
regulated archive lifecycle — abort is an emergency escape with no archive guarantee.
Non-regulated sessions use the existing fire-and-forget auto-archive in the audit plugin.

---

## Actor Identity

FlowGuard resolves actor identity at hydrate time for audit attribution. The `actorInfo` field carries both `source` (WHERE the identity came from) and `assurance` (HOW STRONG the verification is).

### Resolution Priority

| Source    | Assurance         | Description                                                                               |
| --------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `env`     | `best_effort`     | `FLOWGUARD_ACTOR_ID` env var — operator-provided, not verified                            |
| `git`     | `best_effort`     | `git config user.name` — git-derived, not verified                                        |
| `claim`   | `claim_validated` | `FLOWGUARD_ACTOR_CLAIMS_PATH` — schema + expiry validated                                 |
| `oidc`    | `idp_verified`    | IdP token via static keys, local pinned JWKS, or remote JWKS — cryptographically verified |
| `unknown` | `best_effort`     | No identity available                                                                     |

### IdP Trust Modes (P35)

- `mode: 'static'` with pinned signing keys (`jwk` or `pem`)
- `mode: 'jwks'` with pinned local `jwksPath`
- `mode: 'jwks'` with HTTPS `jwksUri` + `cacheTtlSeconds` (TTL cache)

P35 explicitly excludes OIDC discovery and stale/last-known-good JWKS fallback.

### Policy Gate

In regulated mode, `minimumActorAssuranceForApproval` specifies the minimum required tier:

- `best_effort` — any actor may approve
- `claim_validated` — only claim-validated actors may approve (P33 `verified` equivalent)
- `idp_verified` — only IdP-verified actors may approve

Actors below the threshold are blocked with reason `ACTOR_ASSURANCE_INSUFFICIENT`.

### Fail-Closed Identity Behavior

- `identityProviderMode: 'required'` blocks session hydration on IdP failures (no implicit fallback).
- `identityProviderMode: 'optional'` degrades only on typed IdP errors; claim/env/git/unknown resolution remains bounded by priority rules.
- Remote JWKS refresh failures after TTL expiry fail closed (`IDP_JWKS_FETCH_FAILED`).

Representative typed fail-closed IdP errors:

- `IDP_TOKEN_MISSING`, `IDP_TOKEN_INVALID`, `IDP_TOKEN_HEADER_INVALID`, `IDP_TOKEN_KID_MISSING`
- `IDP_SIGNATURE_INVALID`, `IDP_ISSUER_MISMATCH`, `IDP_AUDIENCE_MISMATCH`, `IDP_EXPIRED`, `IDP_NOT_YET_VALID`
- `IDP_JWKS_INVALID`, `IDP_JWKS_URI_INVALID`, `IDP_JWKS_FETCH_FAILED`, `IDP_JWKS_KEY_NOT_FOUND`, `IDP_JWKS_ALGORITHM_MISMATCH`

### Design Constraints

- **Not authentication.** `FLOWGUARD_ACTOR_ID` is an operator-provided identifier, not a
  verified login claim. No OIDC discovery, SAML, LDAP, or RBAC.
- **Resolved once.** Actor identity is resolved at `/hydrate` and immutable for the session
  lifecycle. Changing `FLOWGUARD_ACTOR_*` or git config after hydrate does not affect the
  current session. Re-run `/hydrate` to resolve a new actor.
- **Session ID != Actor.** `sessionId` remains the workflow/session identity.
  `actorInfo` is a separate, optional field for human attribution.
- **Hash-safe.** When absent, `actorInfo` is omitted from the event object — `JSON.stringify`
  excludes `undefined` keys. Chain hashes for pre-existing events remain identical.
- **Selective attribution.** `actorInfo` appears on human-influenced events (lifecycle,
  tool_call, decision). Machine-only events (transition, error) never carry `actorInfo`.

---

## Compliance Mapping

| Control               | Implementation                  |
| --------------------- | ------------------------------- |
| **Access control**    | OS permissions, filesystem ACLs |
| **Audit logging**     | FlowGuard audit trail           |
| **Data protection**   | Customer-managed encryption     |
| **Network isolation** | Customer-managed firewall       |

---

_FlowGuard Version: 1.2.0-rc.1-rc.1_
_Last Updated: 2026-04-23_
