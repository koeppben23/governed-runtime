# FlowGuard Architecture

## Conceptual Architecture

**Runtime flow and module direction.** Arrows show runtime flow; where the
arrow connects two governed modules it follows the allowed dependency
direction. The single authority for module directions is
[`MODULE_DEPENDENCY_POLICY`](../../src/architecture/support/module-dependency-policy.ts)
(observed edges must equal the declared policy exactly); this diagram neither
defines nor widens it.

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
    Activation["Governance Activation<br/>(explicit /start or authorized autonomous StartGovernance)"]
    ReviewPipeline["Review Pipeline<br/>(native subagent dispatch · durable dispatch lineage)"]
    ReviewCapture["Review Capture & Evidence Binding<br/>(child identity · terminal capture · recovery)"]
    ToolExec["Tool Execution<br/>(workflow commands and checks)"]
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
  subgraph StateBox["State (separate authorities)"]
    SSOT["session-state.json<br/>━━━ workflow-state SSOT ━━━<br/>phase · evidence · review state"]
    ActivationStore["Host activation store<br/>append-only revisions · atomic head · permanent enrollment<br/>━━━ activation authority ━━━"]
    EvidenceNode["Evidence Artifacts<br/>(append-only, content-addressed)"]
  end

  %% ── Audit & Archive ──
  subgraph AuditBox["Audit, Evidence & Proof Surfaces"]
    Audit["Audit Trail<br/>(hash-chain integrity)"]
    Completeness["Completeness<br/>(four-eyes principle)"]
    Archive["Evidence Archive<br/>(packaging + verification)"]
  end

  %% ── Proof Surfaces ──
  subgraph Proof["Proof / Presentation Surfaces"]
    Cards["Review Cards<br/>(Plan / ADR / Report)"]
    Status["Status Projection<br/>(flowguard_status)"]
  end

  %% ── Adapters ──
  Adapters["Adapters<br/>(persistence, workspace, git, host, actor)"]

  %% ── Logging ──
  Logging["Structured Logging<br/>(redact-safe PII filtering)"]

  %% ── CLI ──
  subgraph CLI["CLI"]
    Install["install"]
    Doctor["doctor"]
    Uninstall["uninstall"]
    Run["run"]
    Serve["serve"]
    Inspect["inspect"]
  end

  %% ── OpenCode ↔ FlowGuard Integration Boundary ──
  BoundaryLine["━━━ OpenCode / FlowGuard Integration Boundary ━━━"]:::boundary

  %% ── Connections ──
  Agent -->|tool calls| Hooks
  Tools -->|tool.execute.before| Hooks
  Hooks -->|intercept| PluginEntry
  PluginEntry -->|activate| Activation
  PluginEntry -->|route| ReviewPipeline
  PluginEntry -->|route| ToolExec
  ToolExec -->|enforce| Rails
  Activation -->|commit/read| ActivationStore
  ReviewPipeline -->|invoke native reviewer| Agent
  ReviewPipeline -->|capture| ReviewCapture
  ReviewPipeline -.->|recover| ReviewCapture
  ReviewCapture -->|bind review evidence| EvidenceNode
  BoundaryLine -.-> Hooks

  Rails -->|consult| Config
  Rails -->|query| Reasons
  Config -->|validate| Tokens
  Rails -->|transition| Machine
  Machine -->|read/write| SSOT

  SSOT -->|feed| EvidenceNode
  Audit -->|read evidence| SSOT
  Audit -->|hash-chain| Completeness
  Cards -->|read| SSOT
  Adapters -->|package| Archive
  Cards -->|render| Status

  Adapters -->|persist| SSOT
  Adapters -->|log via| Logging

  CLI -->|writes| Config
  CLI -->|reads via| Adapters

  %% ── Styles ──
  classDef boundary fill:none,stroke:#e90,stroke-width:2px,stroke-dasharray:5 5
```

Activation is committed through the host-storage journal before workflow READY;
it selects the governed session scope but never writes workflow phase, evidence
or review state. The review pipeline's durable dispatch, child capture and
evidence binding are likewise separate from activation authority.

## Three Governed Flows

From `READY`, three flows are available:

### 1. Ticket Flow (Full Development Lifecycle)

```
READY → TICKET → PLAN ⇄ PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_VALIDATION (automatic post-implementation checks; failure returns to IMPLEMENTATION) ⇄ IMPL_REVIEW → EVIDENCE_REVIEW → EXPORT_READY → COMPLETE
```

- `/task` → `/plan` → `/approve` → `/implement` (automatically runs active checks) → `/approve` → `/export`
- `/check` is a manual compatibility and recovery command, not part of the happy path.
- Subagent review loops at PLAN and IMPLEMENTATION for iterative convergence
- Approval gates at PLAN_REVIEW and EVIDENCE_REVIEW. The frozen policy selects
  the admissible authority: an explicit operator decision where required, or an
  authorized `autonomous` decision in policy modes that permit it. The command
  channel does not prove human provenance.
- Self-review never accepted as evidence — mandatory independent subagent attestation

### 2. Architecture Flow (ADR)

```
READY → ARCHITECTURE ⇄ ARCH_REVIEW → ARCH_COMPLETE
```

- `/architecture` → `/approve`
- MADR-format ADR with independent subagent review
- Fail-closed: `unable_to_review` verdict blocks at all layers

### 3. Peer Review Flow

```
READY → PEER_REVIEW → PEER_REVIEW_COMPLETE
```

- `/review` — content-aware (PR, branch, text, URL)
- Obligation-bound: each `/review` creates a `ReviewObligation`

## Key Design Principles

- **Fail-closed:** Default deny. Every decision must be explicitly approved.
- **Workflow-state SSOT:** `session-state.json` is the single source of truth for
  workflow phase, evidence and review state; no derived projection acts as
  authority. Activation is a separate authority: the host-storage journal,
  atomic head and permanent enrollment, never inferred from workflow files.
- **Review lineage:** native reviewer dispatch is bound to durable dispatch,
  child identity, terminal capture and evidence binding; a failed or incomplete
  capture cannot become review evidence.
- **Hash-chain audit:** Every state transition is cryptographically linked; tampering is detectable.
- **Immutable artifacts:** Evidence is persisted as content-addressed files in `artifacts/`.
- **Presentation ≠ Authority:** Review cards and status output are derived views — never read back as runtime state.
