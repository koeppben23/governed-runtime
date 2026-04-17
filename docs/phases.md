# Phases

FlowGuard uses 14 explicit workflow phases across 3 independent flows. Every session starts at the **READY** phase after `/hydrate`.

## Flows

### Ticket Flow (Full Development Lifecycle)

```
READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
```

### Architecture Flow (ADR Creation)

```
READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
```

### Review Flow (Compliance Report)

```
READY → REVIEW → REVIEW_COMPLETE
```

## Flow Diagram

```
                              ┌──────────┐
                              │ /hydrate │
                              └────┬─────┘
                                   │
                                   ▼
                              ┌──────────┐
                              │  READY   │  ◄── Command-driven (no guards)
                              └──┬──┬──┬─┘
                   ┌─────────────┘  │  └─────────────┐
                   │                │                 │
              /ticket          /architecture       /review
                   │                │                 │
    ═══════════════╪════════   ════╪════════════   ══╪══════════════
    TICKET FLOW    │          ARCH FLOW    │     REVIEW FLOW   │
    ═══════════════╪════════   ════╪════════════   ══╪══════════════
                   ▼                ▼                 ▼
              ┌──────────┐    ┌──────────────┐   ┌──────────┐
              │  TICKET  │    │ ARCHITECTURE │   │  REVIEW  │
              └────┬─────┘    └──────┬───────┘   └────┬─────┘
                   │  auto           │  self-review    │  auto
                   ▼                 ▼  loop           ▼
              ┌──────────┐    ┌──────────────┐   ┌────────────────┐
              │   PLAN   │◄┐  │ ARCH_REVIEW  │   │REVIEW_COMPLETE │ ■
              └────┬─────┘ │  └──┬───┬───┬───┘   └────────────────┘
         self-     │       │     │   │   │
         review    ▼       │     │   │   │ reject
         loop ┌────────────┐     │   │   └──────► (READY)
              │PLAN_REVIEW │     │   │
              └─┬───┬───┬──┘     │   │ changes_requested
                │   │   │        │   └──────► (ARCHITECTURE)
                │   │   │        │
     approve    │   │   │ reject │ approve
                │   │   └──► (TICKET)
                │   │                       ▼
     changes_   │   │               ┌───────────────┐
     requested  │   │               │ ARCH_COMPLETE  │ ■
        ▼       │   │               └───────────────┘
      (PLAN)    │   │                 ADR "accepted"
                │   │                 MADR written
                ▼   │
           ┌────────────┐
           │ VALIDATION │
           └──┬─────┬───┘
              │     │
    ALL_PASSED│     │CHECK_FAILED
              │     └──► (PLAN)
              ▼
      ┌────────────────┐
      │IMPLEMENTATION  │
      └───────┬────────┘
              │  auto
              ▼
      ┌────────────────┐
      │  IMPL_REVIEW   │ ◄── self-review loop
      └───────┬────────┘
              │  auto (converged)
              ▼
      ┌────────────────┐
      │EVIDENCE_REVIEW │
      └─┬─────┬────┬───┘
        │     │    │
approve │     │    │ reject
        │     │    └──► (TICKET)
        │     │
        │  changes_requested
        │     └──► (IMPLEMENTATION)
        ▼
   ┌──────────┐
   │ COMPLETE  │ ■
   └──────────┘
```

| Symbol             | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `■`                | Terminal phase (session complete, `/archive` available)           |
| `◄` / `►`          | Backward transition (changes_requested / reject / CHECK_FAILED)   |
| `self-review loop` | LLM reviews own output iteratively (digest-stop / max iterations) |
| `auto`             | Automatic transition without user intervention                    |

## Phase Reference

### Shared Entry Point

| Phase | Description                             | Gate Type      |
| ----- | --------------------------------------- | -------------- |
| READY | Post-hydrate entry point, choose a flow | Command-driven |

### Ticket Flow

| Phase           | Description                 | Gate Type               |
| --------------- | --------------------------- | ----------------------- |
| TICKET          | Record task description     | Automatic               |
| PLAN            | Generate plan + self-review | Automatic (self-review) |
| PLAN_REVIEW     | Human approves plan         | **User Gate**           |
| VALIDATION      | Run validation checks       | Automatic               |
| IMPLEMENTATION  | Execute plan                | Automatic               |
| IMPL_REVIEW     | LLM reviews implementation  | Automatic (self-review) |
| EVIDENCE_REVIEW | Human reviews evidence      | **User Gate**           |
| COMPLETE        | Session complete            | Terminal                |

### Architecture Flow

| Phase         | Description              | Gate Type               |
| ------------- | ------------------------ | ----------------------- |
| ARCHITECTURE  | Create ADR + self-review | Automatic (self-review) |
| ARCH_REVIEW   | Human reviews ADR        | **User Gate**           |
| ARCH_COMPLETE | ADR accepted             | Terminal                |

### Review Flow

| Phase           | Description                | Gate Type |
| --------------- | -------------------------- | --------- |
| REVIEW          | Generate compliance report | Automatic |
| REVIEW_COMPLETE | Report delivered           | Terminal  |

## Gate Types

### Command-Driven (READY)

- User selects a flow via command (`/ticket`, `/architecture`, `/review`)
- No guards — evaluator returns `pending` until a command is issued

### Automatic Gates

- No human intervention required
- Machine evaluates state and advances
- Examples: TICKET → PLAN, VALIDATION → IMPLEMENTATION

### Self-Review Gates

- LLM reviews its own output iteratively
- Convergence via digest-stop (output unchanged) or max iterations from policy
- Examples: PLAN, IMPL_REVIEW, ARCHITECTURE

### User Gates

- Require explicit human approval via `/review-decision`
- Four-eyes principle in regulated mode (reviewer must differ from session initiator)
- Examples: PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW

## Phase Details

### READY

**Entry:** `/hydrate`
**Exit:** `/ticket`, `/architecture`, or `/review`

Post-hydrate entry point. The system provides guidance on available flows. User selects a flow by issuing the corresponding command.

### TICKET

**Entry:** `/ticket` from READY
**Exit:** Automatic (advances to PLAN when ticket evidence is recorded)

Records the task description. Validates that the task is clear and actionable.

### PLAN

**Entry:** From TICKET
**Exit:** Automatic (self-review convergence advances to PLAN_REVIEW)

Generates an implementation plan with built-in self-review. The AI critically reviews its own plan and refines it until convergence.

### PLAN_REVIEW

**Entry:** Automatic from PLAN (self-review converged)
**Exit:** `/review-decision`

Human reviews and approves the plan before implementation begins. In regulated mode, a second person must review.

- `approve` → VALIDATION
- `changes_requested` → back to PLAN
- `reject` → back to TICKET

### VALIDATION

**Entry:** `/review-decision approve` from PLAN_REVIEW
**Exit:** Automatic (all checks passed → IMPLEMENTATION, any check failed → back to PLAN)

Runs automated validation checks defined by the active profile. All checks must pass to proceed.
Use `/validate` to run the checks.

### IMPLEMENTATION

**Entry:** Automatic from VALIDATION (all checks passed)
**Exit:** Automatic (auto-advances to IMPL_REVIEW)

AI implements the plan using OpenCode tools. Changed files are automatically tracked via git.
Use `/implement` to record evidence and auto-advance.

### IMPL_REVIEW

**Entry:** Automatic from IMPLEMENTATION (after `/implement`)
**Exit:** Automatic (review convergence)

LLM reviews the implementation against the plan. This is a self-review loop (similar to PLAN phase),
not a human gate. The LLM calls `flowguard_implement` with a `reviewVerdict` to record each iteration.
On convergence, auto-advances to EVIDENCE_REVIEW.

### EVIDENCE_REVIEW

**Entry:** Automatic from IMPL_REVIEW (review converged)
**Exit:** `/review-decision`

Final human review of all evidence before completion.

- `approve` → COMPLETE
- `changes_requested` → back to IMPLEMENTATION
- `reject` → back to TICKET

### COMPLETE

**Entry:** Automatic after EVIDENCE_REVIEW approval
**Exit:** Terminal

Ticket flow complete. Can be archived with `/archive`.

### ARCHITECTURE

**Entry:** `/architecture` from READY (or re-entry after `changes_requested` at ARCH_REVIEW)
**Exit:** Automatic (self-review convergence advances to ARCH_REVIEW)

Creates an Architecture Decision Record (ADR) in MADR format. The ADR must include `## Context`, `## Decision`, and `## Consequences` sections. Self-review loop refines the ADR until convergence.

### ARCH_REVIEW

**Entry:** Automatic from ARCHITECTURE (self-review converged)
**Exit:** `/review-decision`

Human reviews the ADR.

- `approve` → ARCH_COMPLETE (ADR status set to "accepted")
- `changes_requested` → back to ARCHITECTURE
- `reject` → back to READY

### ARCH_COMPLETE

**Entry:** Automatic after ARCH_REVIEW approval
**Exit:** Terminal

Architecture flow complete. ADR is accepted. MADR artifact is written. Can be archived with `/archive`.

### REVIEW

**Entry:** `/review` from READY
**Exit:** Automatic (report generation advances to REVIEW_COMPLETE)

Generates a compliance review report with evidence completeness matrix, four-eyes status, validation summary, and findings.

### REVIEW_COMPLETE

**Entry:** Automatic from REVIEW (report generated)
**Exit:** Terminal

Review flow complete. Report delivered. Can be archived with `/archive`.
