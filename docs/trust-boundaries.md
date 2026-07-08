# Trust Boundaries

This document is the canonical documentation authority for FlowGuard trust boundaries and the review contract for changes that touch state, policy, identity, audit, archive, review evidence, host transport, network access, filesystem persistence, or operational logging.

It does not redefine runtime authority. Runtime SSOT remains in the modules linked below. This document makes the boundary expectations reviewable and marks non-enforced claims as `NOT_VERIFIED`, residual risk, diagnostic only, or future work.

---

## Review Contract

Reviewers MUST check every relevant change against the boundary entries below.

Each boundary states:

- **Signed / integrity-covered** — data protected by a hash, schema, digest, signature, timestamp token, or validated binding.
- **Mutable / diagnostic** — data that may be rewritten, is operator-provided, or is diagnostic only.
- **Writer / authority** — the only layer or module that may make the decision or write the artifact.
- **Attacker model** — the boundary's assumed adversary.
- **Fail-closed expectation** — what must happen when validation, parsing, binding, persistence, or verification fails.
- **Required audit events** — audit evidence expected for the boundary.
- **Required operational logs** — diagnostic log points, level, and structured fields. Operational logs are diagnostic only and are not audit evidence.
- **Governing modules** — code authority links. The document references these authorities and MUST NOT duplicate their decision logic.
- **Known gaps / residual risk / NOT_VERIFIED** — limitations that must not be presented as implemented protection.

Operational logs use the logging SSOT in [`src/logging/logger.ts`](../src/logging/logger.ts). That module explicitly states that operational logs are diagnostic only and are not part of governance SSOT. Audit evidence remains separate in `audit.jsonl`, session state, review evidence, and archive artifacts.

---

## Delivery Scope

| Category                    | Description                                          | Example                                                                  |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| **Technically Enforced**    | Guarantees implemented by runtime authorities        | State schema validation, audit hash chain, phase gates                   |
| **Diagnostic Only**         | Signals for operators/reviewers, not evidence        | Structured logs, doctor diagnostics, presentation output                 |
| **Currently Delivered**     | Available in current release                         | CLI, state validation, audit, archive verification                       |
| **Optional**                | Enabled only by configuration or operator action     | Remote JWKS, `/review url=...`, TSA timestamp assurance, OTLP log export |
| **Not Covered**             | Intentionally outside FlowGuard runtime protection   | OS compromise prevention, network isolation, encryption                  |
| **Customer Responsibility** | External controls required for deployment assurances | Filesystem permissions, host sandboxing, backup controls                 |

---

## Trust Boundary Diagram

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                              HOST ENVIRONMENT                              │
│  OS / filesystem / network / host AI runtime are customer-managed trust     │
│  surfaces. FlowGuard validates what crosses into governed artifacts.        │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         FLOWGUARD BOUNDARY                           │  │
│  │                                                                      │  │
│  │  Pure authorities       Adapter substrate       Host/plugin edges    │  │
│  │  - state schema         - atomic writes         - tool/hook inputs   │  │
│  │  - phase topology       - audit append          - reviewer transport │  │
│  │  - policy snapshot      - archive build/verify  - operational logs   │  │
│  │                                                                      │  │
│  │  Audit/state/archive/review evidence are governance artifacts.        │  │
│  │  Operational logs are diagnostic only.                                │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Trust Levels

### FlowGuard Core

| Property               | Trust Level | Reason                                            |
| ---------------------- | ----------- | ------------------------------------------------- |
| **State Machine**      | Highest     | Pure, deterministic, no I/O                       |
| **Policy Snapshot**    | Highest     | Captured into session state and consumed by gates |
| **Review Evidence**    | Highest     | Schema-validated and obligation-bound             |
| **Audit Digest Rules** | Highest     | Canonical hash functions; no raw log authority    |

Technically enforced:

- Core decision modules do not perform network calls.
- Pure rails and machine logic must not log or perform side effects.
- Mutating writes validate against Zod schemas and fail closed on invalid state.

### Adapters

| Property             | Trust Level | Reason                                                                 |
| -------------------- | ----------- | ---------------------------------------------------------------------- |
| **Persistence**      | Medium      | Owns filesystem writes and locks                                       |
| **Workspace/Git**    | Medium      | Reads repository and external git state                                |
| **Network surfaces** | Medium      | Optional URL review, remote JWKS, local hook listener, OTLP log export |
| **Host integration** | Medium      | Translates host/runtime events into FlowGuard boundaries               |

Customer responsibility:

- Filesystem permissions and disk integrity.
- Host runtime installation integrity.
- Network/firewall controls for optional network-dependent features.

### CLI and Templates

| Property      | Trust Level | Reason                                              |
| ------------- | ----------- | --------------------------------------------------- |
| **Installer** | Medium      | Writes managed files and verifies package artifacts |
| **Doctor**    | Diagnostic  | Reports installation state; not governance evidence |
| **Templates** | Lower       | User-facing host configuration and instructions     |

CLI and presentation output must not be treated as the decision authority when state, audit, policy, or review evidence disagree.

---

## Boundary Crossings

The following sections are the review contract. Changes touching a boundary must preserve the listed authorities, failure modes, audit evidence, and logging separation.

### Session State And Policy Snapshot Boundary

| Field                                     | Contract                                                                                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | `session-state.json` is schema-validated before writes. Policy snapshot fields are persisted in state and consumed by gates. Archive verification later folds security-relevant state-derived metadata into the archive content digest. |
| Mutable / diagnostic                      | Tool output, `/status` projections, and presentation copy are mutable diagnostics. They are not state authority.                                                                                                                        |
| Writer / authority                        | State schema: [`src/state/schema.ts`](../src/state/schema.ts). Evidence schemas: [`src/state/evidence.ts`](../src/state/evidence.ts). Atomic state write path: [`src/adapters/persistence.ts`](../src/adapters/persistence.ts).         |
| Attacker model                            | Agent/operator tries to submit malformed state, downgrade policy, bypass a gate, or rely on stale presentation output. Local filesystem compromise remains outside FlowGuard's prevention boundary.                                     |
| Fail-closed expectation                   | Invalid JSON/schema, blocked risk gates, unresolved required evidence, or invalid policy resolution must block with explicit errors instead of silently defaulting to permissive behavior.                                              |
| Required audit events                     | Lifecycle, tool_call, transition, decision, and error events when state-changing tools run or fail.                                                                                                                                     |
| Required operational logs                 | `warn`/`error` around state persistence or policy degradation with fields such as `sessionId`, `phase`, `policyMode`, `reasonCode`, and `tool`. Operational logs are diagnostic only.                                                   |
| Known gaps / residual risk / NOT_VERIFIED | `session-state.json` is plaintext. OS-level file tampering by a user with write access is not prevented; detection depends on schema checks, audit/archive verification, and external controls.                                         |

### Filesystem Persistence Boundary

| Field                                     | Contract                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | State and report files are validated before write. Audit append recomputes chain fields under lock. Durable/atomic write paths reduce partial-write risk.                                                           |
| Mutable / diagnostic                      | Filesystem metadata, temporary files, lock files, and adapter logs are mutable substrate. They are not governance evidence by themselves.                                                                           |
| Writer / authority                        | Path and atomic write infrastructure: [`src/adapters/persistence.ts`](../src/adapters/persistence.ts). Audit append: [`src/adapters/persistence-audit.ts`](../src/adapters/persistence-audit.ts).                   |
| Attacker model                            | Concurrent writers, interrupted writes, malformed existing files, permission failures, antivirus/indexer races, or direct local file edits.                                                                         |
| Fail-closed expectation                   | Parse/schema/write/lock failures surface as typed persistence failures. Corrupt audit JSONL prevents appending new audit events until repaired.                                                                     |
| Required audit events                     | Successful mutating tool calls should have corresponding audit tool_call/transition/decision/lifecycle/error events. If audit persistence fails on strict paths, governance must block or surface explicit failure. |
| Required operational logs                 | `error` on atomic write or audit append failure with fields such as `filePath` or `sessionDir` and redacted `error`. Operational logs are diagnostic only.                                                          |
| Known gaps / residual risk / NOT_VERIFIED | Filesystem durability depends on OS/filesystem semantics. Directory fsync support is best-effort on some platforms. FlowGuard does not enforce disk encryption, ACLs, or malware protection.                        |

### Audit JSONL Hash-Chain Boundary

| Field                                     | Contract                                                                                                                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | `audit.jsonl` chained events include `prevHash`, `chainHash`, `auditFormatVersion`, and optional timestamp evidence. Chain hash uses canonical JSON over event content.                                                                       |
| Mutable / diagnostic                      | Operational logs and doctor/status output about audit are diagnostic only. Legacy/unparseable audit lines are not silently accepted for new append.                                                                                           |
| Writer / authority                        | Event factories and chain hash: [`src/audit/types.ts`](../src/audit/types.ts). Verification: [`src/audit/integrity.ts`](../src/audit/integrity.ts). Append path: [`src/adapters/persistence-audit.ts`](../src/adapters/persistence-audit.ts). |
| Attacker model                            | Local actor modifies, inserts, deletes, reorders, truncates, or corrupts audit events.                                                                                                                                                        |
| Fail-closed expectation                   | Strict verification rejects legacy/unverifiable events. Chain break, unsupported format, timestamp-required gaps, or malformed existing lines must surface explicitly.                                                                        |
| Required audit events                     | transition, tool_call, decision, lifecycle, and error events according to the state-changing boundary. Critical regulated events may carry timestamp evidence.                                                                                |
| Required operational logs                 | `error` for append failure and `warn`/`error` for verification failures with fields such as `sessionId`, `reasonCode`, `eventId`, `expectedChainHash`, and `actualChainHash` when available. Operational logs are diagnostic only.            |
| Known gaps / residual risk / NOT_VERIFIED | Hash chains are tamper-evident, not tamper-preventing. A local attacker with rewrite access can attempt full trail rewrite; external timestamp assurance is required for stronger regulated evidence.                                         |

### Archive Manifest And Content Digest Boundary

| Field                                     | Contract                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Archive manifest v2 folds sorted file digests plus security-relevant metadata into `contentDigest`: `schemaVersion`, `sessionId`, `fingerprint`, `policyMode`, `discoveryDigest`, `auditChainHead`, and `auditEventCount`.                  |
| Mutable / diagnostic                      | Manifest fields not covered by digest are not authority for strictness. `manifest.policyMode` is cross-checked against state-derived policy mode rather than trusted alone.                                                                 |
| Writer / authority                        | Content digest authority: [`src/archive/content-digest.ts`](../src/archive/content-digest.ts). Archive behavior is documented in [`docs/archive.md`](./archive.md).                                                                         |
| Attacker model                            | Archive payload mutation, file removal/addition, policy-mode flip, audit-tail truncation, checksum sidecar failure, or archive re-seal attempt.                                                                                             |
| Fail-closed expectation                   | Missing manifest, parse failure, file digest mismatch, content digest mismatch, policy mismatch, audit-chain invalidity, or regulated archive verification failure must fail closed.                                                        |
| Required audit events                     | Regulated clean completion records `session_completed` before archive creation so the archive contains terminal lifecycle evidence. Archive failures must surface as explicit error state/finding.                                          |
| Required operational logs                 | `info` for archive lifecycle progress and `error` for archive creation/verification failures with fields such as `sessionId`, `archiveStatus`, `findingCode`, and `archivePath` where safe. Operational logs are diagnostic only.           |
| Known gaps / residual risk / NOT_VERIFIED | Keyless archive digesting is not a full mitigation for an attacker who can rewrite `audit.jsonl` and re-seal the manifest. That full rewrite threat remains residual risk unless external TSA/RFC 3161 evidence is configured and verified. |

### Review Obligation, Invocation, And Findings Boundary

| Field                                     | Contract                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Review obligations carry obligation ID, type, iteration, plan version, mandate digest, criteria version, and status. Findings are schema-validated and bound to obligations/invocations before acceptance.                                                                                   |
| Mutable / diagnostic                      | Reviewer prompt text, host transport output, and tool response projections are not review-completion authority by themselves.                                                                                                                                                                |
| Writer / authority                        | Assurance helpers: [`src/integration/review/assurance.ts`](../src/integration/review/assurance.ts). Findings validation: [`src/integration/tools/review-validation.ts`](../src/integration/tools/review-validation.ts). Review schemas: [`src/state/evidence.ts`](../src/state/evidence.ts). |
| Attacker model                            | Primary agent fabricates findings, edits reviewer output, reuses old findings, mismatches session IDs, or submits reviewer==author approval.                                                                                                                                                 |
| Fail-closed expectation                   | Missing findings, self-review, schema mismatch, planVersion/iteration mismatch, obligation reuse, unavailable strict enforcement, or attestation mismatch must block.                                                                                                                        |
| Required audit events                     | Review tool calls, obligation creation/fulfillment/blocking where represented in state, decision receipts for human gates, and errors for blocked review submissions.                                                                                                                        |
| Required operational logs                 | `warn`/`error` for strict orchestration failure, findings rejection, or native attestation rejection with fields such as `obligationId`, `invocationId`, `reasonCode`, `reviewMode`, and `reviewHostPlatform`. Operational logs are diagnostic only.                                         |
| Known gaps / residual risk / NOT_VERIFIED | Host transport can corroborate review activity but does not approve. Completion authority remains validated, obligation-bound ReviewFindings. Claims about human reviewer intent beyond submitted evidence are `NOT_VERIFIED`.                                                               |

### Native Reviewer Capture Boundary

| Field                                     | Contract                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Accepted findings may be bound to an invocation and obligation. Native capture lines themselves are not hash-chain evidence.                                                                                               |
| Mutable / diagnostic                      | `reviewer-captures.jsonl` is append-only plaintext corroboration and may be agent-writable depending on host path. It is not approval authority.                                                                           |
| Writer / authority                        | Native capture acceptance is checked through review validation and assurance authorities, especially [`src/integration/tools/review-validation.ts`](../src/integration/tools/review-validation.ts).                        |
| Attacker model                            | Agent writes or edits capture files, provides malformed lines, mismatches session IDs, or attempts to upgrade native transport to approval authority.                                                                      |
| Fail-closed expectation                   | Malformed, skipped, missing, unbound, read-failed, session-mismatched, or plugin-handshake-missing native captures must not satisfy strict host-task-required review paths.                                                |
| Required audit events                     | Review invocation/evidence state changes and blocked review submissions where the runtime records them. Capture file existence alone is never an audit event.                                                              |
| Required operational logs                 | `warn` for native attestation not upgraded and `error` for capture read/write failure with fields such as `reasonCode`, `sessionId`, `childSessionId`, and `capturePath` where safe. Operational logs are diagnostic only. |
| Known gaps / residual risk / NOT_VERIFIED | Native capture is diagnostic/corroborating evidence only. It does not protect against a malicious host runtime or local file writer.                                                                                       |

### Actor Identity And IdP Boundary

| Field                                     | Contract                                                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Verified JWT claims are validated against configured issuer, audience, key, algorithm, temporal claims, and required subject/expiry. Decision identity may be captured in state and audit event actorInfo. |
| Mutable / diagnostic                      | `FLOWGUARD_ACTOR_ID`, git user name, and operator-provided claims are attribution inputs with documented assurance levels, not authentication by themselves.                                               |
| Writer / authority                        | Token verification: [`src/identity/token-verifier.ts`](../src/identity/token-verifier.ts). Identity evidence schemas: [`src/state/evidence.ts`](../src/state/evidence.ts).                                 |
| Attacker model                            | Operator spoofs env/git identity, submits expired/invalid JWT, uses mismatched issuer/audience/key, or attempts reviewer-author equality.                                                                  |
| Fail-closed expectation                   | Required IdP verification failures, insufficient actor assurance, token parse/signature/temporal failures, and reviewer==author decisions must block where policy requires.                                |
| Required audit events                     | Human-influenced lifecycle, tool_call, and decision events should include actorInfo when available and schema-valid. Identity-related blocked decisions must produce explicit error evidence.              |
| Required operational logs                 | `warn` for JWT verification failure or identity degradation with redacted fields such as `issuer`, `algorithm`, and `error`; never log raw tokens or raw claims. Operational logs are diagnostic only.     |
| Known gaps / residual risk / NOT_VERIFIED | FlowGuard is not an authentication provider. Env/git identity is best-effort. OIDC discovery, LDAP/SAML/RBAC, and full host login enforcement are not provided.                                            |

### Host Runtime, Plugin, Hook, And MCP Boundary

| Field                                     | Contract                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Governance decisions remain in FlowGuard tools, state, policy, audit, and validated review evidence. Host plugin/hook/MCP transport is an enforcement or invocation channel, not a second governance authority.                                                |
| Mutable / diagnostic                      | Host UI, plugin output replacement, hook transport payloads, MCP presentation, and doctor capability probes are diagnostic/projection surfaces unless persisted as validated FlowGuard evidence.                                                               |
| Writer / authority                        | Host adapter contract: [`src/adapters/host-adapter.ts`](../src/adapters/host-adapter.ts). Review validation and assurance modules remain the acceptance authority. Logging SSOT remains [`src/logging/logger.ts`](../src/logging/logger.ts).                   |
| Attacker model                            | Host runtime is missing, stale, malicious, cannot enforce synchronously, drops hook calls, mutates tool output, or presents stale status.                                                                                                                      |
| Fail-closed expectation                   | Unsupported or unavailable reviewer/enforcement transport must remain pending/blocked where policy requires. Hook/tool input validation failures deny rather than guess. Host diagnostics must not override canonical state.                                   |
| Required audit events                     | Tool calls, hook-observed host activity where supported, review evidence events/state, blocked errors, and lifecycle events.                                                                                                                                   |
| Required operational logs                 | `info` for plugin initialization/command start, `warn` for degraded host capability, and `error` for enforcement or hook failures with fields such as `host`, `enforcementLevel`, `tool`, `reasonCode`, and `sessionId`. Operational logs are diagnostic only. |
| Known gaps / residual risk / NOT_VERIFIED | A malicious or compromised host runtime is outside FlowGuard's full prevention boundary. Host capability probes are `NOT_VERIFIED` until runtime evidence exists. Presentation/admin console features are not built-in enforcement authority.                  |

### Network Boundary

FlowGuard is filesystem-first and offline-capable by default. Network-dependent features are explicit operator/configuration surfaces and have different authorities.

#### `/review url=...`

| Field                                     | Contract                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Fetched content is review input only after HTTPS URL and DNS target validation. Review completion still requires validated ReviewFindings.                                      |
| Mutable / diagnostic                      | Remote content, DNS results, HTTP response body, and reviewer summaries are mutable external input.                                                                             |
| Writer / authority                        | URL validation/fetch boundary lives in review input handling and network adapter code; review acceptance remains under review validation/assurance authorities.                 |
| Attacker model                            | SSRF attempt, private/reserved target, DNS failure, DNS rebinding, malicious remote content, or redirect abuse.                                                                 |
| Fail-closed expectation                   | Non-HTTPS, localhost/private/reserved DNS targets, empty/malformed DNS answers, mixed public/private answers, and redirects must be blocked before fetch.                       |
| Required audit events                     | Standalone review tool call and resulting review report/evidence events where produced.                                                                                         |
| Required operational logs                 | `warn`/`error` for URL rejection/fetch failure with fields such as `reasonCode`, `host`, and sanitized `url`; do not log fetched secrets. Operational logs are diagnostic only. |
| Known gaps / residual risk / NOT_VERIFIED | DNS preflight does not cryptographically bind the validated address to the later HTTPS connection. Complete SSRF containment requires external egress controls.                 |

#### Remote JWKS

| Field                                     | Contract                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | JWTs are cryptographically verified against configured issuer, audience, key ID, algorithm, and temporal claims.                                                     |
| Mutable / diagnostic                      | Remote JWKS endpoint availability and cache state are mutable operational inputs.                                                                                    |
| Writer / authority                        | Identity verifier and key resolver path, including [`src/identity/token-verifier.ts`](../src/identity/token-verifier.ts).                                            |
| Attacker model                            | JWKS outage, key mismatch, stale key, malicious token, or algorithm confusion attempt.                                                                               |
| Fail-closed expectation                   | In required identity mode, missing/invalid/fetch-failed JWKS or invalid token claims must block mutating approval paths.                                             |
| Required audit events                     | Decision/tool events should include verified actorInfo where available; identity failures must surface as explicit errors.                                           |
| Required operational logs                 | `warn` for verification or JWKS failures with redacted fields (`issuer`, `kid`, `algorithm`, `reasonCode`). Operational logs are diagnostic only.                    |
| Known gaps / residual risk / NOT_VERIFIED | FlowGuard does not provide OIDC discovery or last-known-good fallback as an authentication service. Network trust still depends on HTTPS and operator configuration. |

#### Localhost Hooks

| Field                                     | Contract                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | Accepted hook payloads must be parsed and validated before influencing FlowGuard state or decisions.                                                                    |
| Mutable / diagnostic                      | Localhost listener availability, host hook delivery, and host-side hook status are operational surfaces.                                                                |
| Writer / authority                        | Hook handlers must delegate to existing FlowGuard phase/tool/review authorities rather than reimplement decisions.                                                      |
| Attacker model                            | Local process sends malformed hook payloads, host drops hooks, listener is unavailable, or hook execution is advisory only.                                             |
| Fail-closed expectation                   | Invalid hook payload or unreadable state denies where hook enforcement is active; unavailable hook transport must not be treated as proof of governance.                |
| Required audit events                     | Hook-observed tool activity where supported and state-changing tool events.                                                                                             |
| Required operational logs                 | `warn`/`error` for hook listener or payload validation failure with fields such as `host`, `hook`, `reasonCode`, and `sessionId`. Operational logs are diagnostic only. |
| Known gaps / residual risk / NOT_VERIFIED | Localhost hook protection is not network isolation. Host-level firewall/process controls remain customer responsibility.                                                |

### Operational Logging Boundary

| Field                                     | Contract                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed / integrity-covered                | None. Logs are not signed and are not governance evidence.                                                                                                                                     |
| Mutable / diagnostic                      | All operational log entries, console output, file sink output, host UI logs, and doctor/status presentation.                                                                                   |
| Writer / authority                        | Logging interface and sink contract: [`src/logging/logger.ts`](../src/logging/logger.ts). Redaction helpers: [`src/logging/redact.ts`](../src/logging/redact.ts).                              |
| Attacker model                            | Operator relies on logs instead of state/audit/archive, logs are lost, sink throws, file logs are edited, or sensitive fields leak.                                                            |
| Fail-closed expectation                   | Logger sink failures must not become hidden governance success. Security-critical paths must persist audit/state evidence or return explicit failure; logs alone never satisfy evidence gates. |
| Required audit events                     | None from logging itself. Relevant runtime action must write audit/state/archive/review evidence through its own boundary.                                                                     |
| Required operational logs                 | The log point itself must specify level, service, message, and structured `extra` fields. Operational logs are diagnostic only.                                                                |
| Known gaps / residual risk / NOT_VERIFIED | Logs can be suppressed by level, sink failures are non-blocking, and log files are mutable. Do not use logs as audit evidence.                                                                 |

---

## Threat Model

### Threats Within Trust Boundary

| Threat                          | Implemented / enforced mitigation                                      | Residual risk / NOT_VERIFIED                                     |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Tampered state**              | Zod schema validation, explicit error state, archive metadata binding  | Local rewrite prevention depends on OS controls                  |
| **Tampered audit**              | Audit hash chain, strict verification, optional TSA timestamp evidence | Full keyless rewrite remains residual without external TSA trust |
| **Invalid transitions**         | Phase topology and guard evaluation                                    | Presentation output can still be stale/diagnostic                |
| **Missing review evidence**     | Obligation-bound ReviewFindings and strict acceptance checks           | Native capture is corroboration only                             |
| **Policy downgrade in archive** | State-derived strictness and manifest policy-mode mismatch finding     | Archive re-seal risk remains without external trust anchor       |
| **Identity spoofing**           | Required IdP/claim assurance gates where configured                    | Env/git identity is best-effort attribution only                 |

### Threats Outside Trust Boundary

| Threat                     | Status                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OS compromise**          | Customer responsibility; FlowGuard cannot prevent a compromised OS from rewriting local files.                                                   |
| **Malicious host runtime** | Residual risk; FlowGuard treats host transports as channels, not approval authority.                                                             |
| **Network isolation**      | Customer responsibility; FlowGuard validates selected inputs but does not provide a sandbox/firewall.                                            |
| **Encryption at rest**     | Not covered; use filesystem/platform encryption.                                                                                                 |
| **Admin console security** | No built-in admin console is an enforcement authority. Presentation/admin surfaces are diagnostic unless backed by state/audit/archive evidence. |

---

## Security Properties

### FlowGuard Design Properties

| Property         | Implementation                                            |
| ---------------- | --------------------------------------------------------- |
| **Integrity**    | State schemas, audit hash chain, archive content digest   |
| **Determinism**  | Pure rails and machine authorities                        |
| **Traceability** | Policy snapshot, review evidence, audit trail             |
| **Isolation**    | Adapters and host transports as explicit boundaries       |
| **Fail closed**  | Missing/invalid authority data blocks rather than guesses |

### Customer Responsibility

| Property              | Notes                                                                              |
| --------------------- | ---------------------------------------------------------------------------------- |
| **Confidentiality**   | FlowGuard state and audit data are plaintext unless the platform encrypts storage. |
| **Network isolation** | Use firewall/proxy/sandbox controls for strong egress/inbound containment.         |
| **Access control**    | Restrict `.opencode/`, workspace, session, archive, and config paths.              |
| **Host trust**        | Install and operate trusted host runtimes and plugins.                             |

---

## Deployment Considerations

### Single-User Machine

| Boundary       | Assessment                                                            |
| -------------- | --------------------------------------------------------------------- |
| **Filesystem** | Trust is bounded by the local user's OS account and file permissions. |
| **Network**    | Optional network features should be disabled where not needed.        |
| **Host**       | Host runtime remains a transport surface, not governance authority.   |

### Shared Development Machine

| Boundary       | Assessment                                                              |
| -------------- | ----------------------------------------------------------------------- |
| **Filesystem** | Avoid shared session/config directories; enforce per-user permissions.  |
| **Network**    | Central egress controls may be required for `/review url=...` and JWKS. |
| **Host**       | Per-user host/plugin isolation is required.                             |

### Air-Gapped Environment

| Boundary       | Assessment                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| **Network**    | Do not configure or invoke `/review url=...`, remote JWKS, or network-dependent hooks. |
| **Filesystem** | Physical and OS access controls are mandatory.                                         |
| **Updates**    | Transfer and verify release artifacts through the approved air-gap process.            |

---

FlowGuard Version: 1.2.0-tp.1
_Last Updated: 2026-06-06_
