# FlowGuard Architecture

## Layered Architecture

```mermaid
graph TD
  %% ── OpenCode Boundary (External) ──
  subgraph OpenCode["OpenCode Runtime"]
    Agent["AI Agent<br/>(Claude/GPT via OpenCode SDK)"]
    Hooks["Plugin Hooks<br/>(tool.execute.before/after)"]
    Tools["Tool Registry<br/>(flowguard tools)"]
  end

  %% ── Integration Layer ──
  subgraph Integration["Integration / Plugin Layer"]
    PluginEntry["Plugin Entry<br/>(src/integration/plugin.ts)"]
    Orchestrator["Review Orchestrator<br/>(subagent management)"]
    ToolExec["Tool Execution<br/>(hydrate, validate, etc.)"]
  end

  %% ── Rails (Governance) ──
  subgraph Rails["Governance Rails"]
    TicketRail["Ticket Rail"]
    PlanRail["Plan Rail<br/>(subagent-reviewed iteratively)"]
    ImpRail["Implement Rail<br/>(subagent-reviewed iteratively)"]
    ValRail["Validate Rail"]
    ContRail["Continue Rail"]
  end

  %% ── Policy & Identity ──
  subgraph Policy["Policy & Identity"]
    Config["Policy Config<br/>(flowguard.json, profiles)"]
    Reasons["Reason Registry<br/>(structured error codes)"]
    Tokens["IdP Tokens<br/>(P35a/b/c verification)"]
  end

  %% ── Machine ──
  Machine["State Machine<br/>(Phase × Event → Phase)"]

  %% ── State (SSOT) ──
  subgraph StateBox["State (SSOT)"]
    SSOT["session-state.json<br/>━━━ Single Source of Truth ━━━<br/>phase · evidence · review state"]
    EvidenceNode["Evidence Artifacts<br/>(append-only, content-addressed)"]
  end

  %% ── Audit & Archive ──
  subgraph AuditBox["Audit, Evidence & Proof Surfaces"]
    Audit["Audit Trail<br/>(hash-chain integrity)"]
    Completeness["Completeness<br/>(four-eyes principle)"]
    Archive["Evidence Export<br/>(artifacts/{id}.md + .json)"]
  end

  %% ── Proof Surfaces ──
  subgraph Proof["Proof / Presentation Surfaces"]
    Cards["Review Cards<br/>(Plan / ADR / Report)"]
    Status["Status Projection<br/>(flowguard_status)"]
  end

  %% ── Adapters ──
  Adapters["Adapters<br/>(Persistence, Workspace, Fingerprint)"]

  %% ── Logging ──
  Logging["Structured Logging<br/>(redact-safe PII filtering)"]

  %% ── CLI ──
  subgraph CLI["CLI"]
    Install["install"]
    Doctor["doctor"]
    Uninstall["uninstall"]
  end

  %% ── OpenCode ↔ FlowGuard Integration Boundary ──
  BoundaryLine["━━━ OpenCode / FlowGuard Integration Boundary ━━━"]:::boundary

  %% ── Connections ──
  Agent -->|tool calls| Hooks
  Hooks -->|intercept| PluginEntry
  PluginEntry -->|route| Orchestrator
  PluginEntry -->|route| ToolExec
  ToolExec -->|enforce| Rails
  Orchestrator -->|invoke| Agent
  BoundaryLine -.-> Hooks

  Rails -->|consult| Config
  Rails -->|query| Reasons
  Config -->|validate| Tokens
  Rails -->|transition| Machine
  Machine -->|read/write| SSOT

  SSOT -->|feed| EvidenceNode
  EvidenceNode -->|record| Audit
  Audit -->|hash-chain| Completeness
  SSOT -->|derive| Cards
  EvidenceNode -->|persist| Archive
  Cards -->|render| Status

  SSOT -->|persist via| Adapters
  SSOT -->|log via| Logging

  CLI -->|writes| Config
  CLI -->|reads via| Adapters

  %% ── Styles ──
  classDef boundary fill:none,stroke:#e90,stroke-width:2px,stroke-dasharray:5 5
```

## Three Governed Flows

From `READY`, three flows are available:

### 1. Ticket Flow (Full Development Lifecycle)

```
READY → TICKET → PLAN ⇄ PLAN_REVIEW → VALIDATION → IMPLEMENTATION ⇄ IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
```

- `/task` → `/plan` → `/approve` → `/check` → `/implement` → `/approve`
- Subagent review loops at PLAN and IMPLEMENTATION for iterative convergence
- User gates at PLAN_REVIEW, EVIDENCE_REVIEW (human approval required)
- Self-review never accepted as evidence — mandatory independent subagent attestation

### 2. Architecture Flow (ADR)

```
READY → ARCHITECTURE ⇄ ARCH_REVIEW → ARCH_COMPLETE
```

- `/architecture` → `/approve`
- MADR-format ADR with independent subagent review
- Fail-closed: `unable_to_review` verdict blocks at all layers

### 3. Review Flow (Standalone)

```
READY → REVIEW → REVIEW_COMPLETE
```

- `/review` — content-aware (PR, branch, text, URL)
- Obligation-bound: each `/review` creates a `ReviewObligation`

## Key Design Principles

- **Fail-closed:** Default deny. Every decision must be explicitly approved.
- **SSOT:** `session-state.json` is the single source of truth — no derived state acts as authority.
- **Hash-chain audit:** Every state transition is cryptographically linked; tampering is detectable.
- **Immutable artifacts:** Evidence is persisted as content-addressed files in `artifacts/`.
- **Presentation ≠ Authority:** Review cards and status output are derived views — never read back as runtime state.
