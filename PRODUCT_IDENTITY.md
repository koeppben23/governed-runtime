# AI Engineering FlowGuard Platform

AI-assisted engineering with deterministic workflow control, fail-closed enforcement, and audit-ready evidence.

---

## Executive Summary

The **AI Engineering FlowGuard Platform** transforms AI-assisted software delivery from unstructured chat interactions into **deterministic, policy-bound workflows** with explicit phases, gates, canonical state, audit artifacts, and fail-closed enforcement.

Built for **regulated industries, enterprise engineering teams, and organizations with audit or compliance requirements**, the platform provides the operating discipline that AI-driven development needs to meet controlled software delivery standards.

**Key Value Proposition:** Organizations can now use AI for software delivery while maintaining proof, control, and auditability — not just generated code.

---

## The Problem

Most AI coding tools optimize for speed and code generation. That's useful, but insufficient for organizations that must answer:

- **Who** requested this change?
- **What** exactly was approved?
- **Which** rules and profiles were active?
- **What** evidence exists for the implementation?
- **Which** controls blocked or allowed the next step?
- **Can** we export the full record for audit, risk, or legal review?

Existing AI tools leave these questions unanswered. The platform closes this gap.

---

## Key Capabilities

### Deterministic Workflow Control

- **3 independent flows** — Ticket (full dev lifecycle), Architecture (ADR creation), Review (compliance and content-aware review)
- **14 explicit phases** across three flows, starting from a shared READY entry point
- **Phase gates** that require evidence before progression
- **Computed next actions** — the system tells you exactly what is allowed, not guessed
- **Explicit orientation surface** — `/status` provides read-only canonical projections for phase, blockers, evidence, context, and readiness
- **Fail-closed enforcement** — execution blocks when evidence or state is invalid
- **Policy-aware evaluation** — every transition is checked against the active FlowGuard policy

### FlowGuard & Compliance

- **Four policy modes:** Solo (no human gates, fast feedback), Team (human gates), Team-CI (CI-aware auto-approve with safe degradation), Regulated (four-eyes principle enforced)
- **Central policy minimum enforcement:** optional explicit central source (`FLOWGUARD_POLICY_PATH`) constrains hydrate policy resolution; explicit weaker-than-central requests fail closed, repo/default weaker modes are elevated with visible resolution evidence
- **Tech-stack-aware profiles:** Java/Spring Boot, Angular/Nx, TypeScript/Node.js, with auto-detection
- **Evidence completeness matrix** — deterministic per-slot evaluation of all evidence requirements
- **Reason-coded blocking** — every blocker has a specific error code, recovery guidance, and optional quick-fix
- **Compliance mappings:** BSI C5, MaRisk (AT 7.2-7.4, BT 1-5), BAIT (§ 8-14), DORA (Art. 5-8), GoBD (§ 2-8, § 145/146)

### Audit & Evidence

- **Hash-chained audit trail** — SHA-256 linked events, tamper-evident, JSONL append-only
- **Structured event kinds** — transition, tool_call, error, lifecycle, and decision events with typed details
- **Decision receipts** — every successful `/review-decision` emits immutable `decision:DEC-xxx` receipt events
- **Compliance summary generation** — automated 7-check compliance assessment from audit trail
- **Four-eyes principle verification** — initiator vs. reviewer identity tracked and enforced in Regulated mode. FlowGuard supports three-tier minimum actor assurance (`best_effort`, `claim_validated`, `idp_verified`) with `minimumActorAssuranceForApproval` policy threshold. All modes default to `best_effort`; stronger assurance requires explicit configuration (`minimumActorAssuranceForApproval: idp_verified`, `identityProviderMode: required`). IdP verification supports static keys (`mode: static`) and JWKS mode (`mode: jwks`) with exactly one authority (`jwksPath` or HTTPS `jwksUri`), TTL cache, and strict fail-closed behavior (`identityProviderMode: required` blocks mutating decisions; `optional` degrades only on typed IdP errors). JWT verification is implemented with `jose` `jwtVerify` while key authority stays FlowGuard-owned. `/hydrate` resolves actor identity diagnostically, while `/review-decision` enforces the policy snapshot threshold fail-closed. OIDC discovery and stale/last-known-good fallback are not implemented.
- **Policy snapshot** — immutable, hashed copy of active policy frozen at session creation (includes all governance fields: mode, gate behavior, review iterations, self-approval, audit settings, and actor classification)

### Enterprise Integration

- **OpenCode-native** — TypeScript architecture, runs within the OpenCode host runtime
- **Pipeline-ready** — headless mode via OpenCode SDK (`POST /session/:id/command`)
- **Profile auto-detection** — repository signals (pom.xml, angular.json, tsconfig.json) resolve the right profile
- **Extensible** — register custom profiles, reason codes, and check executors without modifying core code
- **Self-hosted** — runs locally with filesystem-first operation. Optional remote JWKS fetches occur only when `identityProvider.mode = jwks` with `jwksUri`; otherwise runtime behavior is offline.

### Repository Discovery

- **6-collector pipeline** — repo metadata, stack detection, topology analysis, surface detection, bounded code-surface analysis, domain signals — all run in parallel with budget guards
- **Evidence-classified** — every detected item carries `fact`, `derived_signal`, or `hypothesis` classification
- **Database stack facts** — stack detection derives concrete database engines from repo evidence (dependencies, compose images, testcontainers) and surfaces them to session status as compact detected stack items
- **Root-level Python/Rust/Go ecosystem facts** — stack detection derives Python/Rust/Go language/tooling signals from root-level manifest and toolchain evidence (`pyproject.toml`, `.python-version`, `Cargo.toml`, `rust-toolchain*`, `go.mod`, `.golangci.*`) and surfaces them to session status as compact detected stack items
- **Bounded heuristic semantics** — code-surface collector reads a capped subset of source files (hard file/byte/time budgets) to derive endpoint/auth/data/integration hints with confidence and evidence
- **Immutable snapshots** — discovery results and profile resolution are snapshot-frozen per session before state persistence
- **Digest-linked** — session state carries SHA-256 `discoveryDigest` linking it to the exact discovery that produced it
- **Verification command planner** — session state surfaces `verificationCandidates`: repo-native, evidence-backed verification command candidates derived from detected stack + manifests (advisory only, never auto-executed)
- **Verification output contract** — `/plan` requires `## Verification Plan` with Source citation; `/implement` requires `## Verification Evidence` distinguishing Planned from Executed checks; `/review` checks for verificationCandidates vs generic command mismatches
- **Module-scoped stack facts** — nested manifests (`apps/*/`, `packages/*/`, `services/*/`, `crates/*/`) surface as `detectedStack.scopes` without affecting root facts. Ignores `examples/`, `fixtures/`, `docs/`, `scripts/`. Max 20 scopes, 25 items per scope.
- **External docs governance boundary** — version-specific external documentation is advisory Knowledge Packs only (provenance-stamped, non-SSOT, no mandate/schema override, no live-network dependency in mutating flows)

### Archive Hardening

- **Structured manifests** — every archive includes `archive-manifest.json` with session identity, file inventory, per-file digests, and content digest
- **SHA-256 file hash** — `.tar.gz.sha256` sidecar for external integrity verification (fatal on write failure in regulated mode)
- **Regulated archive completion guarantee** — clean regulated completion requires synchronous archive creation + verification success; `archiveStatus` field tracks lifecycle (`pending` → `verified` or `failed`)
- **11-check verification** — `verifyArchive()` validates manifest presence, file completeness, digest integrity, discovery consistency, state presence, and audit-chain integrity findings
- **Redacted export by default** — archive artifacts are export-redacted (`mode=basic`, `includeRaw=false`) while runtime/audit SSOT remains raw internally
- **Receipt export** — archives include `decision-receipts.redacted.v1.json` (and raw receipts only when explicitly opted in)
- **Manifest risk signaling** — manifest records redaction mode, raw inclusion, redacted artifacts, excluded raw artifacts, and `raw_export_enabled` when raw export is opt-in
- **Soft-check design** — missing discovery snapshots warn (not fail-hard) for backward compatibility with pre-discovery sessions

---

## How It Works

### 1. Bootstrap

Every governed session starts with explicit hydration:

```
/hydrate
```

The system establishes workspace binding (OpenCode session to git worktree via repository fingerprint), runs a 6-collector discovery pipeline (repo metadata, stack detection, topology analysis, surface detection, bounded code-surface analysis, domain signals), resolves the FlowGuard profile via repository signals and discovery results, creates an immutable policy snapshot, writes discovery and profile-resolution snapshots, and initializes canonical state in the workspace registry. If prerequisites are missing, execution **blocks** with a reason code.

### 2. Governed Command Surface

Twelve installed core FlowGuard commands cover workflow, diagnostics, and operations:

| Command            | Purpose                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/hydrate`         | Bootstrap FlowGuard session, bind workspace, resolve fingerprint, profile, and policy                          |
| `/status`          | Show current phase, blockers, evidence, context, and readiness projections                                      |
| `/ticket`          | Record the task description for FlowGuard tracking. Supports external references (Jira, ADO, GitHub) via URLs. |
| `/plan`            | Generate implementation plan with self-review loop. Converged plans display a **Plan Review Card**.            |
| `/architecture`    | Submit Architecture Decision Record with self-review loop. Converged ADRs display an **Architecture Review Card**. |
| `/review`          | Generate standalone compliance or content-aware review. Completed reviews display a **Review Report Card**.        |
| `/review-decision` | Record human verdict at User Gates (approve / changes_requested / reject)                                      |
| `/implement`       | Execute implementation, record evidence, run review loop                                                       |
| `/validate`        | Run validation checks (test quality, rollback safety)                                                          |
| `/architecture`    | Create or revise an Architecture Decision Record (ADR) with self-review loop (ID auto-generated)               |
| `/review`          | Start standalone compliance review flow. Supports PR URLs, branches, and commit references.                    |
| `/continue`        | Universal routing — do the next appropriate action for the current phase                                       |
| `/abort`           | Emergency session termination                                                                                  |
| `/archive`         | Archive a completed session as `.tar.gz`                                                                       |

Product commands (`/start`, `/task`, `/approve`, `/request-changes`, `/reject`, `/check`, `/export`, `/why`) provide a user-friendly facade that invokes canonical tools with pre-configured arguments. Review cards (Plan, Architecture, Review Report) are derived presentation artifacts injected into tool responses — `session-state.json` remains the SSOT.

Each command is tied to phase admissibility rules, evidence requirements, and state transitions.

### 3. Phase Workflow

The platform offers **three independent flows** starting from a shared READY entry point:

**Ticket Flow (Full Development Lifecycle):**

```
READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
```

**Architecture Flow (ADR Creation):**

```
READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
```

**Review Flow (Compliance Report):**

```
READY → REVIEW → REVIEW_COMPLETE
```

**User Gates** (human decision required): PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW.

**Independent Review Loops** (subagent-driven, mandatory): three reviewable
obligation types — `plan`, `architecture`, `implement` — share one orchestration
pipeline, one ReviewFindings schema, and one fail-closed strict-enforcement model
(F12 + F13 + P1.3). Each loop runs up to a per-mode iteration limit with
digest-stop convergence:

- **PLAN phase** — plan review loop (`obligationType: 'plan'`)
- **ARCHITECTURE phase** — ADR review loop (`obligationType: 'architecture'`)
  with ADR-specific criteria (Context completeness, Decision concreteness,
  Consequences honesty, MADR structure)
- **IMPL_REVIEW phase** — implementation review loop (`obligationType: 'implement'`)

The FlowGuard plugin deterministically invokes the `flowguard-reviewer` subagent
via the OpenCode SDK client (`session.create()` + `session.prompt()` with
`json_schema` structured output) — no LLM decision is involved for invocation.
Self-review is **never** accepted as review evidence in the current release;
strict orchestration failures BLOCK fail-closed.

Author and reviewer artifacts are stored separately (append-only). 4-level plugin
enforcement via `tool.execute.before/after` hooks physically blocks progression:

- **L1** (`SUBAGENT_REVIEW_NOT_INVOKED`) — binary gate: subagent must have been called
- **L2** (`SUBAGENT_SESSION_MISMATCH`) — `reviewedBy.sessionId` matches actual subagent session
- **L3** (`SUBAGENT_PROMPT_EMPTY`, `SUBAGENT_PROMPT_MISSING_CONTEXT`) — prompt integrity
- **L4** (`SUBAGENT_FINDINGS_VERDICT_MISMATCH`, `SUBAGENT_FINDINGS_ISSUES_MISMATCH`) — findings integrity

Each subagent call satisfies exactly one pending review obligation; the three
loop types each require their own subagent invocations. The reviewer's third
verdict `unable_to_review` consumes the obligation and BLOCKS via
`SUBAGENT_UNABLE_TO_REVIEW` (P1.3) instead of fabricating an `approve` or
`changes_requested`. See [docs/independent-review.md](./docs/independent-review.md).

**Backward Transitions**:

- `changes_requested` at PLAN_REVIEW -> back to PLAN
- `reject` at PLAN_REVIEW or EVIDENCE_REVIEW -> back to TICKET
- `changes_requested` at EVIDENCE_REVIEW -> back to IMPLEMENTATION
- `CHECK_FAILED` at VALIDATION -> back to PLAN (plan must be revised and re-approved)
- `changes_requested` at ARCH_REVIEW -> back to ARCHITECTURE
- `reject` at ARCH_REVIEW -> back to READY

**Every phase transition requires evidence.** The system computes whether progression is allowed.

### 4. Canonical State Model

The FlowGuard runtime maintains **canonical state** — a single JSON document, atomically persisted, Zod-validated on every write. It answers:

- Current phase and next allowed action
- Active profile and its rule content
- Evidence chain (ticket, plan with version history, validation results, implementation, review decisions)
- Policy snapshot (which rules governed this session, with SHA-256 hash for non-repudiation)
- Gate status and blockers (if any)

In controlled environments, "the system should probably continue" is not acceptable. The platform says either:

- **This is the next allowed action**, or
- **Execution is blocked, with a concrete reason and recovery guidance**

### 5. Pure State Machine

The FlowGuard core is a **pure, deterministic state machine**:

- **Topology**: Immutable transition table (`Phase x Event -> Phase`)
- **Guards**: Pure predicate functions (`(state) -> boolean`), first-match-wins evaluation
- **Evaluator**: Pure function (`(state, policy?) -> EvalResult`), no side effects
- **Commands**: Static admissibility map (`isCommandAllowed(phase, command)`)
- **Rails**: Thin orchestrators — validate, mutate state, evaluate, auto-advance. No I/O.

All side effects (persistence, git, LLM calls) live in the adapter layer, injected via executor interfaces.

---

## Deployment Profiles

### Solo

For individual engineers who want structured execution and complete work records without human approval gates. All gates auto-approve. **Default mode.**

### Team

For engineering teams needing repeatable planning, review visibility, and shared execution discipline. Human gates active, self-approval allowed.

### Team-CI

For CI/CD pipelines that require explicit automation semantics. Auto-approve is active only when CI context is detected; otherwise behavior degrades safely to Team (human-gated) with explicit reason `ci_context_missing`.

### Regulated

For organizations requiring controlled approvals, auditable decisions, retained evidence, and **four-eyes principle enforcement** (reviewer must differ from session initiator). Fail-closed on any ambiguity.

---

## Technology

### Architecture

| Property             | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Language**         | TypeScript (100%, zero-bridge)                                                        |
| **Runtime**          | OpenCode host runtime (process-injected)                                              |
| **State Validation** | Zod schemas, validated on every write                                                 |
| **Audit Integrity**  | SHA-256 hash chain, JSONL append-only                                                 |
| **Module System**    | ES2022 modules, NodeNext resolution (`module` + `moduleResolution`)                   |
| **Package**          | `@flowguard/core` (distributed via GitHub Releases as pre-built proprietary artifact) |

### Layer Architecture

| Layer                      | Responsibility                                                                                                                                           | Files                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **1. State Model**         | Zod schemas for all evidence types, phases, events                                                                                                       | `state/evidence.ts`, `state/schema.ts`                                          |
| **2. Machine**             | Pure transition table, guards, evaluator                                                                                                                 | `machine/topology.ts`, `guards.ts`, `commands.ts`, `evaluate.ts`                |
| **3. Rails**               | Thin orchestrators for each command                                                                                                                      | `rails/hydrate.ts`, `ticket.ts`, `plan.ts`, etc. (10 files)                     |
| **4. Adapters**            | I/O boundary (filesystem, git, workspace registry, OpenCode context)                                                                                     | `adapters/persistence.ts`, `workspace.ts`, `git.ts`, `binding.ts`, `context.ts` |
| **5. Config**              | Extension points, per-worktree config schema                                                                                                             | `config/policy.ts`, `profile.ts`, `reasons.ts`, `flowguard-config.ts`           |
| **6. Logging**             | Structured logging (logger interface + factories)                                                                                                        | `logging/logger.ts`                                                             |
| **7. Audit**               | Hash chain, query, summary, completeness matrix                                                                                                          | `audit/types.ts`, `integrity.ts`, `query.ts`, `summary.ts`, `completeness.ts`   |
| **8. Discovery**           | Repo discovery (6 collectors + orchestrator + Zod types)                                                                                                 | `discovery/collectors/*.ts`, `discovery/orchestrator.ts`, `discovery/types.ts`  |
| **9. Archive**             | Archive manifest types, verification                                                                                                                     | `archive/types.ts`                                                              |
| **10. Integration**        | OpenCode custom tools + plugin (thin wrappers)                                                                                                           | `integration/tools.ts`, `plugin.ts`, `index.ts`                                 |
| **11. CLI**                | Installer (install/uninstall/doctor)                                                                                                                     | `cli/install.ts`, `cli/templates.ts`                                            |
| **12. CLI (experimental)** | Headless wrappers: `flowguard run`, `flowguard serve` — for non-interactive CI/CD use. Not for production; use `opencode run`/`opencode serve` directly. | `cli/run.ts`                                                                    |

Dependencies flow **inward**: CLI -> Integration -> Adapters -> Rails -> Machine -> State. Discovery and Archive are peer layers used by Adapters and Integration. Logging is a cross-cutting utility available to the plugin layer. No circular dependencies.

### Distribution Model

FlowGuard uses **Option A1: Pre-built proprietary GitHub Release distribution** with installer-managed local runtime materialization.

1. **`flowguard-core-{version}.tgz`** — Pre-built npm pack output containing all business logic. Downloaded by operator from GitHub Releases (tag-driven publication; Releases page can be empty before first published tag).
2. **Local vendor materialization** — Installer materializes the release artifact into the local `vendor/` path and writes a `file:`-based dependency for offline resolution.
3. **No network fetches at runtime** — All dependencies resolved locally. Air-gapped compatible.
4. **Upgrade path** — Download new release, reinstall via `flowguard install --core-tarball ./flowguard-core-{new-version}.tgz`.
5. **Headless operation** — `flowguard run` and `flowguard serve` are experimental wrappers. In non-interactive execution, missing safety-critical input returns explicit `BLOCKED` outcomes (no follow-up question loop). For production, use OpenCode directly (`opencode run`, `opencode serve`).

### OpenCode Integration

- **11 Custom Tools** (`integration/tools/`) — bridge between LLM and state machine, installed as thin wrappers
- **11 Command Prompts** (`.opencode/commands/*.md`) — LLM-agnostic instructions with behavioral guards
- **1 Review Agent** (`.opencode/agents/flowguard-reviewer.md`) — hidden subagent for independent adversarial review (deployed when `selfReview.subagentEnabled`)
- **1 Audit Plugin** (`integration/plugin.ts`) — automatic event recording via `tool.execute.after` hook
- **`flowguard-mandates.md`** — managed artifact with SHA-256 content-digest, loaded via `instructions` in `opencode.json`
- **Profile Rules** — tech-stack-specific guidance delivered via tool returns, not file-based instructions

---

## Intended Use Cases

### Engineering teams adopting AI-assisted development

Adds structured phases, evidence gates, and audit trails to AI-assisted workflows. Useful when teams need to track what was planned, approved, and implemented rather than relying on unstructured chat history.

### Organizations with audit or compliance requirements

Provides hash-chained audit trails, four-eyes enforcement in regulated mode, explicit approval gates, and exportable session archives. These are building blocks for compliance workflows — they do not constitute compliance certification by themselves.

### Platform teams standardizing AI tool usage

Offers a policy-bound execution model with configurable deployment profiles (Solo, Team, Regulated). Profiles can be selected per-repository via auto-detection or explicit configuration.

---

## What We Are Not

- **Not** a replacement for source control, CI system, or ticket system
- **Not** a legal or compliance certification product by itself
- **Not** a generic chatbot front-end
- **Not** a promise that all AI-generated code is automatically correct
- **Not** tied to any specific LLM — works with Claude, GPT, Gemini, and any future model

The value is the **governed operating model around AI-assisted engineering**, not autonomous software delivery without oversight.

---

## Security Principles

### Repository Content Is Data, Not Authority

Repository files can inform FlowGuard rules, but they do not silently authorize behavior. **Policy authority comes from the FlowGuard runtime**, not from repo content.

### Fail-Closed by Default

Critical boundaries validate and fail closed:

- Missing evidence -> blocks progress
- Invalid state -> blocks progress
- Tampered audit artifacts -> blocks verification
- Ambiguous resolution -> fails rather than best-effort
- Unknown phase/event combination -> blocks (no silent fallthrough)

### Reason-Coded Blocking

When the platform cannot proceed, it emits explicit blocked outcomes with specific codes:

- `COMMAND_NOT_ALLOWED` — command not valid in current phase
- `MISSING_SESSION_ID` — no session context available
- `FOUR_EYES_ACTOR_MATCH` — regulated approve reviewer matches initiator
- `REGULATED_ACTOR_UNKNOWN` — regulated approve actor identity is unknown
- `DECISION_IDENTITY_REQUIRED` — regulated approve identity is missing
- `VALIDATION_INCOMPLETE` — not all checks passed
- `EMPTY_PLAN` — plan text is empty
- And 30+ more reason codes with recovery guidance

This gives operators and compliance stakeholders a concrete vocabulary for system behavior.

---

## Limitations and Caveats

- **Not a compliance certification.** FlowGuard provides building blocks for auditable workflows (hash chains, evidence gates, four-eyes enforcement). It does not certify compliance with any specific standard (MaRisk, BAIT, DORA, GoBD, BSI C5, SOC 2, ISO 27001, etc.). Organizations must assess whether FlowGuard's controls satisfy their specific requirements. FlowGuard supports compliance programs — it does not replace them.
- **LLM output quality is outside FlowGuard's scope.** FlowGuard governs the workflow around AI-assisted development. It does not validate, verify, or guarantee the correctness of LLM-generated code.
- **Workspace-local by design.** Sessions are bound to a filesystem workspace and individual OpenCode session. Enterprise multi-user coordination happens through customer-managed repositories, shared policy files, CI pipelines, and audit export. No built-in multi-user server deployment.
- **OpenCode-dependent.** FlowGuard requires OpenCode as its host runtime. It does not run standalone or integrate with other AI coding tools.
- **No pipeline orchestration.** FlowGuard provides CI-aware policy behavior (`team-ci`) but does not include pipeline orchestration, job management, or hosted control-plane services. Integration with external CI systems is via headless mode.
- **Archive verification is local.** Archive integrity checks (`verifyArchive()`) run locally. Release package provenance is separately attested via GitHub Release signatures, but session verification remains local.
- **Central policy distribution is baseline-only.** FlowGuard supports explicit central policy minimum enforcement via `FLOWGUARD_POLICY_PATH`, but it is not a full enterprise policy control plane (no admin UI, remote server, RBAC, or fleet management). See `docs/enterprise-readiness.md` and `docs/admin-model.md`.
- **Profile auto-detection is heuristic.** Tech-stack detection uses repository signals (pom.xml, package.json, etc.) and may misclassify non-standard layouts. Code-surface analysis adds bounded heuristics with confidence scores, not semantic truth. For deterministic behavior, explicit profile configuration is available.

---

## Product Facts

- **Version:** 1.2.0-rc.1
- **Language:** TypeScript (100%, zero-bridge architecture)
- **Distribution:** Pre-built proprietary release artifact (`flowguard-core-{version}.tgz`) via GitHub Releases
- **Release Integrity:** SHA-256 checksums + CycloneDX SBOM + GitHub provenance attestation
- **Phase Count:** 14 explicit workflow phases across 3 flows
- **Workflow Commands:** 10 (hydrate, ticket, plan, continue, implement, review-decision, validate, architecture, review, abort)
- **CLI Commands:** 5 (install, uninstall, doctor, run, serve)
- **Operational Tools:** 1 (archive — session export with integrity verification)
- **Custom Tools:** 11 OpenCode tool exports
- **Audit Events:** 5 structured kinds (transition, tool_call, error, lifecycle, decision)
- **Actor Assurance:** Three-tier source-labeled attribution (`env`/`git`/`claim`/`oidc` for source; `best_effort`/`claim_validated`/`idp_verified` for assurance), immutable per session; all modes default to `best_effort` — stronger thresholds require explicit `minimumActorAssuranceForApproval` config; enforcement at `/review-decision` only (Option B), `/hydrate` is diagnostic
- **Self-Review Iterations:** SOLO: 2 | TEAM/TEAM-CI/REGULATED: 3
- **Impl-Review Iterations:** SOLO: 1 | TEAM/TEAM-CI/REGULATED: 3
- **Policy Modes:** 4 (Solo [default], Team, Team-CI, Regulated)
- **Central Policy Source:** Optional explicit central minimum via `FLOWGUARD_POLICY_PATH` (file-based, fail-closed when configured)
- **Built-in Profiles:** 4 (Baseline, Java/Spring Boot, Angular/Nx, TypeScript/Node.js)
- **Discovery Collectors:** 6 (repo-metadata, stack-detection, topology, surface-detection, code-surface-analysis, domain-signals)
- **Archive Verification Checks:** 11 finding codes (including audit chain integrity)
- **Reason Codes:** 30+ with recovery guidance
- **Evidence Types:** 17 Zod schemas + 21 Discovery schemas
- **Compliance Mappings:** 5 (BSI C5, MaRisk, BAIT, DORA, GoBD)
- **Test Coverage:** Comprehensive test suite with mandatory 80% global coverage gate
- **Mutation Testing:** StrykerJS (v9.6.1) on 12 security-critical files across machine, rails, audit, config, and identity paths; CI enforces an 85% break threshold
- **API Reference:** TypeDoc-generated at [koeppben23.github.io/governed-runtime](https://koeppben23.github.io/governed-runtime/) (GitHub Pages)
- **Self-Hosted:** Runs locally — zero network calls from FlowGuard itself

---

## In One Sentence

The AI Engineering FlowGuard Platform makes AI-assisted software delivery usable in regulated and control-heavy environments by adding deterministic workflow control, explicit approvals, and audit-ready proof.

---

**Version:** 1.2.0-rc.1
_Architecture: TypeScript, OpenCode-native, Zero-Bridge_
_Distribution: Pre-built proprietary artifact (GitHub Releases)_
_Last Updated: 2026-04-27_
