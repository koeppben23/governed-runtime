# FlowGuard for OpenCode

Deterministic, fail-closed FlowGuard workflow for AI-assisted software delivery.
Adds explicit phases, evidence gates, audit trails, and policy enforcement to OpenCode.

> **Status:** v1.3.0 | TypeScript | OpenCode-native | Workspace Registry + Discovery System

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
computes a repository fingerprint, runs **comprehensive repo discovery** (stack detection,
topology analysis, surface detection, domain signals), auto-detects your tech stack,
resolves the FlowGuard policy, writes immutable discovery snapshots, and initializes
canonical state in the workspace registry.

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

FlowGuard distinguishes between **Workflow Commands** (drive session state) and **Operational Tools** (operate on session artifacts).

### Workflow Commands

Workflow commands are part of the governed flow and drive session state transitions.

All workflow commands are available as `/command` in OpenCode chat.

#### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

- **Creates**: Session state in workspace registry (`~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}/`)
- **Discovers**: Repository metadata, language/framework/tool stack, project topology (monorepo vs single), architectural surfaces (API, persistence, CI/CD, security), domain signals
- **Resolves**: Fingerprint (from git remote or worktree path), Profile (auto-detect from repo + discovery), Policy (solo/team/regulated), Binding (session <-> worktree)
- **Snapshots**: Immutable copies of `discovery.json` and `profile-resolution.json` written to session directory before state persistence
- **Arguments**: Optional `policyMode` (solo, team, regulated). Default: solo. If omitted, falls back to `policy.defaultMode` from workspace config (if set), then to the built-in default.

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
Writes report to the session directory in the workspace registry.

Includes: evidence completeness matrix, four-eyes status, validation summary, findings.

### /abort

Emergency session termination. Sets phase to COMPLETE with ABORTED marker. Irreversible.

### Operational Tools

Operational tools perform export, inspection, and management actions on session artifacts. They are not part of the workflow state machine.

#### /archive

Archive a completed session as a `.tar.gz` file with integrity verification.
Can also be triggered automatically when a session reaches the COMPLETE phase.

- **Phase**: COMPLETE (operational tool, not a workflow command)
- **Creates**: `{workspaceDir}/sessions/archive/{sessionId}.tar.gz` + `.tar.gz.sha256` + `archive-manifest.json`
- **Manifest**: Contains `sessionId`, `fingerprint`, `policyMode`, `profileId`, `discoveryDigest`, `includedFiles`, `fileDigests`, `contentDigest`
- **Verify**: `verifyArchive()` validates manifest presence, file completeness, digest integrity, and discovery consistency (10 finding codes)
- **Note**: This is an operational export action, not a workflow step. The original session directory is preserved.

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
  detect: ({ repoSignals, discovery }) =>
    repoSignals.configFiles.includes("my-config.json") ? 0.9 : 0,
  instructions: "Your LLM guidance text here...",
});
```

---

## Audit Trail

Every state transition and tool call is recorded in the session's `audit.jsonl`.

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

## Discovery System

On every `/hydrate`, FlowGuard runs a comprehensive repository discovery pipeline with 5 independent collectors:

| Collector | What It Detects | Evidence Class |
|-----------|----------------|----------------|
| **repo-metadata** | Default branch, HEAD commit, dirty status, remote URL | `fact` |
| **stack-detection** | Languages, frameworks, tools, testing frameworks, build tools, linters | `fact` / `derived_signal` |
| **topology** | Monorepo vs single-project, workspace roots, package manager | `fact` / `derived_signal` |
| **surface-detection** | API surfaces, persistence (ORM/migrations), CI/CD, security, architectural layers | `fact` / `derived_signal` |
| **domain-signals** | Domain keywords from directory names and file paths | `derived_signal` |

### Design

- **Budget-guarded**: Each collector runs independently via `Promise.allSettled` with per-collector timeout. A failing collector degrades gracefully; partial results are allowed.
- **File-path-based**: All detection uses file paths only — no file content is read. This keeps discovery fast and predictable.
- **Evidence-classified**: Every detected item carries a classification (`fact`, `derived_signal`, or `hypothesis`) indicating confidence level.
- **Separate from RepoSignals**: `DiscoveryResult` wraps `RepoSignals` (which remains lightweight and fast) with rich additional data.

### Persistence

Discovery results are written to two locations:

1. **Workspace directory**: `discovery/discovery.json` and `discovery/profile-resolution.json` — updated on each hydrate
2. **Session directory**: `discovery-snapshot.json` and `profile-resolution-snapshot.json` — immutable copies written *before* state persistence

The session state carries a `discoveryDigest` (SHA-256 of the full discovery result) and a `discoverySummary` (lightweight summary: language/framework/topology one-liners, surface/domain counts).

### Profile Resolution

Profile detection now receives `ProfileDetectionInput` with both `repoSignals` and the optional `DiscoveryResult`. The resolution is recorded in `profile-resolution.json`, including:

- Selected profile with score
- All rejected candidates with scores
- Detection timestamp

---

## Archive Hardening

Session archival now produces three artifacts:

| File | Content |
|------|---------|
| `{sessionId}.tar.gz` | Compressed session directory contents |
| `{sessionId}.tar.gz.sha256` | SHA-256 hash of the archive file |
| `archive-manifest.json` | Structured manifest with digests and file inventory |

### Manifest

The `archive-manifest.json` contains:

- `sessionId`, `fingerprint`, `policyMode`, `profileId`
- `discoveryDigest` — links archive to exact discovery state
- `includedFiles` — complete list of archived files
- `fileDigests` — per-file SHA-256 hashes
- `contentDigest` — SHA-256 over all file digests (tamper-evident)

### Verification

`verifyArchive()` performs 10 integrity checks:

| Finding Code | What It Checks |
|-------------|----------------|
| `missing_manifest` | Manifest file exists in archive |
| `manifest_parse_error` | Manifest is valid JSON matching schema |
| `missing_file` | All listed files are present |
| `unexpected_file` | No unlisted files in archive |
| `file_digest_mismatch` | Per-file hashes match content |
| `content_digest_mismatch` | Overall content digest is correct |
| `archive_checksum_missing` | `.sha256` sidecar file present |
| `archive_checksum_mismatch` | `.sha256` file matches actual archive hash |
| `state_missing` | Session state file exists |
| `snapshot_missing` | Discovery snapshot present when `discoveryDigest` set |

---

## Configuration

FlowGuard supports per-repository configuration via `config.json` in the workspace directory. The file is optional — when absent, all built-in defaults apply.

### Config File Location

```
~/.config/opencode/workspaces/{fingerprint}/config.json
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
  },
  "archive": {
    "retentionDays": 90,
    "autoCleanupSessions": true,
    "exportPath": "/path/to/export/dir"
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
| `archive` | `retentionDays` | integer 1–3650 | *(none)* | How long to retain archived sessions. *(Reserved, logic not yet implemented.)* |
| `archive` | `autoCleanupSessions` | boolean | *(none)* | Automatically clean up sessions older than retention period. *(Reserved.)* |
| `archive` | `exportPath` | string | *(none)* | Directory for archive export. *(Reserved.)* |

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

### Workspace Registry (`~/.config/opencode/`)

All FlowGuard runtime data lives outside the repository, in a centralized workspace registry:

```
~/.config/opencode/
├── SESSION_POINTER.json                        # Non-authoritative diagnostic cache
├── workspaces/
│   └── {24-hex-fingerprint}/                   # Per repository (fingerprint from git remote or path)
│       ├── workspace.json                       # Metadata: fingerprint source, canonical remote, worktree
│       ├── config.json                          # Per-repo FlowGuard config (optional, Zod-validated)
│       ├── logs/                                # Per-repo log output
│       ├── discovery/                           # Repository discovery results
│       │   ├── discovery.json                   # Full DiscoveryResult (stack, topology, surfaces, domain)
│       │   └── profile-resolution.json          # Profile resolution with scores + rejected candidates
│       └── sessions/
│           ├── {session-uuid}/                  # One FlowGuard run
│           │   ├── session-state.json            # Canonical state (Zod-validated, atomic writes)
│           │   ├── audit.jsonl                   # Append-only hash-chained audit trail
│           │   ├── review-report.json            # Latest compliance report
│           │   ├── discovery-snapshot.json        # Immutable discovery snapshot (written before state)
│           │   └── profile-resolution-snapshot.json # Immutable profile resolution snapshot
│           └── archive/
│               ├── {session-uuid}.tar.gz         # Archived completed sessions
│               ├── {session-uuid}.tar.gz.sha256  # Archive file hash
│               └── archive-manifest.json          # Manifest with digests and file inventory
```

### Repository Integration

```
your-project/
├── .opencode/                      # OpenCode integration (or ~/.config/opencode/ for global)
│   ├── package.json                # Plugin dependencies (includes @flowguard/core)
│   ├── flowguard-mandates.md      # Managed artifact — FlowGuard mandates (SHA-256 digest-tracked)
│   ├── tools/flowguard.ts         # Thin wrapper → re-exports 10 tools from @flowguard/core
│   ├── commands/*.md               # 10 command prompts
│   └── plugins/flowguard-audit.ts # Thin wrapper → re-exports plugin from @flowguard/core
├── AGENTS.md                       # User/project rules (OpenCode auto-loads, NEVER touched by installer)
└── opencode.json                   # OpenCode configuration (instructions reference flowguard-mandates.md)
```

### Package Source (`@flowguard/core`)

```
src/
├── state/                      # Layer 1: Zod schemas
├── machine/                    # Layer 2: Pure state machine
├── rails/                      # Layer 3: Command orchestrators
├── adapters/                   # Layer 4: I/O boundary (state, config, audit, git, workspace)
├── config/                     # Layer 5: Extension points (profiles, policies, reasons, config schema)
├── logging/                    # Layer 5b: Structured logging (logger interface + factories)
├── audit/                      # Layer 6: Audit subsystem
├── discovery/                  # Layer 7: Repo discovery (5 collectors + orchestrator)
│   ├── collectors/             #   repo-metadata, stack-detection, topology, surface-detection, domain-signals
│   ├── orchestrator.ts         #   Budget-guarded parallel execution, summary extraction, digest computation
│   └── types.ts                #   Zod schemas for DiscoveryResult, SurfacesInfo, TopologyInfo, etc.
├── archive/                    # Layer 8: Archive types (manifest, verification, findings)
├── integration/                # Layer 9: OpenCode tools + plugin (10 tools, 1 plugin)
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

# Run tests (884 tests across 22 test files)
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
