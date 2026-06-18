# Pre-recorded Fallback

This document describes how to prepare and use a pre-recorded fallback for the
FlowGuard demo. The fallback exists to protect the core message — FlowGuard's
governed delivery flow — from live-host instability during `/implement` or
`/review`.

**Do not mention the fallback proactively.** It is a professional safety net,
not a planned part of the presentation.

---

## Fallback Assets (prepare once, keep ready)

### 1. Screen Recording — Main Golden Path (~6–8 min)

Record a complete run of Steps 1–10 from `DEMO_SCRIPT.md`:

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: OpenCode window + terminal side-by-side. The recording should show:

- `/start` output with policy mode
- Plan Review Card
- `/check` passing (VALIDATION → IMPLEMENTATION)
- `git diff` of the fix
- `/approve` → COMPLETE
- `./mvnw test` — 16 green, 0 skipped
- `/export` and `ls .flowguard/sessions/archive/`

### 2. Screen Recording — `/review` Bonus (~3–5 min, optional)

Record B1–B4 from the bonus section:

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-review-demo
cd /tmp/flowguard-java-review-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

Capture: branch listing, `/review` block with `CONTENT_ANALYSIS_REQUIRED`,
subagent findings, `REVIEW_COMPLETE`.

### 3. Frozen Evidence Workspace

After a successful live or recorded run, keep the workspace intact:

```bash
# Do NOT delete the workspace after the demo.
# Keep it as a fallback exhibit.
ls -la /tmp/flowguard-java-demo/.flowguard/sessions/archive/
```

---

## Live Setup — Tab Groups

### Tab Group 1: Live (always visible)

| Application                       | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| OpenCode Desktop                                     | Live session                             |
| Terminal                          | `./mvnw test`, `git diff`, `ls archive/` |
| `DEMO_SCRIPT.md` (open in editor) | Spickzettel                              |

### Tab Group 2: Fallback (open, hidden, ready)

| Application                    | Purpose                      |
| ------------------------------ | ---------------------------- |
| Video player (paused at 00:00) | Pre-recorded main run        |
| Video player (paused at 00:00) | Pre-recorded bonus run       |
| Finder / file browser          | Frozen `archive/` directory  |
| Text editor                    | `git diff` output of the fix |
| Terminal                       | Saved `./mvnw test` output   |

---

## Transition Script (use ONLY if needed)

> "Der Host hat gerade eine Verzögerung — das liegt an der Model-Latenz,
> nicht an FlowGuard. Ich springe kurz auf den vorbereiteten Referenzdurchlauf.
> Das ist derselbe Workspace, derselbe Flow — ich zeige daran die erwarteten
> Cards, Checks und Export-Artefakte."

---

## Pre-flight Checklist (morning of the demo)

- [ ] Both recordings play correctly
- [ ] `./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-demo` completes with verified install
- [ ] `./mvnw test` — 16 tests, 0 failures, 1 skipped
- [ ] OpenCode starts and `/start` works
- [ ] Internet connection stable
- [ ] External display tested (resolution, font size for the room)
- [ ] Tab groups arranged
- [ ] Video player windows positioned behind live window group
