# BSI C5 Compliance Mapping

How FlowGuard capabilities map to BSI Cloud Computing Compliance Criteria Catalogue (C5:2020) control domains.

---

## Scope and Disclaimer

**BSI C5:2020** is a compliance framework designed for **cloud service providers**. It defines criteria that cloud providers must meet to demonstrate operational security to their customers.

**FlowGuard is not a cloud service.** It is a locally installed, self-hosted development workflow tool. It does not process, store, or transmit data to external services.

This document maps FlowGuard's technical capabilities to C5:2020 control domains where FlowGuard **contributes as a building block** within a larger organizational compliance program. FlowGuard alone does not satisfy any C5 control in full. Organizations must assess whether FlowGuard's capabilities, combined with their own policies, processes, and infrastructure, meet their specific compliance requirements.

**Reference:** [BSI C5:2020 — Cloud Computing Compliance Criteria Catalogue](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/CloudComputing/ComplianceControlsCatalogue/2020/C5_2020.pdf)

### Reading This Document

Each section below covers one C5:2020 control domain. For each domain:

- **Relevance** indicates how directly FlowGuard's capabilities relate to the domain.
- **FlowGuard Provides** lists specific, evidence-backed capabilities.
- **Organization Must Provide** lists responsibilities that FlowGuard cannot address.

Relevance levels:
- **Direct** — FlowGuard provides technical controls that directly support the domain's intent.
- **Partial** — FlowGuard contributes to some aspects but does not address the domain comprehensively.
- **Not Applicable** — The domain covers concerns outside FlowGuard's scope (physical security, HR, etc.).

---

## Domain Mapping Summary

| C5 Domain | Name | Relevance | FlowGuard Contribution |
|-----------|------|-----------|----------------------|
| OIS | Organisation of Information Security | Partial | Policy-bound execution model |
| SP | Security Policies | Partial | Enforceable policy modes with fail-closed semantics |
| HR | Human Resources | Not Applicable | — |
| AM | Asset Management | Partial | Release artifact checksums, minimal supply chain |
| PS | Physical Security | Not Applicable | — |
| RB | Operational Procedures | **Direct** | 8-phase change workflow, evidence gates, audit trail |
| IDM | Identity and Access Management | **Direct** | Four-eyes principle, role separation (initiator vs. reviewer) |
| CRY | Cryptography and Key Management | Partial | SHA-256 hash chain, checksums on release artifacts |
| KOS | Communications Security | Not Applicable | No network communication (self-hosted) |
| PI | Portability and Interoperability | Partial | Structured session archives with integrity verification |
| DEV | Procurement and Development | **Direct** | Structured development workflow with validation gates |
| DLL | Supplier Management | Partial | Minimal supply chain (1 runtime dependency: zod), offline-resolvable dependencies |
| SIM | Security Incident Management | Not Applicable | — |
| BCM | Business Continuity Management | Not Applicable | — |
| COM | Compliance | **Direct** | Evidence completeness matrix, compliance reports, session archives |
| INQ | Handling of Investigation Requests | Not Applicable | — |
| PSS | Product Security | Partial | Fail-closed enforcement, reason-coded blocking |

---

## Direct Mappings

### RB — Operational Procedures (Regelungen zum Betrieb)

**Relevance: Direct**

The RB domain covers change management, operational documentation, logging, and monitoring. This is FlowGuard's primary contribution area.

#### FlowGuard Provides

**Change Management:**
- 14 explicit workflow phases across 3 flows: Ticket (READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE), Architecture (READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE), Review (READY → REVIEW → REVIEW_COMPLETE)
- Phase gates that require evidence before progression — no phase can be skipped
- Fail-closed enforcement: execution blocks when evidence or state is invalid
- Backward transitions on rejection: `changes_requested` returns to the previous authoring phase; `reject` returns to TICKET (ticket flow) or READY (architecture flow)
- Validation checks defined by active profile must all pass before implementation begins
- Every phase transition is governed by a pure, deterministic state machine with an immutable transition table

**Logging and Monitoring:**
- Hash-chained audit trail: SHA-256 linked events in JSONL append-only format
- Tamper-evident design: each event's hash includes the previous event's hash
- 4 structured event kinds: `transition`, `tool_call`, `error`, `lifecycle`
- Automated compliance summary generation from audit trail (7-check assessment)
- Policy snapshot: immutable, SHA-256 hashed copy of the active policy frozen at session creation

**Operational Documentation:**
- Canonical state model: single JSON document, Zod-validated on every write
- State answers: current phase, active profile, evidence chain, policy snapshot, gate status, blockers
- Reason-coded blocking: 30+ specific error codes with recovery guidance

#### Organization Must Provide

- Organizational change management policies and approval workflows beyond FlowGuard sessions
- Infrastructure-level logging, monitoring, and alerting systems
- Log retention policies and log management infrastructure
- Incident response integration for operational failures
- Backup and recovery procedures for FlowGuard session data

---

### IDM — Identity and Access Management (Identitäts- und Berechtigungsmanagement)

**Relevance: Direct**

The IDM domain covers identity management, access control, and separation of duties.

#### FlowGuard Provides

**Separation of Duties:**
- Three policy modes with escalating enforcement: Solo, Team, Regulated
- **Regulated mode** enforces the four-eyes principle: the reviewer must differ from the session initiator
- Self-approval is blocked in Regulated mode (`allowSelfApproval: false`)
- Initiator and reviewer identities are tracked in session state and audit trail
- 2 mandatory human gates (PLAN_REVIEW, EVIDENCE_REVIEW) in Team and Regulated modes
- `FOUR_EYES_VIOLATION` reason code blocks progress when the principle is violated

**Policy Enforcement:**
- Policy mode is set at session creation and governs all subsequent transitions
- Policy configuration is immutable for the session lifetime (policy snapshot with SHA-256 hash)

#### Organization Must Provide

- User identity management (authentication, directory services)
- Access control to the development environment and FlowGuard installation
- Role definitions and role assignment beyond initiator/reviewer
- Periodic access reviews
- Privileged access management for the systems FlowGuard runs on

---

### DEV — Procurement and Development (Beschaffung und Entwicklung)

**Relevance: Direct**

The DEV domain covers secure development practices, development guidelines, and testing requirements.

#### FlowGuard Provides

**Structured Development Workflow:**
- Mandatory planning phase before implementation (PLAN with self-review loop)
- Human plan approval gate (PLAN_REVIEW) before any code changes
- Automated validation checks between plan approval and implementation
- Implementation review loop (IMPL_REVIEW) — LLM self-reviews implementation against the approved plan
- Final human evidence review (EVIDENCE_REVIEW) before completion

**Development Guidelines:**
- Tech-stack-aware profiles: built-in profiles for Java/Spring Boot, Angular/Nx, TypeScript/Node.js
- Profile rules delivered as tool returns, providing stack-specific guidance during implementation
- Profile auto-detection from repository signals (file-path-based, no content reading)

**Testing Integration:**
- VALIDATION phase runs automated checks defined by the active profile
- All validation checks must pass before implementation begins
- Failed validation returns the workflow to PLAN (plan must be revised and re-approved)

#### Organization Must Provide

- Software development lifecycle policies
- Code review standards and processes beyond FlowGuard's automated checks
- Security testing requirements (SAST, DAST, penetration testing)
- Deployment and release management processes
- Third-party component evaluation policies

---

### COM — Compliance

**Relevance: Direct**

The COM domain covers compliance documentation, evidence retention, and audit support.

#### FlowGuard Provides

**Evidence Management:**
- Evidence completeness matrix: deterministic per-slot evaluation of all evidence requirements
- 17 Zod-validated evidence schemas ensuring structural correctness
- Compliance summary generation: automated 7-check compliance assessment from session audit trail
- Session archives: `.tar.gz` with structured manifest, file inventory, per-file SHA-256 digests, and content digest
- 10-check archive verification (`verifyArchive()`) validates manifest presence, file completeness, digest integrity

**Audit Support:**
- Complete session history: ticket, plan versions, validation results, implementation evidence, review decisions
- Hash-chained audit trail provides non-repudiation (each event cryptographically linked to predecessor)
- Policy snapshot proves which rules governed each session
- Read-only compliance report generation (`/review`) available at any phase without mutating state

#### Organization Must Provide

- Regulatory applicability assessment
- Compliance program management and oversight
- Audit scheduling, auditor coordination, and evidence presentation
- Retention policies for FlowGuard session archives
- Mapping of FlowGuard evidence to specific regulatory requirements

---

## Partial Mappings

### OIS — Organisation of Information Security

**Relevance: Partial**

FlowGuard provides a policy-bound execution model that can be incorporated into an organization's information security management system (ISMS), but does not itself constitute an ISMS.

- **FlowGuard provides:** Configurable policy modes (Solo, Team, Regulated) with deterministic enforcement, reason-coded blocking on policy violations, immutable policy snapshots per session.
- **Organization must provide:** Information security management system, risk management processes, security roles and responsibilities, management commitment and oversight.

### SP — Security Policies

**Relevance: Partial**

FlowGuard enforces its own policy rules deterministically, but organizational security policies must be defined and maintained separately.

- **FlowGuard provides:** Fail-closed enforcement of active policy, policy configuration validated via Zod schemas, policy changes require new session (no mid-session policy modification).
- **Organization must provide:** Written security policies, policy review and approval processes, policy communication and training, policy exception management.

### AM — Asset Management

**Relevance: Partial**

FlowGuard provides release artifact integrity verification and minimal supply chain.

- **FlowGuard provides:** SHA-256 checksums on release artifacts, release artifact integrity verification, minimal supply chain surface (1 runtime dependency: `zod`).
- **Organization must provide:** Asset inventory management, asset classification, data handling policies, media handling and disposal.

### CRY — Cryptography and Key Management

**Relevance: Partial**

FlowGuard uses cryptographic operations for integrity verification, not for data encryption or key management.

- **FlowGuard provides:** SHA-256 hash-chained audit trail (tamper-evident), SHA-256 digests on archive files and manifests, SHA-256 checksums on release artifacts, SHA-256 policy snapshot hashing for non-repudiation.
- **Organization must provide:** Encryption policies, key management infrastructure, certificate management, cryptographic algorithm selection policies.

### PI — Portability and Interoperability

**Relevance: Partial**

FlowGuard session data is structured and exportable, supporting data portability requirements.

- **FlowGuard provides:** Structured session archives (`.tar.gz`) with JSON manifest, Zod-validated state schemas (documented, deterministic structure), JSONL audit trail in standard format.
- **Organization must provide:** Data migration strategies, vendor lock-in assessment, interoperability testing with other systems.

### DLL — Supplier Management (Steuerung von Dienstleistern)

**Relevance: Partial**

FlowGuard's minimal dependency footprint reduces supply chain risk.

- **FlowGuard provides:** 1 runtime dependency (`zod`), offline-resolvable dependencies via local vendor directory, pre-built release artifact distributed via GitHub Releases.
- **Organization must provide:** Supplier evaluation and selection processes, supplier monitoring, contractual security requirements, supply chain risk management.

### PSS — Product Security

**Relevance: Partial**

FlowGuard applies defensive design principles to its own operation.

- **FlowGuard provides:** Fail-closed enforcement (missing evidence blocks progress, invalid state blocks progress, tampered artifacts block verification), reason-coded blocking with recovery guidance, Zod schema validation on every state write, deterministic state machine (pure functions, no side effects in core).
- **Organization must provide:** Product security testing, vulnerability management, security update processes, security monitoring.

---

## Not Applicable Domains

The following C5:2020 domains address concerns outside FlowGuard's scope. FlowGuard neither provides nor claims to provide capabilities in these areas.

| Domain | Reason |
|--------|--------|
| HR — Human Resources | FlowGuard is a software tool, not an HR process. |
| PS — Physical Security | FlowGuard runs locally on developer machines. Physical security is an infrastructure concern. |
| KOS — Communications Security | FlowGuard makes no outbound network calls. All data stays on the local filesystem. |
| SIM — Security Incident Management | FlowGuard does not include incident detection or response capabilities. |
| BCM — Business Continuity Management | FlowGuard is a development tool, not a business continuity system. |
| INQ — Handling of Investigation Requests | This is an organizational and legal concern, not a tool capability. |

---

## Evidence Reference

The following FlowGuard artifacts provide verifiable evidence for the mappings above.

| Artifact | Location | Supports |
|----------|----------|----------|
| State machine topology | `src/machine/topology.ts` | RB (change management), DEV (structured workflow) |
| Evidence completeness matrix | `src/audit/completeness.ts` | COM (evidence management) |
| Audit trail types and integrity | `src/audit/types.ts`, `src/audit/integrity.ts` | RB (logging), CRY (hash chain) |
| Policy configuration | `src/config/policy.ts` | IDM (separation of duties), OIS (policy enforcement) |
| Review decision logic | `src/rails/review-decision.ts` | IDM (four-eyes principle) |
| Archive verification | `src/archive/types.ts` | COM (audit support), PI (portability) |
| Release workflow | `.github/workflows/release.yml` | AM (checksums), DLL (supply chain) |
| Security policy | `SECURITY.md` | PSS (vulnerability management) |

---

## Limitations

1. **FlowGuard is not C5-certified.** This mapping is informational. It does not constitute a C5 audit or attestation.
2. **Building blocks, not complete controls.** Each mapping shows where FlowGuard contributes. No C5 control is fully satisfied by FlowGuard alone.
3. **Organizational context required.** C5 controls require organizational policies, processes, infrastructure, and governance that FlowGuard cannot provide.
4. **Single-machine scope.** FlowGuard operates on a single developer machine with local filesystem storage. Multi-user, distributed, or infrastructure-level controls are outside its scope.
5. **No independent verification.** The mappings in this document have not been validated by an independent auditor or the BSI.

---

*Reference: BSI C5:2020 — Cloud Computing Compliance Criteria Catalogue*
*FlowGuard Version: 1.0.0*
*Last Updated: 2026-04-15*
