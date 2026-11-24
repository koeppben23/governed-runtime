# FlowGuard — AI Engineering Governance Platform

**Technical Preview** — host-aware governance runtime for AI-assisted software delivery.

**AI-assisted engineering with deterministic workflow control, fail-closed enforcement, and audit evidence.**

FlowGuard is a host-aware governance runtime. OpenCode currently provides the
strongest synchronous enforcement path; Claude Code and Codex are supported via
MCP, hooks, and native packaging with hook-gated, platform-limited guarantees.
This is a technical preview, not a GA release.

**Four product pillars:** Deterministic Governance · Independent Review ·
Evidence & ProofGraph · Verifiable Auditability.

---

## The Problem

AI coding tools generate code. They do not provide a deterministic control plane. Most organizations cannot answer:

- Who requested this change?
- What exactly was approved?
- Which governance rules were active?
- What evidence exists for this implementation?
- Can we export the full record for audit or compliance review?

## The Solution

FlowGuard governs the engineering process _around_ AI-assisted development — it does not replace the coding assistant. It adds deterministic workflow control, explicit approval gates, evidence tracking, and tamper-evident records to every AI-supported change.

## Key Capabilities

### Deterministic Governance

- Three independent flows: Ticket (full dev lifecycle), Architecture (ADR creation, ARCH_REVIEW → ARCH_COMPLETE), Review (content-aware, obligation-bound)
- 18 explicit phases with computed next actions
- Explicit `/status` orientation surface (compact + focused detail views)
- Phase gates require evidence before progression
- Fail-closed enforcement: execution blocks when evidence or state is invalid. Enforcement strength is host-dependent: synchronous (in-process block) on OpenCode; best-effort fail-closed on hook-gated hosts (Claude Code, Codex).
- Four policy modes: Solo (local development), Team (human gates), Team-CI (CI-aware), Regulated (four-eyes enforcement)
- Central policy minimum — optional explicit governance baseline
- Tech-stack-aware profiles with auto-detection
- External references for `/ticket` and `/review`: link Jira, ADO, GitHub Issues, PRs, branches, commits, and Confluence docs with full audit provenance (type, source, extractedAt)
- Product command facade (`/start`, `/task`, `/approve`, `/request-changes`, `/reject`, `/why`) for intuitive daily use; canonical commands remain fully supported. Native `/check` is a scoped verification/review turn, not a VALIDATE alias; `/continue` reports guidance read-only. `/export` materializes the required verifiable export and completes the ticket flow
- Review Cards: structured markdown cards (Plan Review Card, Architecture Review Card, Review Report Card) injected at review gates. Cards are derived presentation artifacts — `session-state.json` remains SSOT

### Independent Review

- Regulated mode enforces initiator/reviewer separation
- On OpenCode V2, independent review uses a visible native `flowguard-reviewer` child session with obligation-bound authorization and a same-child JSON serialization window. It requires no `format` or forced tool. Other supported hosts have platform-specific transport and enforcement boundaries. See [Independent Review](./docs/independent-review.md) for current guarantees, known limitations, and installed acceptance
- Independent review is wired for **all three** review-loop tools — `/plan`, `/architecture`, and `/implement` — sharing one orchestration pipeline, one ReviewFindings schema, and one fail-closed strict-enforcement model
- Standalone `/review` creates obligation-bound content-review evidence with `review` obligations, strict attestation validation, and explicit host-orchestrated vs agent-submitted evidence source marking
- Reviewer's `unable_to_review` third verdict consumes the obligation and BLOCKS via `SUBAGENT_UNABLE_TO_REVIEW` instead of fabricating an `approve` or `changes_requested`
- Minimum actor assurance is policy-bound via `minimumActorAssuranceForApproval` across `best_effort`, `claim_validated`, and `idp_verified`
- `idp_verified` supports static keys (`identityProvider.mode = static`) and JWKS mode (`identityProvider.mode = jwks`) with exactly one key authority (`jwksPath` or HTTPS `jwksUri`), TTL cache, and strict fail-closed verification
- JWT verification is implemented via `jose` `jwtVerify` with FlowGuard-owned key resolution (no remote JWK set in verifier path)
- `identityProviderMode: required` blocks fail-closed; `identityProviderMode: optional` degrades only for typed IdP errors
- OIDC discovery and stale/last-known-good JWKS fallback are not implemented
- Team and Regulated modes require explicit human decisions at gates

### Evidence & ProofGraph

- ProofGraph keeps claims, evidence, verification, independent review, and approval distinct
- Critical plan-certified `fact` claims cannot reach evidence approval while required revision-bound positive and adversarial evidence is missing
- `PROVEN` means the policy-required evidence succeeded; it does not mean the change is free of defects. Residual uncertainty remains explicit as `UNPROVEN`, `CONTRADICTED`, `STALE`, `BLOCKED`, or `NOT_VERIFIED`
- Evidence completeness verification runs before phase transitions
- Derived evidence artifacts carry content digests and `sourceStateHash` provenance

### Verifiable Auditability

- Hash-chained audit trail (SHA-256, tamper-evident, JSONL append-only)
- Decision receipts linked to the audit trail and policy provenance
- Policy snapshots frozen at session creation
- Session archives with redaction support; sharing archives remain structurally checkable but are not fully verifiable raw evidence
- Mutation testing on security-critical paths (StrykerJS, blocking 80% break threshold; see `stryker.conf.json`)

### Headless Fail-Closed Behavior

- Non-interactive execution (`flowguard run`, `flowguard serve`, OpenCode automation) does not rely on follow-up questions
- Missing safety-critical input returns explicit `BLOCKED` outcomes with recovery guidance

## Compliance Alignment

FlowGuard provides building blocks for controlled software delivery. It maps to common frameworks but does not certify compliance:

- **BSI C5** — Audit trail, access control, segregation of duties
- **MaRisk AT 7.2-7.4** — Four-eyes principle, documentation, approval workflows
- **BAIT § 8-14** — IT operations, change management, incident response
- **DORA Art. 5-8** — ICT risk management, deployment control
- **GoBD § 2-8, § 145/146** — Documentation, traceability, data retention

## Why Not Just GitHub Copilot + Jira + CI?

Existing tool combinations generate output but do not provide:

- Deterministic phase gates and admissibility checks
- Policy-bound workflow enforcement
- Decision receipts linked to the audit trail and policy provenance
- Evidence completeness verification before phase transitions
- ProofGraph visibility into claims, evidence, and residual uncertainty
- Session-level archive export that supports audit and evidence review
- Explicit governance evidence that supports risk assessments

FlowGuard fills this gap without replacing existing tools.

---

## Getting Started

FlowGuard is a host-aware governance runtime. It runs locally within the selected host workspace with filesystem-first operation and is offline-capable by default. Network-dependent surfaces are explicit: `/review url=...` performs HTTPS content loading when invoked, remote JWKS fetches apply only when configured via `identityProvider.mode = jwks` + `jwksUri`, and Claude Code HTTP hook mode starts a localhost listener when selected.

For technical evaluation or pilot discussions, contact the FlowGuard project owner.

**Released Technical Preview:** [2.0.0-tp.2](https://github.com/koeppben23/governed-runtime/releases/tag/v2.0.0-tp.2) (2026-10-04)

**Current snapshot: 2.0.0-tp.2** — `develop` may contain changes after the released artifact.

**Installed host acceptance:** version-bound; tracked in #1196.

**Production readiness:** not complete; no GA claim.

**API Reference:** [TypeDoc-generated](https://koeppben23.github.io/governed-runtime/) (GitHub Pages)
