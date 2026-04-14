# FlowGuard for OpenCode

Deterministic, fail-closed FlowGuard workflow for AI-assisted software delivery.
Adds explicit phases, evidence gates, audit trails, and policy enforcement to OpenCode.

> **Status:** v1.1.0 | TypeScript | OpenCode-native | Installable Package Architecture

---

## Quick Start

### 1. Install

```bash
# Global installation (recommended) — available in all OpenCode sessions
npx @flowguard/core install

# Project-local installation — only in this repository
npx @flowguard/core install --install-scope repo
```

The CLI installer writes thin wrappers (re-exports from `@flowguard/core`) and
a managed `flowguard-mandates.md` into the OpenCode config directory. All business
logic lives in the npm package — `npm update @flowguard/core` is all that's needed
for upgrades.

**Targets:**
- `--install-scope global` (default): `~/.config/opencode/` — works across all projects
- `--install-scope repo`: `./.opencode/` + `./opencode.json` — project-scoped

**Policy mode:**
- `--policy-mode solo` (default), `--policy-mode team`, `--policy-mode regulated`

> Deprecated aliases `--global`, `--project`, and `--mode` still work but emit warnings.

**Verify installation:**
```bash
npx @flowguard/core doctor
```

### 2. Start a Governed Session

```
/hydrate
```

This bootstraps a FlowGuard session: binds your OpenCode session to the git worktree,
auto-detects your tech stack (Java, Angular, TypeScript), resolves the FlowGuard policy,
and initializes canonical state at `.flowguard/session-state.json`.

### 3. Follow the Workflow

```
/ticket <describe the task>
/plan
/review-decision approve
/validate
/implement
/review-decision approve
```

The system guides you through each phase. Run `/continue` at any point to see what's next.

---

## Commands

All commands are available as `/command` in OpenCode chat.

### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

- **Creates**: Session state at `.flowguard/session-state.json`
- **Resolves**: Profile (auto-detect from repo), Policy (solo/team/regulated), Binding (session <-> worktree)
- **Arguments**: Optional `policyMode` (solo, team, regulated). Default: solo. If omitted, falls back to `policy.defaultMode` from `.flowguard/config.json` (if set), then to the built-in default.

### /ticket

Record the task description. Required before planning.

- **Phase**: TICKET
- **Arguments**: Task description text (required)
- **Advances to**: PLAN (after evaluation)

### /plan

Generate an implementation plan with self-review loop.

1. LLM generates plan text
2. Plan is recorded, self-review loop starts
3. LLM reviews plan critically, revises if needed
4. Loop runs up to `maxSelfReviewIterations` (from policy) or until convergence
5. On convergence: auto-advances to PLAN_REVIEW

### /review-decision

Record a human verdict at a User Gate (PLAN_REVIEW or EVIDENCE_REVIEW).

- **Verdicts**: `approve` | `changes_requested` | `reject`
- `approve` -> advance to next phase
- `changes_requested` -> return to previous work phase (PLAN or IMPLEMENTATION)
- `reject` -> restart from TICKET
- **Four-eyes**: In regulated mode, reviewer must differ from session initiator

### /validate

Run validation checks against the approved plan.

- **Phase**: VALIDATION
- **Checks**: Defined by the active profile (default: `test_quality`, `rollback_safety`)
- **ALL_PASSED** -> advance to IMPLEMENTATION
- **CHECK_FAILED** -> return to PLAN (plan must be revised and re-approved)

### /implement

Execute the implementation plan, then review.

1. LLM implements the plan using OpenCode's built-in tools (read, write, bash)
2. LLM calls FlowGuard tool to record changed files (auto-detected via git)
3. Auto-advances to IMPL_REVIEW
4. LLM reviews implementation, approves or requests changes
5. Loop runs up to `maxImplReviewIterations` (from policy) or until convergence
6. On convergence: auto-advances to EVIDENCE_REVIEW

### /continue

Universal routing command. Inspects current phase and does the next appropriate action.
Use when you're unsure what to do next.

### /review

Generate a standalone compliance report. Read-only, does not mutate state.
Writes report to `.flowguard/review-report.json`.

Includes: evidence completeness matrix, four-eyes status, validation summary, findings.

### /abort

Emergency session termination. Sets phase to COMPLETE with ABORTED marker. Irreversible.

---

## Phases

```
TICKET -> PLAN -> PLAN_REVIEW -> VALIDATION -> IMPLEMENTATION -> IMPL_REVIEW -> EVIDENCE_REVIEW -> COMPLETE
```

| Phase | Description | Gate Type |
|-------|-------------|-----------|
| TICKET | Record task description | Automatic |
| PLAN | Generate plan + self-review loop | Automatic (self-review) |
| PLAN_REVIEW | Human approves plan | **User Gate** |
| VALIDATION | Run validation checks | Automatic |
| IMPLEMENTATION | Execute plan, make code changes | Automatic |
| IMPL_REVIEW | Review implementation loop | Automatic (review loop) |
| EVIDENCE_REVIEW | Human approves evidence | **User Gate** |
| COMPLETE | Session finished | Terminal |

**User Gates** are the only phases that require human interaction.
In Solo mode, gates auto-approve. In Team/Regulated mode, a human must decide.

---

## Policies

Three FlowGuard policies control strictness:

| Policy | Human Gates | Four-Eyes | Self-Review Max | Impl Review Max |
|--------|------------|-----------|-----------------|-----------------|
| **Solo** | Disabled (auto-approve) | No | 1 | 1 |
| **Team** | Enabled | No | 3 | 3 |
| **Regulated** | Enabled | Yes (enforced) | 3 | 3 |

Set the policy during hydration: `/hydrate` defaults to `solo`.

---

## Profiles

Profiles provide tech-stack-specific guidance. Auto-detected from repository signals.

| Profile | ID | Detects | Confidence |
|---------|-----|---------|-----------|
| Baseline | `baseline` | Always (fallback) | 0.1 |
| TypeScript | `typescript` | `tsconfig.json` | 0.7 |
| Java / Spring Boot | `backend-java` | `pom.xml`, `build.gradle` | 0.8 |
| Angular / Nx | `frontend-angular` | `angular.json`, `nx.json` | 0.85 |

Highest confidence wins. Angular > Java > TypeScript > Baseline.

Profile rules are injected into LLM context via `flowguard_status` tool responses.
This means the LLM automatically receives tech-stack-specific coding conventions,
naming rules, architecture patterns, testing requirements, and anti-pattern lists.

### Custom Profiles

Register your own profile:

```typescript
import { defaultProfileRegistry } from "@flowguard/core";

defaultProfileRegistry.register({
  id: "my-stack",
  name: "My Custom Stack",
  activeChecks: ["test_quality", "rollback_safety"],
  checks: new Map(), // use baseline check executors
  detect: (signals) => signals.configFiles.includes("my-config.json") ? 0.9 : 0,
  instructions: "Your LLM guidance text here...",
});
```

---

## Audit Trail

Every state transition and tool call is recorded in `.flowguard/audit.jsonl`.

### Event Kinds

| Kind | Example | Description |
|------|---------|-------------|
| `transition` | `transition:PLAN_READY` | State machine transition |
| `tool_call` | `tool_call:flowguard_plan` | FlowGuard tool invocation |
| `error` | `error:TOOL_ERROR` | Tool or system error |
| `lifecycle` | `lifecycle:session_created` | Session lifecycle event |

### Hash Chain Integrity

Each event includes `prevHash` and `chainHash` (SHA-256). Modifying, inserting, or deleting
any event breaks the chain. Verify:

```typescript
import { verifyChain } from "@flowguard/core";

const { valid, firstBreak, verifiedCount } = verifyChain(events);
```

### Compliance Summary

Automated 7-check compliance assessment:

1. `session_created` — properly initialized?
2. `session_terminated` — reached terminal state?
3. `no_unresolved_errors` — all errors resolved?
4. `plan_review_honored` — human reviewed plan?
5. `evidence_review_honored` — human reviewed evidence?
6. `validation_executed` — checks actually run?
7. `chain_integrity` — hash chain intact?

---

## Configuration

FlowGuard supports per-worktree configuration via `.flowguard/config.json`. The file is optional — when absent, all built-in defaults apply.

### Config File Location

```
{worktree}/.flowguard/config.json
```

### Schema

```json
{
  "schemaVersion": "v1",
  "logging": {
    "level": "info"
  },
  "policy": {
    "defaultMode": "solo",
    "maxSelfReviewIterations": 3,
    "maxImplReviewIterations": 3
  },
  "profile": {
    "defaultId": "typescript",
    "activeChecks": ["test_quality", "rollback_safety"]
  }
}
```

| Section | Field | Type | Default | Description |
|---------|-------|------|---------|-------------|
| `logging` | `level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"` | `"info"` | Minimum log level. Messages below this are suppressed. |
| `policy` | `defaultMode` | `"solo"` \| `"team"` \| `"regulated"` | *(none)* | Default policy mode when `/hydrate` is called without explicit mode. |
| `policy` | `maxSelfReviewIterations` | integer 1–10 | *(from policy preset)* | Override max self-review iterations (PLAN phase). |
| `policy` | `maxImplReviewIterations` | integer 1–10 | *(from policy preset)* | Override max implementation review iterations. |
| `profile` | `defaultId` | string | *(none)* | Default profile ID when `/hydrate` is called without explicit profile. |
| `profile` | `activeChecks` | string[] | *(none)* | Override the set of active validation checks. |

### Priority Chain

Tool arguments > Config file > Policy preset > Built-in defaults

### Logging

FlowGuard uses structured logging that maps to the OpenCode SDK's `client.app.log()` API. The plugin is the only log writer — tools and rails do not log.

Log levels: `debug`, `info`, `warn`, `error`, `silent`.

Each log entry carries: `level`, `service` (caller identity), `message`, and optional `extra` (structured metadata). The `silent` level suppresses all output.

### Doctor Check

`npx @flowguard/core doctor` validates the config file as its 7th check:
- Missing file: OK (defaults apply)
- Valid file: parsed and reported
- Invalid file: error with details

---

## File Structure

```
your-project/
├── .flowguard/                    # Runtime artifacts (auto-created)
│   ├── session-state.json          # Canonical state (Zod-validated, atomic writes)
│   ├── review-report.json          # Latest compliance report
│   ├── audit.jsonl                 # Append-only hash-chained audit trail
│   └── config.json                 # Per-worktree configuration (optional, Zod-validated)
├── .opencode/                      # OpenCode integration (or ~/.config/opencode/ for global)
│   ├── package.json                # Plugin dependencies (includes @flowguard/core)
│   ├── flowguard-mandates.md      # Managed artifact — FlowGuard mandates (SHA-256 digest-tracked)
│   ├── tools/flowguard.ts         # Thin wrapper → re-exports 9 tools from @flowguard/core
│   ├── commands/*.md               # 9 command prompts
│   └── plugins/flowguard-audit.ts # Thin wrapper → re-exports plugin from @flowguard/core
├── AGENTS.md                       # User/project rules (OpenCode auto-loads, NEVER touched by installer)
├── opencode.json                   # OpenCode configuration (instructions reference flowguard-mandates.md)
└── src/                            # @flowguard/core package source
    ├── state/                      # Layer 1: Zod schemas
    ├── machine/                    # Layer 2: Pure state machine
    ├── rails/                      # Layer 3: Command orchestrators
    ├── adapters/                   # Layer 4: I/O boundary (state, config, audit, git)
    ├── config/                     # Layer 5: Extension points (profiles, policies, reasons, config schema)
    ├── logging/                    # Layer 5b: Structured logging (logger interface + factories)
    ├── audit/                      # Layer 6: Audit subsystem
    ├── integration/                # Layer 7: OpenCode tools + plugin (9 tools, 1 plugin)
    └── cli/                        # CLI installer (install/uninstall/doctor)
```

---

## Error Handling

All errors are reason-coded with structured responses:

```json
{
  "error": true,
  "code": "COMMAND_NOT_ALLOWED",
  "message": "/plan is not allowed in phase COMPLETE.",
  "recovery": "Check the current phase with flowguard_status.",
  "quickFix": "/continue"
}
```

The system never fails silently. Every blocked action has:
- A specific **code** (machine-readable)
- A human-readable **message**
- A **recovery** suggestion
- An optional **quickFix** command

---

## Pipeline / CI Mode

For headless operation (no human interaction), use the OpenCode SDK:

```typescript
import { Client } from "@opencode-ai/sdk";

const client = new Client();
const session = await client.session.create();

await client.session.command(session.id, "/hydrate --policyMode solo");
await client.session.command(session.id, "/ticket Fix the auth bug in login.ts");
await client.session.command(session.id, "/plan");
// ... continues through workflow
```

In Solo mode, all User Gates auto-approve, enabling fully automated pipelines.

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run check

# Run tests (662 tests across 17 test files)
npm test

# Build
npm run build

# Install FlowGuard globally
npx @flowguard/core install

# Verify installation
npx @flowguard/core doctor

# Uninstall
npx @flowguard/core uninstall
```

### Test Policy

All test suites must cover five categories:

| Category | Description | Example |
|----------|-------------|---------|
| **Happy Path** | Normal, expected successful flow | Hydrate new session -> TICKET phase |
| **Bad Input** | Invalid, missing, or malformed input | Empty ticket text -> blocked |
| **Corner Case** | Boundary conditions, limits | Max review iterations reached -> force-converge |
| **Edge Case** | Unusual but valid scenarios | Idempotent hydrate on existing session |
| **Performance** | Throughput, memory, timing | 1000 audit events verify in <100ms |

---

## Architecture Principles

1. **Fail-closed** — ambiguity blocks, never guesses
2. **Deterministic** — same state + same input = same result
3. **Pure machine** — no side effects in transition logic
4. **Evidence-first** — every phase produces verifiable artifacts
5. **LLM-agnostic** — works with any model, no provider lock-in
6. **Zero-bridge** — same process, no subprocess shell-out
7. **Immutable audit** — hash-chained, append-only, tamper-evident
8. **Policy-bound** — every decision traced to a specific policy version

---

*See [PRODUCT_IDENTITY.md](PRODUCT_IDENTITY.md) for the full product positioning document.*
