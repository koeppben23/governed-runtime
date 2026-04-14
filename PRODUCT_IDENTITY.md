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

- **8 explicit phases** from ticket intake through completion
- **Phase gates** that require evidence before progression
- **Computed next actions** — the system tells you exactly what is allowed, not guessed
- **Fail-closed enforcement** — execution blocks when evidence or state is invalid
- **Policy-aware evaluation** — every transition is checked against the active FlowGuard policy

### FlowGuard & Compliance

- **Three deployment profiles:** Solo (no human gates), Team (human gates, self-approval allowed), Regulated (human gates, four-eyes principle enforced)
- **Tech-stack-aware profiles:** Java/Spring Boot, Angular/Nx, TypeScript/Node.js, with auto-detection
- **Evidence completeness matrix** — deterministic per-slot evaluation of all evidence requirements
- **Reason-coded blocking** — every blocker has a specific error code, recovery guidance, and optional quick-fix

### Audit & Evidence

- **Hash-chained audit trail** — SHA-256 linked events, tamper-evident, JSONL append-only
- **Structured event kinds** — transition, tool_call, error, lifecycle events with typed details
- **Compliance summary generation** — automated 7-check compliance assessment from audit trail
- **Four-eyes principle verification** — initiator vs. reviewer identity tracked and enforced
- **Policy snapshot** — immutable, hashed copy of active policy frozen at session creation

### Enterprise Integration

- **OpenCode-native** — zero-bridge TypeScript architecture, runs in the same Bun runtime
- **Pipeline-ready** — headless mode via OpenCode SDK (`POST /session/:id/command`)
- **Profile auto-detection** — repository signals (pom.xml, angular.json, tsconfig.json) resolve the right profile
- **Extensible** — register custom profiles, reason codes, and check executors without modifying core code
- **Self-hosted** — no external dependencies, full data sovereignty

---

## How It Works

### 1. Bootstrap

Every governed session starts with explicit hydration:

```
/hydrate
```

The system establishes workspace binding (OpenCode session to git worktree), resolves the FlowGuard profile via repository signals, creates an immutable policy snapshot, and initializes canonical state. If prerequisites are missing, execution **blocks** with a reason code.

### 2. Governed Command Surface

Nine FlowGuard commands map to workflow phases:

| Command | Purpose |
|---------|---------|
| `/hydrate` | Bootstrap FlowGuard session, bind workspace, resolve profile and policy |
| `/ticket` | Record the task description for FlowGuard tracking |
| `/plan` | Generate implementation plan with self-review loop |
| `/review-decision` | Record human verdict at User Gates (approve / changes_requested / reject) |
| `/implement` | Execute implementation, record evidence, run review loop |
| `/validate` | Run validation checks (test quality, rollback safety) |
| `/continue` | Universal routing — do the next appropriate action for the current phase |
| `/review` | Read-only compliance report with evidence completeness matrix |
| `/abort` | Emergency session termination |

Each command is tied to phase admissibility rules, evidence requirements, and state transitions.

### 3. Phase Workflow

The platform moves work through **8 explicit phases** rather than allowing arbitrary jumps:

```
TICKET -> PLAN -> PLAN_REVIEW -> VALIDATION -> IMPLEMENTATION -> IMPL_REVIEW -> EVIDENCE_REVIEW -> COMPLETE
```

**User Gates** (human decision required): PLAN_REVIEW, EVIDENCE_REVIEW.

**Self-Review Loops**: PLAN phase has a self-review loop (max iterations from policy, digest-stop convergence). IMPL_REVIEW has an implementation review loop (same pattern).

**Backward Transitions**:
- `changes_requested` at PLAN_REVIEW -> back to PLAN
- `reject` at PLAN_REVIEW or EVIDENCE_REVIEW -> back to TICKET
- `changes_requested` at EVIDENCE_REVIEW -> back to IMPLEMENTATION
- `CHECK_FAILED` at VALIDATION -> back to PLAN (plan must be revised and re-approved)

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

### Regulated

For organizations requiring controlled approvals, auditable decisions, retained evidence, and **four-eyes principle enforcement** (reviewer must differ from session initiator). Fail-closed on any ambiguity.

---

## Technology

### Architecture

| Property | Value |
|----------|-------|
| **Language** | TypeScript (100%, zero-bridge) |
| **Runtime** | OpenCode / Bun (same process, no subprocess bridge) |
| **State Validation** | Zod schemas, validated on every write |
| **Audit Integrity** | SHA-256 hash chain, JSONL append-only |
| **Module System** | ES2022 modules, Bundler resolution |
| **Package** | Single npm package, one install, one version |

### Layer Architecture

| Layer | Responsibility | Files |
|-------|---------------|-------|
| **1. State Model** | Zod schemas for all evidence types, phases, events | `state/evidence.ts`, `state/schema.ts` |
| **2. Machine** | Pure transition table, guards, evaluator | `machine/topology.ts`, `guards.ts`, `commands.ts`, `evaluate.ts` |
| **3. Rails** | Thin orchestrators for each command | `rails/hydrate.ts`, `ticket.ts`, `plan.ts`, etc. (10 files) |
| **4. Adapters** | I/O boundary (filesystem, git, OpenCode context) | `adapters/persistence.ts`, `git.ts`, `binding.ts`, `context.ts` |
| **5. Integration** | OpenCode custom tools + plugin (thin wrappers) | `integration/tools.ts`, `plugin.ts`, `index.ts` |
| **6. Audit** | Hash chain, query, summary, completeness matrix | `audit/types.ts`, `integrity.ts`, `query.ts`, `summary.ts`, `completeness.ts` |
| **7. Config** | Extension points (profiles, policies, reason codes) | `config/policy.ts`, `profile.ts`, `reasons.ts` |
| **8. CLI** | Installer (install/uninstall/doctor) | `cli/install.ts`, `cli/templates.ts` |

Dependencies flow **inward**: CLI -> Integration -> Adapters -> Rails -> Machine -> State. No circular dependencies.

### Deployment Model

The platform uses an **installable package architecture**:

1. **`@flowguard/core` npm package** — contains all business logic (state machine, rails, adapters, audit, config, tools, plugin)
2. **Thin wrappers** — installed via CLI into `~/.config/opencode/` (global) or `.opencode/` (project), each ~15 lines, re-export from `@flowguard/core/integration`
3. **CLI installer** — `npx @flowguard/core install` writes wrappers, commands, package.json, opencode.json, and a managed `flowguard-mandates.md`. Idempotent, merge-aware, non-destructive. Never touches user-owned `AGENTS.md`.
4. **Global-first** — default installation target is `~/.config/opencode/`, making FlowGuard available across all projects without per-project setup

**Upgrade path:** `npm update @flowguard/core` upgrades all logic. Thin wrappers remain stable across versions.

### OpenCode Integration

- **9 Custom Tools** (`integration/tools.ts`) — bridge between LLM and state machine, installed as thin wrappers
- **9 Command Prompts** (`.opencode/commands/*.md`) — LLM-agnostic instructions with behavioral guards
- **1 Audit Plugin** (`integration/plugin.ts`) — automatic event recording via `tool.execute.after` hook
- **`flowguard-mandates.md`** — managed artifact with SHA-256 content-digest, loaded via `instructions` in `opencode.json`
- **Profile Rules** — tech-stack-specific guidance delivered via tool returns, not file-based instructions

---

## Why Enterprise Teams Choose This

### For Engineering Leadership

Standardize how AI work is initiated, planned, approved, implemented, and evidenced. Reduce the operational risk of chat-driven coding through explicit workflow phases, policy-bound transitions, and review gates.

### For Platform & Compliance Teams

Get a concrete control plane instead of vague assurances. Inspect active policy and profile selection, evidence completeness matrix, hash-chained audit trails, four-eyes enforcement status, and reason-coded blocked decisions.

### For Regulated Industries

Answer control expectations around **traceability**, **integrity verification** (hash chain), **explicit approval points** (User Gates), **separation of concerns** (pure machine vs. I/O), **exportability** (JSONL audit trail), **retention** (immutable evidence), and **fail-closed handling** (reason-coded blocking).

---

## What We Are Not

- **Not** a replacement for source control, CI system, or ticket system
- **Not** a legal or compliance certification product by itself
- **Not** a generic chatbot front-end
- **Not** a promise that all AI-generated code is automatically correct
- **Not** tied to any specific LLM — works with Claude, GPT, Gemini, and any future model

The value is the **governed operating model around AI-assisted engineering**, not autonomous software delivery without oversight.

---

## Competitive Differentiation

| Capability | Traditional AI Tools | This Platform |
|------------|---------------------|---------------|
| Workflow phases | None | 8 explicit phases with evidence gates |
| Evidence requirements | Implicit | Explicit, per-slot completeness matrix |
| Audit trail | Chat history only | Hash-chained, tamper-evident, exportable |
| Next action computation | Heuristic | Deterministic (pure state machine) |
| Blocking behavior | Silent failure | Reason-coded with recovery guidance |
| Policy profiles | None | Solo / Team / Regulated with four-eyes |
| Tech-stack awareness | None | Auto-detected profiles (Java, Angular, TS) |
| LLM coupling | Model-specific | LLM-agnostic (any model, any provider) |
| Runtime architecture | Subprocess bridge | Zero-bridge (same process) |

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
- `FOUR_EYES_VIOLATION` — reviewer same as initiator in regulated mode
- `VALIDATION_INCOMPLETE` — not all checks passed
- `EMPTY_PLAN` — plan text is empty
- And 30+ more reason codes with recovery guidance

This gives operators and compliance stakeholders a concrete vocabulary for system behavior.

---

## Product Facts

- **Version:** 1.1.0
- **Language:** TypeScript (100%, zero-bridge architecture)
- **Architecture:** Installable package (`@flowguard/core`) with thin wrappers
- **Phase Count:** 8 explicit workflow phases
- **Command Surface:** 9 FlowGuard commands
- **Custom Tools:** 9 OpenCode tool exports (via `@flowguard/core/integration`)
- **Audit Events:** 4 structured kinds (transition, tool_call, error, lifecycle)
- **Policy Modes:** 3 (Solo [default], Team, Regulated)
- **Built-in Profiles:** 4 (Baseline, Java/Spring Boot, Angular/Nx, TypeScript/Node.js)
- **Reason Codes:** 30+ with recovery guidance
- **Evidence Types:** 17 Zod schemas
- **Test Coverage:** 555 tests across 15 test files, 5 mandatory categories
- **Self-Hosted:** No external dependencies, full data sovereignty

---

## In One Sentence

The AI Engineering FlowGuard Platform makes AI-assisted software delivery usable in regulated and control-heavy environments by adding deterministic workflow control, explicit approvals, and audit-ready proof.

---

*Version: 1.1.0*
*Architecture: TypeScript, OpenCode-native, Zero-Bridge*
*Last Updated: 2026-04-14*
