# Enterprise Readiness and Threat Model

This document provides a consolidated control narrative for enterprise and regulated reviews.
It describes what FlowGuard protects, what it does not protect, trust boundaries, regulated
guarantees, threat mitigations, and residual risks.

Status: Pilot-ready for regulated engineering teams; not yet a complete enterprise IAM, GRC,
or full policy-control-plane platform.

---

## 1) System Boundary

FlowGuard governs OpenCode workflow behavior inside a local workspace/session.

FlowGuard does:

- Enforce deterministic phase/command admissibility and fail-closed blocking.
- Persist canonical session state and evaluate evidence gates.
- Emit hash-chained audit events and verify archive integrity.
- Enforce regulated clean-completion semantics for archive verification.

FlowGuard does not:

- Authenticate users or provide enterprise IAM (OIDC/SAML/RBAC).
- Own source control permissions, branch protections, or deployment policy.
- Replace CI/CD systems, code review processes, or release approvals.
- Provide a hosted control plane for centralized policy administration.

For implementation-level boundary details, see `docs/trust-boundaries.md` and
`docs/security-hardening.md`.

---

## 2) Trust Model

### Trusted (runtime authority)

- Canonical `session-state.json` as runtime SSOT.
- FlowGuard runtime code and state machine evaluation.
- Active policy snapshot persisted at hydrate time.
- Local filesystem availability and integrity assumptions.

### Not Inherently Trusted (advisory or untrusted inputs)

- Derived/generated artifacts as independent authority.
- External documentation and Knowledge Packs.
- Model memory and free-form prompt content.
- Unvalidated local configuration changes.

Authority precedence remains:

1. Universal mandates
2. Slash command contract
3. Repository evidence and SSOT
4. Knowledge Packs (advisory)
5. Generic model memory

---

## 3) Regulated Guarantees

In regulated mode, FlowGuard currently guarantees:

- Strict audit-chain verification in regulated archive verification paths.
- Clean regulated completion requires archive creation and archive verification success.
- Regulated archive lifecycle is explicit (`pending` -> `created` -> `verified` or `failed`).
- Terminal `session_completed` lifecycle event is written before archive generation so the
  archive contains completion evidence.
- Audit events include source-labeled actor attribution (`env`, `git`, `claim`, `oidc`, `unknown`).
- Actor assurance tiers: `best_effort` (env/git/unknown), `claim_validated` (verified claim file), `idp_verified` (IdP token verification via static keys, local pinned JWKS, or remote JWKS with TTL cache and fail-closed refresh).

These guarantees are scoped to current runtime behavior and local execution model.

---

## 4) Tamper Evidence vs Tamper Prevention

FlowGuard provides tamper evidence, not tamper prevention.

- Hash-chained audit events and archive verification are designed to detect integrity breaks.
- They do not make local files immutable against privileged local modification.
- `actorInfo` supports attribution context and source transparency, but is not
  cryptographic authentication.

Practical implication: integrity violations can be detected during verification, but local
admin/root compromise can still alter files.

---

## 5) Threats and Mitigations

| Threat                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                               | Residual risk                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt attempts to bypass command/phase rails         | Command admissibility + phase gates + fail-closed blockers                                                                                                                                                                                                                                                                                                               | Incorrect or malicious prompt content is still possible; blocked execution does not sanitize user intent                                                           |
| Audit trail tampering                                 | Hash chain + regulated strict verification (`verifyChain({ strict: true })`)                                                                                                                                                                                                                                                                                             | Local privileged attacker can still alter files; detection depends on verification being run                                                                       |
| Archive missing/invalid on regulated clean completion | Regulated completion path requires synchronous archive creation and `verifyArchive()` success                                                                                                                                                                                                                                                                            | Aborted sessions are explicitly outside clean-completion guarantee                                                                                                 |
| Fake or weak human identity claims                    | Best-effort `actorInfo` for `env`/`git`/`unknown`; optional actor claims via `FLOWGUARD_ACTOR_CLAIMS_PATH` with `claim_validated` assurance; optional IdP verification via `identityProvider` (`static`, `jwksPath`, or `jwksUri`) yields `idp_verified`; regulated approvals enforce `minimumActorAssuranceForApproval` threshold (`claim_validated` or `idp_verified`) | Remote JWKS uses TTL cache with fail-closed refresh and no stale-on-error/last-known-good fallback in P35b2; compromised local environments remain a residual risk |
| Policy weakening through local config drift           | Central minimum policy via `FLOWGUARD_POLICY_PATH`; explicit weaker-than-central is blocked; repo/default weaker-than-central is raised with visible reason                                                                                                                                                                                                              | Central source is file-based only (no remote control plane, no fleet governance)                                                                                   |

---

## 6) Residual Risks

- No built-in enterprise IAM integration (OIDC, SAML, LDAP-backed auth, RBAC).
- Central policy is local-bundle based (`FLOWGUARD_POLICY_PATH`) only; no remote admin control plane.
- Local filesystem or host compromise can alter state, audit, or archive artifacts.
- Verified actor claims are local trusted-claim files, not enterprise IAM/IdP authentication.
- Archive and audit controls are evidence-oriented, not immutable external storage.
- FlowGuard does not replace CI controls, human review, change-management, or deployment
  approvals.

---

## 7) Procurement Readiness

FlowGuard is currently suitable for pilot and controlled regulated engineering workflows that
need deterministic execution behavior, evidence gating, and tamper-evident audit/archive checks.

FlowGuard is not yet positioned as a complete enterprise IAM/GRC/policy-administration platform.

---

## 8) Deferred Scope

Baseline central policy distribution is delivered as explicit local bundle loading via
`FLOWGUARD_POLICY_PATH`. Full enterprise control-plane capabilities (remote distribution,
delegated admin, policy signing infrastructure, fleet governance) are still deferred.

No additional guarantees beyond implemented runtime behavior are implied here.

---

## 9) Related Documents

- `docs/security-hardening.md` - hardening guidance and regulated verification details
- `docs/trust-boundaries.md` - component/system trust boundary mapping
- `PRODUCT_IDENTITY.md` - product capabilities and limitations overview
- `CHANGELOG.md` - release-by-release control changes
