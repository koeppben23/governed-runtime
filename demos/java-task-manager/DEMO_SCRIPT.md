# Demo Script — Java Task Manager

**Audience:** Technical decision makers, engineering leads

## Three Parts — Three Governed Flows

This demo proves three independent FlowGuard flows in one project:

| Part       | Flow           | Duration | What It Proves                                                                                                               |
| ---------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Part 1** | Architecture   | 5–8 min  | Architectural decisions governed through ADR creation, independent review, human approval, and exportable evidence           |
| **Part 2** | Implementation | 8–10 min | AI-assisted code changes routed through ticket, plan, review, approval, checks, and exportable evidence                      |
| **Part 3** | Review         | 5–10 min | External contributions governed through content-aware review with subagent findings, obligation binding, and evidence export |

Each part runs in its own FlowGuard session. Parts 1 and 2 share the same workspace (reset between sessions). Part 3 uses a separate workspace with a pre-built branch.

## Prerequisites (run before the demo)

```bash
cd demos/java-task-manager

# Part 1 + 2 workspace
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo

# Part 3 workspace (separate)
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-review-demo
```

---

## Part 1 — Architecture Flow (5–8 min)

> Governed architectural decision: LLM analyses the codebase, generates a
> MADR-format ADR, the subagent reviews it, and a human approves.
>
> Steps A0–A6 (7 steps). Step A3 combines ADR generation and subagent review
> into one narrative unit — the audience sees the LLM interaction as a single
> governed round-trip. A separate A3/A4 split would duplicate the speaking
> pattern already established in Part 2 Step 3 (Plan + Plan Review).

### Step A0 — Prove the Bug Exists (context for architecture analysis)

| Action        | What I Say                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `./mvnw test` | "16 Tests, 15 executed, 1 skipped. Der Regressionstest beweist eine Inkonsistenz: `getTask()` prüft auf null, `updateTask()` nicht." |

### Step A1 — Start the Session

| Action                                                      | Phase | What I Say                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`                                                    | READY | "Ich starte eine FlowGuard-Session fur den Architecture Flow. `/start` meldet `team` — human-gated. Der Architecture Flow ist ein eigener Pfad aus READY, getrennt vom Ticket-Flow."                                                |
| Read the `/start` output (`policyResolution.effectiveMode`) |       | "Policy `team`: human-gated, Subagent-Review obligatorisch, keine Auto-Approve. Mit `/status` kann ich diese Lage jederzeit prufen. Der Architecture Flow verwendet dieselbe Subagent-Review-Pipeline wie der Plan-Flow in Part 2." |

### Step A2 — Submit the Architecture Task

| Action                                                           | Phase        | What I Say                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/architecture Read ADR_TICKET.md and create an ADR based on it` | ARCHITECTURE | "Ich ubergebe den Architecture Task. FlowGuard erzwingt, dass ein ADR in MADR-Format erstellt wird — mit `## Context`, `## Decision`, `## Consequences`. Der LLM analysiert den Code, erkennt die Inkonsistenz und generiert eine strukturierte Entscheidungsvorlage." |

### Step A3 — ADR Generation and Subagent Review

| Action                             | Phase        | What I Say                                                                                                                                                                                                                           |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM reads ADR_TICKET.md + code     | ARCHITECTURE | "Der LLM liest das Architektur-Ticket, analysiert `TaskRepository.findById()` und die Inkonsistenz zwischen `getTask()` und `updateTask()`, und generiert einen ADR mit Context, Decision, Consequences."                            |
| `flowguard_architecture` tool call | ARCHITECTURE | "FlowGuard validiert die ADR-Sections. Fehlen MADR-Sections, blockt das Tool mit `MISSING_ADR_SECTIONS` — der LLM muss nachbessern. Sind alle Sections da, erzeugt FlowGuard eine Review Obligation: `INDEPENDENT_REVIEW_REQUIRED`." |
| Host invokes `flowguard-reviewer`  | ARCHITECTURE | "Der Subagent pruft: ist der Context vollstandig, die Decision konkret, die Consequences ehrlich, die MADR-Struktur korrekt? Wie beim Plan-Review: derselbe Mechanismus, andere Pruf-Kriterien."                                     |
| Subagent returns `overallVerdict`  | ARCHITECTURE | "Der Reviewer attestiert die ADR-Qualitat. Bei `changes_requested` geht es zuruck zur Revision — maximal 3 Iterationen, dann Force-Convergence zum ARCH_REVIEW Human-Gate."                                                          |

### Step A4 — Review Convergence

| Action                               | Phase                      | What I Say                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM submits verdict + reviewFindings | ARCHITECTURE → ARCH_REVIEW | "Verdict submitted. FlowGuard validiert: Attestation-Chain (Mandate-Digest, Session-ID, Obligation-ID). Bei `accept` und Konvergenz (`revisionDelta=none`) wechselt die Phase zu ARCH_REVIEW."                          |
| Architecture Review Card appears     | ARCH_REVIEW                | "Die Architecture Review Card zeigt: ADR-Titel, ID, Digest, Reviewer-Findings (Blocking Issues, Major Risks, Missing Verification), Iteration, und die moglichen Entscheidungen: Approve / Changes Requested / Reject." |

### Step A5 — Approve the ADR

| Action     | Phase                       | What I Say                                                                                                                                                                                |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | ARCH_REVIEW → ARCH_COMPLETE | "Ich genehmige die ADR. FlowGuard setzt den Status auf `accepted` und schreibt das MADR-Artefakt. ARCH_COMPLETE ist ein eigener Terminal-State — getrennt vom COMPLETE des Ticket-Flows." |

### Step A6 — Export Architecture Evidence

| Action                  | What I Say                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/export`               | "Ich exportiere das Architecture-Evidence-Archiv. FlowGuard erzeugt ein verifizierbares Paket mit ADR, Review-Findings, Audit-Trail und Manifest."                                    |
| Show `/export` response | "`archiveStatus: verified` — das Archiv wurde direkt nach der Erstellung verifiziert."                                                                                                |
| Archive location        | "Das Archiv liegt unter `~/.config/opencode/workspaces/.../archive/`. Es uberlebt den Workspace-Reset fur Part 2 — die Archive sind außerhalb des Projektverzeichnisses gespeichert." |

### Reset for Part 2

```bash
# Close OpenCode Desktop
./snapshot-demo.sh restore 00-seed /tmp/flowguard-java-demo
# Reopen /tmp/flowguard-java-demo in OpenCode Desktop (new MCP transport → new sessionId)
```

> The `00-seed` snapshot restores the buggy code + FlowGuard install. No session
> state survives — reopening OpenCode creates a fresh MCP transport and a fresh
> FlowGuard session for Part 2.

### Architecture Guardrails

- Maximum 1 unplanned subagent revision before switching to `A02-adr-reviewed` snapshot (visual evidence only).
- Architecture snapshots (`A02-adr-reviewed`, `A03-arch-complete`) restore **workspace files only**, not FlowGuard session state. See `FALLBACK.md`.

### Architecture Stop Points

- **Stop A1** (ADR generation latency): restore `00-seed`, reopen OpenCode, retry `/architecture`.
- **Stop A2** (reviewer iteration overflow): switch to `A02-adr-reviewed` snapshot — visual only.
- **Stop A3** (ARCH_REVIEW time pressure): switch to `A03-arch-complete` snapshot — visual only.

---

## Part 2 — Implementation Flow (8–10 min)

> Governed code change: the bug is fixed through ticket, plan, review, approval,
> checks, and exportable evidence. This is the original main flow.

### Step 0 — Prove the Bug Exists (optional, pre-recorded or live)

| Action               | What I Say                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `./mvnw test`        | "16 Tests reported, 15 executed, 1 skipped — das ist unser Regressionstest."                     |
| Show the test source | "Der Test ist absichtlich `@Disabled`, weil er aktuell fehlschlagen wurde — er beweist den Bug." |

**Optional live proof:** Remove `@Disabled` locally, run `./mvnw test` to see the red test,
then `git checkout -- .` to reset before the FlowGuard demo.

---

### Step 1 — Start the Session

| Action                                                      | Phase | What I Say                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`                                                    | READY | "Ich starte eine FlowGuard-Session. `/start` meldet die aktive Policy: `team` — human-gated. Das bedeutet: keine Code-Änderung ohne menschliche Freigabe."                                                                                                       |
| Read the `/start` output (`policyResolution.effectiveMode`) |       | "FlowGuard nennt hier den Policy-Mode `team`. Weil team human-gated ist, gibt es **keinen** Auto-Approve-Warnhinweis (`gateNotice`) — Auto-Approve ist aus, der Review-Subagent ist obligatorisch. Mit `/status` kann ich diese Lage jederzeit erneut anzeigen." |

---

### Step 2 — Record the Ticket

| Action            | Phase  | What I Say                                                                                            |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `/task TICKET.md` | TICKET | "Ich übergebe das Ticket. FlowGuard erzwingt, dass jede Änderung von einem erfassten Ticket ausgeht." |

---

### Step 2a — Prove Enforcement (the forbidden transition)

| Action       | Phase  | What I Say                                                                                                                                                                                                                            |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/implement` | TICKET | "Ich versuche direkt zu implementieren — ohne Plan, ohne Review, ohne Freigabe. FlowGuard blockiert mit `COMMAND_NOT_ALLOWED`. Erst Plan, unabhängige Prüfung, menschliche Freigabe und Validation öffnen die Implementierungsphase." |

> Das ist der zentrale Unterschied: Der Prozess ist nicht nur eine Prompt-Anweisung.
> Der unzulässige Übergang wird technisch abgelehnt.

---

### Step 3 — Generate the Plan

| Action                | Phase       | What I Say                                                                                                                                                      |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan`               | PLAN        | "Der LLM analysiert den Code und erstellt einen Plan. Wichtig: Der Plan ist ein Dokument. Kein Code wird geändert."                                             |
| Wait for review card  | PLAN_REVIEW | "FlowGuard hat den Plan automatisch an einen independent Reviewer-Subagent geschickt. Der Reviewer prüft: ist der Plan vollständig? Fehlen Akzeptanzkriterien?" |
| Show Plan Review Card |             | "Das ist die Plan Review Card. Sie zeigt den Plan, die Reviewer-Findings, und die möglichen Entscheidungen: Approve, Changes Requested, Reject."                |

---

### Step 4 — Approve the Plan

| Action     | Phase      | What I Say                                                                                               |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `/approve` | VALIDATION | "Ich genehmige den Plan. FlowGuard wechselt in die Validierungsphase. Kein Code wurde bisher angerührt." |

---

### Step 5 — Validate (all tests pass, disabled test does not block)

| Action   | Phase                       | What I Say                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/check` | VALIDATION → IMPLEMENTATION | "FlowGuard führt die Validierung durch: `./mvnw verify` (der aus den Repo-Wrappern erkannte Verifikationsbefehl — ein Superset, das die Test-Phase mit ausführt). Alle aktiven Tests sind grün — der `@Disabled`-Test läuft nicht mit. Deshalb ist die Validation erfolgreich und FlowGuard erlaubt jetzt die Implementierung." |

---

### Step 6 — Implement the Fix

| Action          | Phase          | What I Say                                                                                                                                                                                                                     |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/implement`    | IMPLEMENTATION | "Jetzt implementiert der LLM den Fix. Der Agent darf nicht einfach nur den Test aktivieren — er muss den Bugfix liefern, den Test aktivieren, die `taskId`-Fehlerantwort prüfen und das Baseline-Javadoc aktualisieren."       |
| Show `git diff` | IMPLEMENTATION | "Hier sehen Sie die Änderung: ein kleiner null-Check in TaskService, der @Disabled ist entfernt, der Fehlerkörper wird geprüft, und das Javadoc beschreibt jetzt den aktiven Regressionstest. Nichts anderes wurde angefasst." |

---

### Step 6b — Re-Validate the Implemented Fix (IMPL_VALIDATION)

> After `/implement`, FlowGuard does **not** jump straight to review. It re-runs the
> verification checks against the **implemented** code in the new `IMPL_VALIDATION`
> phase. The pre-implementation `/check` (Step 5) ran on the baseline where the
> regression test was still `@Disabled`; this run executes the now-enabled test, so
> the fix is validated **in-flow**, inside the audit trail — not only in the manual
> Step 9 afterwards.

| Action   | Phase                         | What I Say                                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/check` | IMPL_VALIDATION → IMPL_REVIEW | "FlowGuard führt die Prüfungen jetzt gegen den implementierten Code aus. Der zuvor `@Disabled` Regressionstest ist aktiviert und läuft grün — der Fix ist in-flow validiert. Erst dann öffnet FlowGuard das unabhängige Review. Schlägt ein Check hier fehl, geht es zurück in die IMPLEMENTATION (der Code ist falsch, nicht der Plan)." |

---

### Step 7 — Independent Implementation Review

> Under `team` policy, once the post-implementation checks pass (`IMPL_VALIDATION`),
> the implementation still does **not** go straight to the human gate. FlowGuard
> routes the code change through an **independent implementation review**
> (`IMPL_REVIEW`) — a separate phase from the plan review. Reduced ceremony (skipping
> both IMPL_VALIDATION and IMPL_REVIEW) is disabled in `team`.

| Action                                     | Phase                         | What I Say                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host invokes `flowguard-reviewer` subagent | IMPL_REVIEW                   | "FlowGuard hat die Code-Änderung an einen unabhängigen Reviewer-Subagent geschickt — getrennt vom Plan-Review. Der Reviewer prüft: wurde der Bug tatsächlich behoben? Ist der Regressionstest aktiviert? Wurden keine anderen Endpunkte verändert?" |
| Reviewer approves → converge               | IMPL_REVIEW → EVIDENCE_REVIEW | "Der Reviewer attestiert, dass die Implementierung den Plan erfüllt. Erst dann wechselt FlowGuard ins EVIDENCE_REVIEW — das menschliche Gate. Hätte der Reviewer Changes verlangt, ginge es zurück in die Implementation (bis zu 3 Iterationen)."   |

> **Wenn der Reviewer Changes verlangt:** Phase geht `IMPL_REVIEW → IMPLEMENTATION`
> zurück; der Agent liefert frische Evidence, dann erneut Review. Das ist der
> normale Loop, kein Fehler — ruhig live zeigen, falls es passiert.

---

### Step 8 — Final Approval (Human Gate)

| Action     | Phase                      | What I Say                                                                                                                                                                                                                             |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | EVIDENCE_REVIEW → COMPLETE | "Finale menschliche Genehmigung im EVIDENCE_REVIEW-Gate. Die Session ist komplett. In dieser OpenCode-Integration blockiert FlowGuard den Übergang technisch, bis gültige Review-Evidence und die menschliche Entscheidung vorliegen." |

---

### Step 9 — Prove the Fix (post-flow, confirmatory)

> With the `IMPL_VALIDATION` gate (Step 6b), the regression test already ran green
> **inside** the governed flow and audit trail. This manual run is now a
> confirmatory external check, no longer the only proof.

| Action        | What I Say                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./mvnw test` | "Zur Bestätigung außerhalb von FlowGuard: alle 16 Tests grün, null skipped. Der Regressionstest, den FlowGuard in Step 6b schon ausgeführt hat, beweist auch hier: der Bug ist behoben." |

---

### Step 10 — Finish Card: Readiness Check Before Export

| Action                     | What I Say                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/finish`                  | "Bevor ich exportiere, hole ich mit `/finish` die Finish Card — eine read-only Übersicht der Session-Readiness. `/finish` ist ein Status-Aggregator, kein Approval: es approbiert nichts, verbraucht keine Obligations, ändert keinen State und löst kein `/export` aus." |
| Show `/finish` response    | "Die Card zeigt `overallStatus` (hier `READY`), die Evidence-Vollständigkeit, Warnungen und eine **nicht-normative** Action-Guidance (`recommended` / `not_recommended` / `not_verified`). Fehlende Evidence wäre `NOT_VERIFIED`, niemals ein fälschliches Pass."         |
| Point out `actionGuidance` | "`create PR` und `export evidence` sind hier `recommended`. Das sind reine Präsentations-Hinweise — keine Freigabe. Die eigentliche Fail-Closed-Durchsetzung bleibt bei `/export` und den Gates. `abandon` erscheint als Exit-Option, nie als verboten."                  |

---

### Step 11 — Export the Evidence

| Action                   | What I Say                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/export`                | "Ich exportiere das Audit-Archive. FlowGuard erzeugt ein verifizierbares Paket mit allen Artefakten."                                                                                  |
| Show `/export` response  | "Die `/export`-Antwort zeigt: `archiveStatus: verified` und `Session archived and verified.` — FlowGuard hat das Archiv direkt nach der Erstellung verifiziert."                       |
| Show export archive path | "Das Archiv liegt in `~/.config/opencode/workspaces/.../archive/` — außerhalb des Projektverzeichnisses. Es uberlebt Workspace-Resets und ist unabhängig von der aktiven MCP-Session." |

---

### Summary Slide

Ich habe den Regressionstest im Seed bewusst disabled, weil FlowGuard zurecht keinen
fehlschlagenden Baseline-Check in die Implementierung durchlässt. Der Fix besteht deshalb
aus zwei Teilen: Bug beheben und Regressionstest aktivieren. Am Ende beweist der grüne
Testlauf, dass der zuvor dokumentierte Bug wirklich geschlossen wurde.

---

## Part 3 — Review Flow (5–10 min)

> Content-aware review of an external branch. Uses a separate workspace with a
> pre-built branch.

### Precondition

```bash
cd /tmp/flowguard-java-review-demo
```

The branch `feature/add-due-date` already exists. It simulates an external PR:

| File                     | Change                                                      |
| ------------------------ | ----------------------------------------------------------- |
| `Task.java`              | `dueDate` field, getter, setter                             |
| `CreateTaskRequest.java` | `dueDate` field, getter, setter                             |
| `TaskResponse.java`      | **Unchanged** — deliberately omitted (field never exposed)  |
| `TaskService.java`       | **Unchanged** — `createTask()` never persists the new field |

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

| Step | Action                                     | Phase           | What I Say                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `/start`                                   | READY           | "Neue Session im Review-Workspace. `/review` ist ein eigener Flow ab READY."                                                                                                                                                                                                                                                                                                                            |
| R2   | `/review branch=feature/add-due-date`      | REVIEW          | "FlowGuard erkennt content-aware review, erzeugt eine Obligation, blockt mit `CONTENT_ANALYSIS_REQUIRED`."                                                                                                                                                                                                                                                                                              |
| R3   | Host invokes `flowguard-reviewer` subagent | —               | "Der Subagent analysiert den Diff. `dueDate` ist im Model und im Request-DTO — aber es ist _nirgends verdrahtet_: `TaskService.createTask()` schreibt es nicht (nutzt weiter den 4-arg-Konstruktor), und `TaskResponse` gibt es nicht aus. Ein neu gesetztes Fälligkeitsdatum verschwindet also lautlos. Der Reviewer muss diese strukturelle Lücke semantisch erkennen — sie ist kein Compile-Fehler." |
| R4   | Host submits `reviewFindings`              | REVIEW_COMPLETE | "Attestierte Findings eingereicht. FlowGuard validiert: Mandate-Digest, Session-ID-Match, Obligation-ID. Report geschrieben, Flow abgeschlossen."                                                                                                                                                                                                                                                       |

### Expected Flow

1. `/review branch=...` → FlowGuard creates a **review obligation** and blocks with
   `CONTENT_ANALYSIS_REQUIRED`. The host must invoke the `flowguard-reviewer` subagent.
2. Subagent analyses the branch diff. It should infer the omission from the changed
   model/request surface against the unchanged service and response: the new `dueDate`
   field is neither persisted by `createTask()` nor exposed in the API response, so it
   is effectively dead — accepted from the client but silently dropped.
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
  (`origin/HEAD` → local `main` → local `master` fallback). In this local demo
  there is no remote, so detection falls through to local `main`.
- Diff mechanism wrinkle: the runtime branch-diff adapter computes
  `git diff <base>...<branch>`, while the `/review` command template instructs the
  model to fetch the diff via `gh pr diff <branch>`. Both yield the same branch
  diff; `gh pr diff` needs a GitHub remote/PR, so in this local-only demo the
  reviewer works from the `git diff` the adapter provides.
- Do **not** hand-author `reviewFindings`. Let the host/subagent integration
  submit them via the `flowguard-reviewer` subagent.
- The diff between `main` and `feature/add-due-date` contains only the dueDate
  changes. The 404 bug is identical on both branches and does not appear.

---

## Command Reference Notes

FlowGuard ships near-synonym commands; the script picks one of each on purpose.
If someone in the audience knows the other name, this is why both exist:

| Used in demo | Sibling               | Difference                                                                                                                                                                                                                                                                     |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/check`     | `/validate`           | Both call `flowguard_run_check`. `/check` is generic; `/validate` is the VALIDATION-phase-specific variant.                                                                                                                                                                    |
| `/export`    | `/archive`            | Both call `flowguard_archive`. `/export` reads as the user-facing "give me the evidence package" verb.                                                                                                                                                                         |
| `/finish`    | `/status --readiness` | Both are read-only and call `flowguard_status`. `/status --readiness` returns the compact readiness projection; `/finish` additionally derives one `overallStatus`, non-normative action guidance, and exit options as a pre-export Finish Card. Neither approves or enforces. |
| `/approve`   | `/review-decision`    | `/approve` always submits `approve`. `/review-decision` is the general gate command (`approve` \| `changes_requested` \| `reject`). Both route to `flowguard_decision` and both require a human origin under `team`.                                                           |

---

## Known Limitations

- `/plan`, `/implement`, and `/architecture` require an LLM-backed OpenCode instance. Without a model
  backend, these steps will fail or produce empty output.
- Test execution time varies by machine. The `search_tasks_by_query` test uses
  a unique query term to avoid pollution from other tests in the shared Spring context.
- The setup and snippets assume a POSIX shell. They run natively on macOS and Linux.
  macOS ships bash 3.2; `run-demo-setup.sh` stays within 3.2-compatible syntax. On
  Windows use WSL or Git Bash (the committed `mvnw.cmd` covers the Maven side).
- **Pre-recorded fallback:** See `FALLBACK.md`. Keep a recorded run and a frozen
  workspace ready. If the host hangs during `/implement` or `/review`, switch to the
  recording — it shows the same workspace, same flow, same artefacts.
- **Architecture snapshots (`A02-adr-reviewed`, `A03-arch-complete`):** These reproduce
  visible workspace evidence only. They do **not** restore MCP session state (stored in
  `~/.config/opencode/`). After architecture snapshot restore, either start a new session
  or present the snapshot as prerecorded evidence.
- **Reset between Part 1 and Part 2:** Close OpenCode Desktop, run
  `snapshot-demo.sh restore 00-seed`, then reopen the workspace. This creates a fresh
  MCP transport with a new sessionId. The architecture export archive survives the reset
  — it is stored in `~/.config/opencode/workspaces/.../archive/`, outside the workspace.
