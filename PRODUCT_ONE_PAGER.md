# FlowGuard — AI EngineeringGovernance Platform

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
- Current attribution is best-effort; enterprise identity integration is extensible
- Team and Regulated modes require explicit human decisions at gates

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

FlowGuard is an OpenCode-native governance runtime. It runs locally within the AI coding assistant's session workspace. No outbound network calls. No external service dependency.

For technical evaluation or pilot discussions, contact the FlowGuard project owner.

**Current snapshot: v1.1.0**
