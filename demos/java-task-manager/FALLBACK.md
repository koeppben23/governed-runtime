# Pre-recorded Fallback

This document describes how to prepare and use a pre-recorded fallback for the
FlowGuard demo. The fallback exists to protect the core message — FlowGuard's
governed delivery flow — from live-host instability during `/implement`,
`/architecture`, or `/review`.

**Do not mention the fallback proactively.** It is a professional safety net,
not a planned part of the presentation.

---

## Fallback Assets (prepare once, keep ready)

### 1. Screen Recording — Part 1: Architecture (~4–5 min)

Record the Architecture variant (Steps A0–A6 from `DEMO_SCRIPT.md`):

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: OpenCode window + terminal side-by-side. The recording should show:

- `/start` output with policy mode (READY)
- `/architecture` → LLM generates the MADR ADR in ARCHITECTURE
- Host-orchestrated independent review with structured findings bound via
  `reviewDispatch`
- Architecture Review Card with reviewer findings at ARCH_REVIEW
- `/approve` → terminal `ARCH_COMPLETE`
- Optional `/archive` → redacted sharing archive
  (`integrityCapability: not_verifiable`, `verificationStatus: not_run`)

### 2. Screen Recording — Part 2: Development (~5–6 min)

Record the Development variant (Steps 0–11 from `DEMO_SCRIPT.md`):

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: OpenCode window + terminal side-by-side. The recording should show:

- `/start` output with policy mode (READY)
- `/task` recording TICKET.md
- `/implement` blocker (`COMMAND_NOT_ALLOWED`, directive `PLAN_REQUIRED`,
  "Plan required" in TICKET)
- Optional: a direct host-tool mutation attempt in TICKET, denied with
  `HOST_TOOL_PHASE_DENIED` and recorded as `enforcement:denied` in the audit
  trail (Step 2b in `DEMO_SCRIPT.md`)
- Plan Review Card at PLAN_REVIEW, then `/approve` → VALIDATION
- Automatic validation executed in-flow via `flowguard_run_check` (no user
  command), then `/implement` → IMPLEMENTATION
- `git diff` of the fix
- Automatic post-implementation validation (IMPL_VALIDATION) → independent
  implementation review (IMPL_REVIEW), Implementation Review Card
- `/approve` → `EXPORT_READY`
- `./mvnw test` — 16 green, 0 skipped
- `/finish` Finish Card (`overallStatus: READY`, non-normative
  `actionGuidance`, `exitOptions`)
- `/export` → terminal `COMPLETE` (`ExportCompletionEvidence` persisted)
- Optional `/archive` → redacted sharing archive
  (`integrityCapability: not_verifiable`, `verificationStatus: not_run`)

### 3. Screen Recording — Part 3: Peer Review (~3–5 min)

Record R1–R4 from the Peer Review Flow section:

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: branch listing, `/start` (READY), `/review` with
`branch=feature/add-due-date` (READY → PEER_REVIEW as autonomous system work),
the host-orchestrated reviewer child session, the bound `reviewDispatch`
signal, the review report card with its target coverage, and terminal
`PEER_REVIEW_COMPLETE`.

### 4. Frozen Evidence Assets

After a successful live or recorded run, keep these assets available:

1. **Workspace** — for visible source and generated artifacts (checkpoints, diffs).
2. **Export package** — the verifiable package created by `/export` and its
   `ExportCompletionEvidence`; the development flow is only `COMPLETE` after it.
3. **Archive** — an optional redacted sharing archive created by `/archive`
   for a terminal session, stored outside the workspace under the OpenCode
   config directory.

```bash
# Keep the workspace as a visual fallback exhibit.
test -d /tmp/flowguard-java-demo

# Locate session archives in the OpenCode workspace state.
# The exact archive path is emitted by the /archive command response.
find ~/.config/opencode/workspaces -path '*/archive/*.tar.gz' -type f -print
```

Record the reference-run values next to the package; without them the package
assignment cannot be re-verified later:

| Value                    | Where it comes from                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Session id               | `/start` output (the archive file name)                                                                               |
| Flow / phase             | `development` / `EXPORT_READY` for the `/export` package; `COMPLETE` for a raw terminal archive                       |
| Runtime version + commit | The FlowGuard tarball used for the run (`flowguard --version`, `git rev-parse HEAD` of the checkout that produced it) |
| Package + sidecar        | `<sessionId>.tar.gz` and `<sessionId>.tar.gz.sha256`                                                                  |

Re-verify the frozen package before the pitch (and after copying it between
machines) with the standalone verifier — scope, limits, and exit codes are
documented in `EVIDENCE_PACKAGE.md`:

```bash
# Run from the governed-runtime checkout of the same version that produced the package.
node demos/java-task-manager/verify-evidence-package.mjs \
  ~/.config/opencode/workspaces/<fingerprint>/sessions/archive/<sessionId>.tar.gz \
  --expect-session <session-id> \
  --expect-flow development \
  --expect-phase EXPORT_READY
```

---

## Live Setup — Tab Groups

### Tab Group 1: Live (always visible)

| Application                       | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| OpenCode Desktop                  | Live session                                         |
| Terminal                          | `./mvnw test`, `git diff`, saved export archive path |
| `DEMO_SCRIPT.md` (open in editor) | Spickzettel                                          |

### Tab Group 2: Fallback (open, hidden, ready)

| Application                    | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| Video player (paused at 00:00) | Pre-recorded architecture run                                |
| Video player (paused at 00:00) | Pre-recorded development run                                 |
| Video player (paused at 00:00) | Pre-recorded peer review run                                 |
| Finder / file browser          | Workspace checkpoints under /tmp/flowguard-demo-checkpoints/ |
| Text editor                    | `git diff` output of the fix                                 |
| Terminal                       | Saved `./mvnw test` output and export package path           |

### Checkpoint Recovery

If a live step takes too long, switch to a prepared workspace snapshot:

```bash
./snapshot-demo.sh restore <label> /tmp/flowguard-java-demo
```

After restore, reopen the workspace in OpenCode Desktop. Every snapshot is
**visual only**: it restores workspace files and **never** restores or resumes
FlowGuard session authority. Session state, review obligations, audit chain,
review cycles, and human decisions live outside the workspace. A snapshot is a
visual exhibit — for a working governed flow, start a fresh session (`/start`)
or use the prerecorded reference run.

#### Development Flow Snapshots

| Snapshot                      | Label                          | Phase        |
| ----------------------------- | ------------------------------ | ------------ |
| Seed workspace                | `00-seed-visual-only`          | Initial      |
| Plan approved                 | `01-plan-approved-visual-only` | VALIDATION   |
| Implementation done           | `02-implemented-visual-only`   | IMPL_REVIEW  |
| Export ready                  | `03-export-ready-visual-only`  | EXPORT_READY |
| Session complete and archived | `04-exported-visual-only`      | COMPLETE     |

#### Architecture Flow Snapshots

Architecture snapshots reproduce visible workspace evidence only. They do
**not** restore FlowGuard session state (stored in `~/.config/opencode/`).
After architecture snapshot restore, start a fresh session or present the
snapshot as prerecorded evidence.

| Snapshot          | Label                           | Phase         | Resumable? |
| ----------------- | ------------------------------- | ------------- | :--------: |
| ADR reviewed      | `A02-adr-reviewed-visual-only`  | ARCH_REVIEW   |     No     |
| Architecture done | `A03-arch-complete-visual-only` | ARCH_COMPLETE |     No     |

Architecture recovery strategy:

| Fallback                                        | Snapshot                        | Recovery                                                          |
| ----------------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| LLM generiert keine ADR (Timeout/Fehler)        | `00-seed-visual-only`           | Restore → OpenCode neu öffnen → `/start` → `/architecture` erneut |
| Subagent lehnt ADR ab (>1 ungeplante Iteration) | `A02-adr-reviewed-visual-only`  | Snapshot zeigen + erklären (visual only)                          |
| ARCH_REVIEW → Zeit knapp                        | `A03-arch-complete-visual-only` | Snapshot zeigen + erklären (visual only)                          |

---

## Transition Script (use ONLY if needed)

> "Der Host hat gerade eine Verzögerung — das liegt an der Model-Latenz,
> nicht an FlowGuard. Ich springe kurz auf den vorbereiteten Referenzdurchlauf.
> Das ist derselbe Workspace, derselbe Flow — ich zeige daran die erwarteten
> Cards, Checks und Export-Artefakte."

---

## Pre-flight Checklist (morning of the demo)

- [ ] All three recordings play correctly
- [ ] `./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo` completes with verified install
- [ ] `./mvnw test` — 16 tests, 0 failures, 1 skipped
- [ ] `./mvnw -o test` passes (Maven offline-ready)
- [ ] `ADR_TICKET.md` is present and non-empty in the workspace
- [ ] OpenCode Desktop starts and `/start` works
- [ ] Git commit hash recorded
- [ ] Tarball built from the exact commit intended for the pitch
- [ ] Node, npm, OpenCode, Java, Maven versions recorded
- [ ] Internet connection stable
- [ ] External display tested (resolution, font size for the room)
- [ ] Tab groups arranged
- [ ] Visual-only checkpoints created (including `A02-adr-reviewed-visual-only`, `A03-arch-complete-visual-only`)
- [ ] Video player windows positioned behind live window group
