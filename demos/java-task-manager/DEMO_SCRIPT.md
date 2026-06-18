# Demo Script — Java Task Manager Bug Fix

**Duration:** 10–15 minutes
**Audience:** Technical decision makers, engineering leads

## Prerequisites (run before the demo)

```bash
cd demos/java-task-manager
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
opencode serve --hostname 127.0.0.1 --port 4096
```

---

## Step 0 — Prove the Bug Exists (optional, pre-recorded or live)

| Action | What I Say |
|--------|------------|
| `./mvnw test` | "16 Tests reported, 15 executed, 1 skipped — das ist unser Regressionstest." |
| Show the test source | "Der Test ist absichtlich `@Disabled`, weil er aktuell fehlschlagen würde — er beweist den Bug." |

**Optional live proof:** Remove `@Disabled` locally, run `./mvnw test` to see the red test,
then `git checkout -- .` to reset before the FlowGuard demo.

---

## Step 1 — Start the Session

| Action | Phase | What I Say |
|--------|-------|------------|
| `/start` | READY | "Ich starte eine FlowGuard-Session. Policy: `team` — human-gated. Das bedeutet: keine Code-Änderung ohne menschliche Freigabe." |
| Show `policy` output | | "Hier sehen Sie die Policy: auto-approve ist aus, Review-Subagent obligatorisch." |

---

## Step 2 — Record the Ticket

| Action | Phase | What I Say |
|--------|-------|------------|
| `/task TICKET.md` | TICKET | "Ich übergebe das Ticket. FlowGuard erzwingt, dass jede Änderung von einem erfassten Ticket ausgeht." |

---

## Step 3 — Generate the Plan

| Action | Phase | What I Say |
|--------|-------|------------|
| `/plan` | PLAN | "Der LLM analysiert den Code und erstellt einen Plan. Wichtig: Der Plan ist ein Dokument. Kein Code wird geändert." |
| Wait for review card | PLAN_REVIEW | "FlowGuard hat den Plan automatisch an einen independent Reviewer-Subagent geschickt. Der Reviewer prüft: ist der Plan vollständig? Fehlen Akzeptanzkriterien?" |
| Show Plan Review Card | | "Das ist die Plan Review Card. Sie zeigt den Plan, die Reviewer-Findings, und die möglichen Entscheidungen: Approve, Changes Requested, Reject." |

---

## Step 4 — Approve the Plan

| Action | Phase | What I Say |
|--------|-------|------------|
| `/approve` | VALIDATION | "Ich genehmige den Plan. FlowGuard wechselt in die Validierungsphase. Kein Code wurde bisher angerührt." |

---

## Step 5 — Validate (all tests pass, disabled test does not block)

| Action | Phase | What I Say |
|--------|-------|------------|
| `/check` | VALIDATION → IMPLEMENTATION | "FlowGuard führt die Validierung durch: `./mvnw test`. Alle aktiven Tests sind grün — der `@Disabled`-Test läuft nicht mit. Deshalb ist die Validation erfolgreich und FlowGuard erlaubt jetzt die Implementierung." |

---

## Step 6 — Implement the Fix

| Action | Phase | What I Say |
|--------|-------|------------|
| `/implement` | IMPLEMENTATION | "Jetzt implementiert der LLM den Fix. Der Agent darf nicht einfach nur den Test aktivieren — er muss beides liefern: Bugfix und Testaktivierung." |
| Wait for review | EVIDENCE_REVIEW | "FlowGuard hat die Code-Änderung wieder an den Reviewer-Subagent geschickt. Der Reviewer prüft: wurde der Bug tatsächlich behoben? Ist der Regressionstest aktiviert? Wurden keine anderen Endpunkte verändert?" |
| Show `git diff` | | "Hier sehen Sie die Änderung: ein kleiner null-Check in TaskService, und der @Disabled ist entfernt. Nichts anderes wurde angefasst." |

---

## Step 7 — Final Approval

| Action | Phase | What I Say |
|--------|-------|------------|
| `/approve` | COMPLETE | "Finale Genehmigung. Die Session ist komplett. FlowGuard hat jeden Schritt dokumentiert." |

---

## Step 8 — Prove the Fix (post-flow)

| Action | What I Say |
|--------|------------|
| `./mvnw test` | "Alle 16 Tests grün, null skipped. Der zuvor disabled Regressionstest läuft jetzt und beweist: der Bug ist behoben." |

---

## Step 9 — Export the Evidence

| Action | What I Say |
|--------|------------|
| `/export` | "Ich exportiere das Audit-Archive. FlowGuard erzeugt ein verifizierbares Paket mit allen Artefakten." |
| `ls .flowguard/sessions/archive/` | "Hier im Archive: Manifest, Session-State, Plan-Evidence, Review-Cards, Implementation-Diff. Alles ist über Manifest und Checksums prüfbar. Das ist der Governance-Nachweis — nachvollziehbar und tamper-evident." |

---

## Summary Slide

> "Ich habe den Regressionstest im Seed bewusst disabled, weil FlowGuard zurecht keinen
> failing Check in die Implementierung durchlässt. Der Fix besteht deshalb aus zwei Teilen:
> Bug beheben und Regressionstest aktivieren. Am Ende beweist der grüne Testlauf, dass der
> zuvor dokumentierte Bug wirklich geschlossen wurde."
>
> — Ben Koepp

---

## Optional Bonus: Content-aware `/review` Flow (~5–7 min)

> **Only if time permits.** Uses a separate workspace with a pre-built branch.
> This is a standalone bonus — not part of the main demo.

### Precondition

```bash
./run-demo-setup.sh --install --tarball <tgz> /tmp/flowguard-java-review-demo
cd /tmp/flowguard-java-review-demo
```

The branch `feature/add-due-date` already exists. It simulates an external PR:

| File | Change |
|------|--------|
| `Task.java` | `dueDate` field, getter, setter |
| `CreateTaskRequest.java` | `dueDate` field, getter, setter |
| `TaskResponse.java` | **Unchanged** — deliberately omitted |

### Proof the Branch Exists

```bash
git branch --list
git diff --name-only main...feature/add-due-date
# Expected output:
#   src/main/java/com/example/taskmanager/model/Task.java
#   src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java
# TaskResponse.java is NOT listed — the reviewer must infer this omission.
```

### Steps

| Step | Action | Phase | What I Say |
|------|--------|-------|------------|
| B1 | `/start` | READY | "Neue Session. `/review` ist ein eigener Flow ab READY." |
| B2 | `/review branch=feature/add-due-date` | REVIEW | "FlowGuard erkennt content-aware review, erzeugt eine Obligation, blockt mit `CONTENT_ANALYSIS_REQUIRED`." |
| B3 | Host invokes `flowguard-reviewer` subagent | — | "Der Subagent analysiert den Diff. `dueDate` im Model und Request-DTO — aber das Response-DTO ist unverändert. Der Reviewer muss diese strukturelle Lücke semantisch erkennen." |
| B4 | Host submits `reviewFindings` | REVIEW_COMPLETE | "Attestierte Findings eingereicht. FlowGuard validiert: Mandate-Digest, Session-ID-Match, Obligation-ID. Report geschrieben, Flow abgeschlossen." |

### Expected Flow

1. `/review branch=...` → FlowGuard creates a **review obligation** and blocks with
   `CONTENT_ANALYSIS_REQUIRED`. The host must invoke the `flowguard-reviewer` subagent.
2. Subagent analyses the branch diff. It should infer the omission from the changed
   model/request surface and the unchanged response DTO: the new `dueDate` field is
   not exposed in the API response.
3. Host submits attested `reviewFindings`. FlowGuard validates the attestation chain:
   mandate-digest, session-ID, obligation-ID — all must match.
4. FlowGuard writes the review report, consumes the obligation, and completes the flow
   with `REVIEW_COMPLETE`.

### What This Proves

- FlowGuard governed **nicht nur eigene Änderungen** (Ticket-Flow), sondern auch
  **externe Contributions** (Review-Flow) — ein PR-like Branch-Diff wird durch denselben
  Subagent-Review-Mechanismus geprüft.
- Der Reviewer-Subagent findet **echte strukturelle Probleme**, nicht nur oberflächliche
  Checks.
- Zwei Sessions in **getrennten Workspaces** sind unabhängig — jede mit eigenem
  Audit-Trail und Evidence. Keine gemeinsame SSOT-Kette.

### Notes

- The base branch is auto-detected by FlowGuard's Git detection path
  (`origin/HEAD` → local `main` → local `master` fallback).
- Do **not** hand-author `reviewFindings`. Let the host/subagent integration
  submit them via the `flowguard-reviewer` subagent.
- The diff between `main` and `feature/add-due-date` contains only the dueDate
  changes. The 404 bug is identical on both branches and does not appear.

---

## Known Limitations

- `/plan` and `/implement` require an LLM-backed OpenCode instance. Without a model
  backend, these steps will fail or produce empty output.
- Test execution time varies by machine. The `search_tasks_by_query` test uses
  a unique query term to avoid pollution from other tests in the shared Spring context.
