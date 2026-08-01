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

- `/start` output with policy mode
- `/architecture Read ADR_TICKET.md and create an ADR` → LLM generates ADR
- `INDEPENDENT_REVIEW_REQUIRED` → subagent invoked
- Architecture Review Card with reviewer findings
- `/approve` → `ARCH_COMPLETE`
- `/export` → `archiveStatus: not_verifiable` for the default redacted sharing archive

### 2. Screen Recording — Part 2: Implementation (~5–6 min)

Record the Implementation variant (Steps 0–11 from `DEMO_SCRIPT.md`):

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: OpenCode window + terminal side-by-side. The recording should show:

- `/start` output with policy mode
- `/implement` blocker (`COMMAND_NOT_ALLOWED` in TICKET phase)
- Plan Review Card
- `/check` passing (VALIDATION → IMPLEMENTATION)
- `git diff` of the fix
- `/approve` → COMPLETE
- `./mvnw test` — 16 green, 0 skipped
- `/finish` Finish Card (`overallStatus: READY`, non-normative `actionGuidance`, `exitOptions`)
- `/export` response (`archiveStatus: not_verifiable` for the default redacted sharing archive)

### 3. Screen Recording — Part 3: Review (~3–5 min)

Record R1–R4 from the review section:

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: branch listing, `/review` block with `CONTENT_ANALYSIS_REQUIRED`,
subagent findings, `REVIEW_COMPLETE`.

### 4. Frozen Evidence Assets

After a successful live or recorded run, keep two separate assets available:

1. **Workspace** — for visible source and generated artifacts (checkpoints, diffs).
2. **Evidence archive** — stored outside the workspace under the OpenCode
   config directory. A verified archive additionally requires the confidential
   raw-evidence export described in `DEMO_SCRIPT.md`.

```bash
# Keep the workspace as a visual fallback exhibit.
test -d /tmp/flowguard-java-demo

# Locate session archives in the OpenCode workspace state.
# The exact archive path is emitted by the /export command response.
find ~/.config/opencode/workspaces -path '*/archive/*.tar.gz' -type f -print
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

| Application                    | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| Video player (paused at 00:00) | Pre-recorded architecture run                                  |
| Video player (paused at 00:00) | Pre-recorded implementation run                                |
| Video player (paused at 00:00) | Pre-recorded review run                                        |
| Finder / file browser          | Workspace checkpoints under `/tmp/flowguard-demo-checkpoints/` |
| Text editor                    | `git diff` output of the fix                                   |
| Terminal                       | Saved `./mvnw test` output and verified archive path           |

### Checkpoint Recovery

If a live step takes too long, switch to a prepared workspace snapshot:

```bash
./snapshot-demo.sh restore <label> /tmp/flowguard-java-demo
```

After restore, reopen the workspace in OpenCode Desktop.

#### Implementation Flow Snapshots

| Snapshot            | Label            | Phase               |
| ------------------- | ---------------- | ------------------- |
| Seed workspace      | 00-seed          | Initial             |
| Plan approved       | 01-plan-approved | VALIDATION          |
| Implementation done | 02-implemented   | IMPL_REVIEW         |
| Session complete    | 03-complete      | COMPLETE            |
| Evidence exported   | 04-exported      | COMPLETE (archived) |

#### Architecture Flow Snapshots

Architecture snapshots reproduce visible workspace evidence only. They do
**not** restore FlowGuard session state (stored in `~/.config/opencode/`).
After architecture snapshot restore, either start a new session or present
the snapshot as prerecorded evidence.

| Snapshot          | Label             | Phase         | Resumable? |
| ----------------- | ----------------- | ------------- | :--------: |
| ADR reviewed      | A02-adr-reviewed  | ARCHITECTURE  |     No     |
| Architecture done | A03-arch-complete | ARCH_COMPLETE |     No     |

Architecture recovery strategy:

| Fallback                                        | Snapshot            | Recovery                                                          |
| ----------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| LLM generiert keine ADR (Timeout/Fehler)        | `00-seed`           | Restore → OpenCode neu öffnen → `/start` → `/architecture` erneut |
| Subagent lehnt ADR ab (>1 ungeplante Iteration) | `A02-adr-reviewed`  | Snapshot zeigen + erklären (visual only)                          |
| ARCH_REVIEW → Zeit knapp                        | `A03-arch-complete` | Snapshot zeigen + erklären (visual only)                          |

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
- [ ] Checkpoint snapshots created (including `A02-adr-reviewed`, `A03-arch-complete`)
- [ ] Video player windows positioned behind live window group
