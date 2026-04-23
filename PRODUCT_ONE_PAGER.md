# FlowGuard — AI Engineering Governance Platform

**AI-assisted engineering with deterministic workflow control, fail-closed enforcement, and audit-ready evidence.**

---

## The Problem

AI coding tools generate code. They do not provide a deterministic control plane. Most organizations cannot answer:

- Who requested this change?
- What exactly was approved?
- Which governance rules were active?
- What evidence exists for this implementation?
- Can we export the full record for audit or compliance review?

## The Solution

FlowGuard governs the engineering process _around_ AI-assisted development — it does not replace the coding assistant. It adds deterministic workflow control, explicit approval gates, evidence tracking, and audit-ready proof to every AI-supported change.

## Key Capabilities

### Deterministic Workflows

- Three independent flows: Ticket (full dev lifecycle), Architecture (ADR creation), Review
- 14 explicit phases with computed next actions
- Explicit `/status` orientation surface (compact + focused detail views)
- Phase gates require evidence before progression
- Fail-closed enforcement: execution blocks when evidence or state is invalid

### Policy Enforcement

- Four policy modes: Solo (local development), Team (human gates), Team-CI (CI-aware), Regulated (four-eyes enforcement)
- Central policy minimum — optional explicit governance baseline
- Tech-stack-aware profiles with auto-detection

### Audit & Evidence

- Hash-chained audit trail (SHA-256, tamper-evident, JSONL append-only)
- Decision receipts for every approval
- Policy snapshots frozen at session creation
- Session archives with redaction support

### Four-Eyes Governance

- Regulated mode enforces initiator/reviewer separation
- Minimum actor assurance is policy-bound via `minimumActorAssuranceForApproval` across `best_effort`, `claim_validated`, and `idp_verified`
- `idp_verified` supports static keys (`identityProvider.mode = static`) and JWKS mode (`identityProvider.mode = jwks`) with exactly one key authority (`jwksPath` or HTTPS `jwksUri`), TTL cache, and strict fail-closed verification
- `identityProviderMode: required` blocks fail-closed; `identityProviderMode: optional` degrades only for typed IdP errors
- P35 excludes OIDC discovery and stale/last-known-good JWKS fallback
- Team and Regulated modes require explicit human decisions at gates

### Headless Fail-Closed Behavior

- Non-interactive execution (`flowguard run`, `flowguard serve`, OpenCode automation) does not rely on follow-up questions
- Missing safety-critical input returns explicit `BLOCKED` outcomes with recovery guidance

## Compliance Alignment

FlowGuard provides building blocks for controlled software delivery. It maps to common frameworks but does not certify compliance:

- **BSI C5** — Audit trail, access control, segregation of duties
- **MaRisk AT 7.2-7.4** — Four-eyes principle, documentation, approval workflows
- **BAIT § 8-14** — IT operations, change management, incident response
- **DORA Art. 5-8** — ICT risk management, deployment control
- **GoBD § 2-8, § 145/146** — Documentation, auditability, data retention

## Why Not Just GitHub Copilot + Jira + CI?

Existing tool combinations generate output but do not provide:

- Deterministic phase gates and admissibility checks
- Policy-bound workflow enforcement
- Immutable decision receipts linked to audit trail
- Evidence completeness verification before phase transitions
- Session-level archive export for compliance review
- Explicit governance evidence for risk assessments

FlowGuard fills this gap without replacing existing tools.

---

## Getting Started

FlowGuard is an OpenCode-native governance runtime. It runs locally within the AI coding assistant's session workspace with filesystem-first operation. Optional remote JWKS fetches apply only when configured via `identityProvider.mode = jwks` + `jwksUri`; otherwise no outbound runtime dependency is required.

For technical evaluation or pilot discussions, contact the FlowGuard project owner.

**Current snapshot: v1.1.0**
