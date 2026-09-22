# Demo Script — Java Task Manager

**Audience:** Technical decision makers, engineering leads

## Three Parts — Three Governed Flows

This demo proves three independent FlowGuard flows in one project:

| Part       | Flow         | Duration | What It Proves                                                                                                                             |
| ---------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Part 1** | Architecture | 5–8 min  | Architectural decisions governed through ADR creation, autonomous independent review, human approval, and terminal completion              |
| **Part 2** | Development  | 8–10 min | AI-assisted code changes routed through ticket, plan, review, approval, automatic validation, export, and completion                       |
| **Part 3** | Peer Review  | 5–10 min | External contributions governed through content-aware peer review with host-orchestrated findings, obligation binding, and a review report |

All three flows run in one workspace. Each flow is an independent FlowGuard
session (separate `/start`). The Peer Review Flow uses a branch diff, not the
working tree — it operates independently of Development changes on `main`.

## Prerequisites (run before the demo)

```bash
cd demos/java-task-manager
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo
# Open /tmp/flowguard-java-demo in OpenCode Desktop
```

---

## Part 1 — Architecture Flow (5–8 min)

> Governed architectural decision: the LLM analyses the codebase, generates a
> MADR-format ADR, FlowGuard dispatches an independent reviewer, the reviewer's
> structured findings are captured and bound, and a human decides at
> ARCH_REVIEW. ARCH_COMPLETE is terminal; there is no export rail in this flow.
>
> Steps A0–A6 (7 steps). Step A3 combines ADR generation and autonomous
> independent review into one narrative unit — the audience sees the LLM
> interaction as a single governed round-trip.

### Step A0 — Prove the Bug Exists (context for architecture analysis)

| Action        | What I Say                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `./mvnw test` | "16 Tests, 15 executed, 1 skipped. Der Regressionstest beweist eine Inkonsistenz: `getTask()` prüft auf null, `updateTask()` nicht." |

### Step A1 — Start the Session

| Action                                                      | Phase | What I Say                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`                                                    | READY | "Ich starte eine FlowGuard-Session fur den Architecture Flow. `/start` meldet `team` — human-gated. Der Architecture Flow ist ein eigener Pfad aus READY, getrennt vom Development Flow."                                           |
| Read the `/start` output (`policyResolution.effectiveMode`) |       | "Policy `team`: human-gated, Subagent-Review obligatorisch, keine Auto-Approve. Mit `/status` kann ich diese Lage jederzeit prufen. Der Architecture Flow verwendet dieselbe Subagent-Review-Pipeline wie der Plan-Loop in Part 2." |

### Step A2 — Submit the Architecture Task

| Action                                                           | Phase        | What I Say                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/architecture Read ADR_TICKET.md and create an ADR based on it` | ARCHITECTURE | "Ich ubergebe den Architecture Task mit explizitem Input: der Command liest `ADR_TICKET.md`. FlowGuard erzwingt, dass ein ADR in MADR-Format erstellt wird — mit `## Context`, `## Decision`, `## Consequences`. Der LLM analysiert den Code, erkennt die Inkonsistenz und generiert eine strukturierte Entscheidungsvorlage." |

### Step A3 — ADR Generation and Autonomous Independent Review

| Action                                     | Phase        | What I Say                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM reads ADR_TICKET.md + code             | ARCHITECTURE | "Der LLM liest das Architektur-Ticket, analysiert `TaskRepository.findById()` und die Inkonsistenz zwischen `getTask()` und `updateTask()`, und generiert einen ADR mit Context, Decision, Consequences."                                                                                                                                                                                  |
| `flowguard_architecture` tool call         | ARCHITECTURE | "FlowGuard validiert die ADR-Sections. Fehlen MADR-Sections, blockt das Tool mit `MISSING_ADR_SECTIONS` — der LLM muss nachbessern. Sind alle Sections da, startet FlowGuard die unabhangige Review: Der Host orchestriert eine Reviewer-Child-Session (`reviewInvocation`) und bindet die strukturierten Findings an Obligation, Attempt und Subject-Digest."                             |
| Host-orchestrated reviewer child session   | ARCHITECTURE | "Der Reviewer pruft: ist der Context vollstandig, die Decision konkret, die Consequences ehrlich, die MADR-Struktur korrekt? Der Mensch reicht nichts ein — Reviewer-Dispatch und Findings-Erfassung sind Host-Sache."                                                                                                                                                                     |
| `reviewDispatch` reports the bound verdict | ARCHITECTURE | "Sobald `reviewDispatch.completed` true ist, tragt der Agent nur das gebundene Verdikt aus `reviewDispatch.verdict` nach. Bei `changes_requested` liefert der Agent eine frische Revision, dann startet die nachste Review-Runde automatisch. Das Budget ist begrenzt; erschopft es sich mit `changes_requested`, gilt die Review **nicht** als konvergiert und **nicht** als akzeptiert." |

### Step A4 — Architecture Review Card (ARCH_REVIEW)

| Action                                    | Phase       | What I Say                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture Review Card appears          | ARCH_REVIEW | "Die Architecture Review Card zeigt: ADR-Titel, ID, Digest, Reviewer-Findings (Blocking Issues, Major Risks, Missing Verification), Iteration und die moglichen Entscheidungen. Ein normales Gate bietet `/approve`, `/request-changes` und `/reject`."                                                                                                        |
| Explain the exhausted gate (if it occurs) | ARCH_REVIEW | "Ist das Review-Budget erschopft und wurden Anderungen verlangt, wird dieses Gate zum Governance-Override-Gate: `/approve` wird mit `GOVERNANCE_OVERRIDE_REQUIRED` geblockt. Erlaubt sind nur `/override-approve <Begrundung>`, `/request-changes` und `/reject`; der Override verlangt eine nichtleere Begrundung und bindet exakt den gepruften ADR-Digest." |

### Step A5 — Approve the ADR

| Action     | Phase                       | What I Say                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | ARCH_REVIEW → ARCH_COMPLETE | "Ich genehmige die ADR. FlowGuard schreibt das MADR-Artefakt mit `FlowGuard Decision Status: accepted` im Header und dem Digest des gepruften ADR-Textes (`Reviewed ADR digest`); der eingereichte ADR-Text bleibt unverandert. ARCH_COMPLETE ist ein eigener Terminal-State — getrennt vom COMPLETE des Development Flow." |

### Step A6 — Optional: Archive the Session

> The Architecture Flow has no export rail: ARCH_COMPLETE is the terminal state.
> An optional `/archive` afterwards packages the terminal session.

| Action                | What I Say                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/archive`            | "Optional: `/archive` archiviert die bereits terminale Session. Default ist das redigierte Sharing-Archiv: `packagePurpose: sharing`, `integrityCapability: not_verifiable`, `verificationStatus: not_run`. Das ist ehrlich — die Redaktion schliesst Rohdaten bewusst aus, das ist kein fehlgeschlagener Integritats-Check. Fur Auditoren gibt es das vertrauliche Roh-Export-Paket." |
| Show archive location | "Das Archiv liegt unter `~/.config/opencode/workspaces/.../archive/`. Es uberlebt Workspace-Resets — die Archive sind ausserhalb des Projektverzeichnisses gespeichert."                                                                                                                                                                                                               |

### Exhaustion Moment (optional, ~30 s)

If the live review exhausts its budget with changes requested, do not hide it —
show the override gate as an auditable enterprise statement:

| Action                                                                           | What I Say                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Show the `GOVERNANCE_OVERRIDE_REQUIRED` block                                    | "Budget erschopft heisst: nicht konvergiert und nicht akzeptiert. FlowGuard blockt das normale `/approve`. Der einzige Genehmigungspfad ist jetzt `/override-approve` — zusammen mit `/request-changes` und `/reject`."                                                                                                                                                                          |
| `/override-approve Accepted because <Begrundung>` (optional, only if legitimate) | "Der Override verlangt eine nichtleere, durable Begrundung — ohne sie blockt die Runtime fail-closed mit `GOVERNANCE_OVERRIDE_RATIONALE_REQUIRED`. Er wird explizit auditiert und bindet exakt den gepruften Digest. Das ist die belastbare Unternehmensaussage: Ein Mensch hat die Verantwortung fur eine nicht konvergierte Review bewusst und begrundet ubernommen — kein stiller Fail-Open." |

### Transition to Part 2

Close OpenCode Desktop, reopen the same workspace, `/start` a fresh session.
No snapshot restore is needed — the Architecture Flow does not modify files.
OpenCode reconnecting creates a new MCP transport (new sessionId), so the
Development Flow starts from a clean READY state.

### Architecture Guardrails

- Maximum 1 unplanned subagent revision before switching to the `A02-adr-reviewed-visual-only` snapshot (visual evidence only).
- Architecture snapshots (`A02-adr-reviewed-visual-only`, `A03-arch-complete-visual-only`) are **visual only**: they restore workspace files and never FlowGuard session authority. Session state, review obligations, audit chain, review cycles, and human decisions live outside the workspace. See `FALLBACK.md`.

### Architecture Stop Points

- **Stop A1** (ADR generation latency): restore `00-seed-visual-only`, reopen OpenCode, retry `/architecture`.
- **Stop A2** (reviewer iteration overflow): switch to `A02-adr-reviewed-visual-only` snapshot — visual only.
- **Stop A3** (ARCH_REVIEW time pressure): switch to `A03-arch-complete-visual-only` snapshot — visual only.

---

## Part 2 — Development Flow (8–10 min)

> Governed code change: the bug is fixed through ticket, plan, autonomous plan
> review, human approval, automatic validation, implementation, automatic
> post-implementation validation, independent implementation review, export,
> and completion. Completion is possible only after `/export` materializes and
> verifies the required package.

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

| Action                                           | Phase  | What I Say                                                                                                                                                                                                      |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/task Read TICKET.md and fix the described bug` | TICKET | "Ich übergebe das Ticket mit explizitem Input (`Read TICKET.md …`). `/task` konsumiert den Text als Task-Beschreibung; FlowGuard erzwingt anschließend, dass jede Änderung von einem erfassten Ticket ausgeht." |

---

### Step 2a — Prove Enforcement (the forbidden transition)

| Action       | Phase  | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/implement` | TICKET | "Ich versuche direkt zu implementieren — ohne Plan, ohne Review, ohne Freigabe. Der kanonische Command lässt den illegalen Pfad gar nicht erst beginnen: sein Preflight erkennt die falsche Phase und stoppt ohne Tool-Aufruf. Die darunterliegende Runtime lehnt den Übergang ebenfalls ab — eine direkte `flowguard_implement`-Invocation wird vom Machine Gate mit `COMMAND_NOT_ALLOWED` geblockt; die Directive meldet `PLAN_REQUIRED` (\"Plan required\") und lässt nur `/plan` zu. Erst Plan, unabhängige Prüfung, menschliche Freigabe und Validation öffnen die Implementierungsphase." |

---

### Step 3 — Generate the Plan

| Action                            | Phase       | What I Say                                                                                                                                                                                                    |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan`                           | PLAN        | "Der LLM analysiert den Code und erstellt einen Plan. Wichtig: Der Plan ist ein Dokument. Kein Code wird geändert."                                                                                           |
| Automatic independent plan review | PLAN_REVIEW | "FlowGuard hat den Plan automatisch an eine unabhängige Reviewer-Session geschickt und die strukturierten Findings an Obligation, Attempt und Subject-Digest gebunden. Der Mensch reicht keine Findings ein." |
| Show Plan Review Card             |             | "Das ist die Plan Review Card. Sie zeigt den Plan, die Reviewer-Findings und die möglichen Entscheidungen: `/approve`, `/request-changes`, `/reject`."                                                        |

---

### Step 4 — Approve the Plan

| Action     | Phase                                            | What I Say                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | PLAN_REVIEW → VALIDATION → IMPLEMENTATION (auto) | "Ich genehmige den Plan. FlowGuard wechselt in die Validierungsphase — und führt die aktiven Checks dort sofort automatisch aus. Die Antwort des Approval-Calls ist bereits das Validierungsergebnis: die Evidence ist persistiert und die Phase steht auf IMPLEMENTATION. Kein Code wurde bisher angerührt." |

---

### Step 5 — Automatic Validation (no user command)

> The directive says: "No action required; FlowGuard runs the approved
> validation automatically." There is no user-typed check command in the
> canonical walkthrough: the runtime executes the active checks in-flow through
> the `flowguard_run_check` evidence path, and each result is bound to the audit
> trail.

| Action                               | Phase                       | What I Say                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic (in-flow, no user command) | VALIDATION → IMPLEMENTATION | "Kein User-Kommando: die Runtime führt die aktiven Checks in-flow über den `flowguard_run_check`-Evidenzpfad aus. `npm run build` startet `./mvnw verify`; `npm run test` führt die vollständige Maven-Test-Suite aus (`./mvnw test`, 16 Tests). Im Baseline bleibt der Regressionstest noch `@Disabled`, deshalb sind beide Checks grün. Erst `ALL_PASSED` öffnet die Implementierungsphase." |

---

### Step 6 — Implement the Fix

| Action          | Phase          | What I Say                                                                                                                                                                                                                     |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/implement`    | IMPLEMENTATION | "Jetzt implementiert der LLM den Fix. Der Agent darf nicht einfach nur den Test aktivieren — er muss den Bugfix liefern, den Test aktivieren, die `taskId`-Fehlerantwort prüfen und das Baseline-Javadoc aktualisieren."       |
| Show `git diff` | IMPLEMENTATION | "Hier sehen Sie die Änderung: ein kleiner null-Check in TaskService, der @Disabled ist entfernt, der Fehlerkörper wird geprüft, und das Javadoc beschreibt jetzt den aktiven Regressionstest. Nichts anderes wurde angefasst." |

---

### Step 6b — Automatic Post-Implementation Validation (IMPL_VALIDATION)

> After `/implement`, FlowGuard does **not** jump straight to review. It re-runs
> the verification checks against the **implemented** code automatically in the
> `IMPL_VALIDATION` phase. The pre-implementation validation (Step 5) ran on the
> baseline where the regression test was still `@Disabled`; this run executes
> the now-enabled test, so the fix is validated **in-flow**, inside the audit
> trail — not only in the manual Step 9 afterwards.

| Action                               | Phase                         | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automatic (in-flow, no user command) | IMPL_VALIDATION → IMPL_REVIEW | "Kein User-Kommando: FlowGuard führt beide Prüfungen jetzt gegen den implementierten Code aus — der vollständige Build (`./mvnw verify`) und die vollständige Maven-Test-Suite (`./mvnw test`, inklusive des jetzt aktiven Regressionstests). Der zuvor `@Disabled` Regressionstest ist aktiviert und läuft grün. Die zwei unterschiedlichen Validation Attempts sind getrennt an positive und adversariale Evidence gebunden. Erst `ALL_PASSED` öffnet das unabhängige Review. Schlägt ein Check fehl, geht es zurück in die IMPLEMENTATION (der Code ist falsch, nicht der Plan)." |

---

### Step 6c — Inspect the Automatically Materialized ProofGraph

> The approved plan claims are automatically materialized when the implementation
> checks complete. The certified happy path does not call
> `flowguard_declare_contract`: manually declared claims are a separate advisory
> path and are demonstrated in their own session.

| Action                                   | Phase       | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flowguard_status({ proofGraph: true })` | IMPL_REVIEW | "Die detaillierte `proofGraph`-Projektion zeigt die zwei Fact-Claims samt getrennten Build- und Test-References. `persistedProofGraph` zeigt `contractClaimCount: 2`, `provenCount: 2` und `coverage: PROVEN`. `proofApprovals` zeigt Plan-Certificate, Implementation-Digest sowie Evidence- und Counterexample-Ref-Counts. `proofGraphGate.gated: false` erklärt separat, warum nur die certificate-autorisierten Facts die finale Freigabe beeinflussen. `PROVEN` ersetzt weder unabhängiges Review noch das Human Gate." |

---

### Step 7 — Independent Implementation Review (IMPL_REVIEW)

> Under `team` policy, once the post-implementation checks pass, FlowGuard
> dispatches an **independent implementation review** in `IMPL_REVIEW` — a
> separate phase from the plan review. The reviewer is host-orchestrated and
> host-observed; the human never submits findings. Reduced ceremony (skipping
> `IMPL_VALIDATION` and `IMPL_REVIEW`) is disabled in `team`.

| Action                                                | Phase                         | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-orchestrated reviewer child session              | IMPL_REVIEW                   | "FlowGuard hat die Code-Änderung an eine unabhängige Reviewer-Session geschickt — getrennt vom Plan-Review. Der Reviewer prüft: wurde der Bug tatsächlich behoben? Ist der Regressionstest aktiviert? Wurden keine anderen Endpunkte verändert?"                                                                                                                                                                                                     |
| `reviewDispatch.completed` → submit the bound verdict | IMPL_REVIEW → EVIDENCE_REVIEW | "Sobald `reviewDispatch.completed` true ist, trägt der Agent nur das gebundene Verdikt aus `reviewDispatch.verdict` nach — keine selbst formulierten Findings. Bei `accept` konvergiert die Review und FlowGuard wechselt ins EVIDENCE_REVIEW, das menschliche Gate. Bei `changes_requested` geht es zurück in die IMPLEMENTATION: Der Agent liefert frische Evidence, die Checks laufen erneut, dann startet die nächste Review-Runde automatisch." |
| Implementation Review Card                            | EVIDENCE_REVIEW               | "Die Implementation Review Card zeigt die geprüfte Revision, die Reviewer-Findings und die Entscheidungen: `/approve`, `/request-changes`, `/reject`."                                                                                                                                                                                                                                                                                               |

> **Wenn der Reviewer Changes verlangt:** Phase geht `IMPL_REVIEW → IMPLEMENTATION`
> zurück; der Agent liefert frische Evidence, dann erneut Validierung und Review.
> Das ist der normale, begrenzte Loop, kein Fehler — ruhig live zeigen, falls er
> passiert. Ist das Budget mit `changes_requested` erschöpft, wird das Human Gate
> zum Governance-Override-Gate (siehe Step 8).

---

### Step 8 — Final Human Gate (EVIDENCE_REVIEW)

| Action                     | Phase                          | What I Say                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve`                 | EVIDENCE_REVIEW → EXPORT_READY | "Finale menschliche Genehmigung im EVIDENCE_REVIEW-Gate. FlowGuard wechselt nach EXPORT_READY — die Session ist **noch nicht** COMPLETE. Ein normales Gate bietet `/approve`, `/request-changes` und `/reject`."                                                                                                                                                                 |
| Explain the exhausted gate | EVIDENCE_REVIEW                | "Ist das Implementierungs-Review erschöpft und wurden Änderungen verlangt, wird das Gate zum Governance-Override-Gate: `/approve` wird mit `GOVERNANCE_OVERRIDE_REQUIRED` geblockt. Erlaubt sind nur `/override-approve <Begrundung>`, `/request-changes` und `/reject`; der Override verlangt eine nichtleere Begrundung und bindet exakt den geprüften Implementation-Digest." |

---

### Step 9 — Prove the Fix (post-flow, confirmatory)

> With the `IMPL_VALIDATION` phase (Step 6b), the regression test already ran
> green **inside** the governed flow and audit trail. This manual run is now a
> confirmatory external check, no longer the only proof.

| Action        | What I Say                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./mvnw test` | "Zur Bestätigung außerhalb von FlowGuard: alle 16 Tests grün, null skipped. Der Regressionstest, den FlowGuard in Step 6b schon ausgeführt hat, beweist auch hier: der Bug ist behoben." |

---

### Step 10 — Finish Card: Readiness Check Before Export

| Action                     | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/finish`                  | "Vor dem Export hole ich mit `/finish` die Finish Card — eine read-only Übersicht der Session-Readiness. `/finish` ist ein Status-Aggregator, kein Approval: es approbiert nichts, verbraucht keine Obligations, ändert keinen State und löst weder `/export` noch `/archive` aus."                                                                                                                                                                                |
| Show `/finish` response    | "Die Card zeigt `overallStatus` (hier `READY`), die Evidence-Vollständigkeit, Warnungen und eine **nicht-normative** Action-Guidance (`recommended` / `not_recommended` / `not_verified`). Fehlende Evidence wäre `NOT_VERIFIED`, niemals ein fälschliches Pass."                                                                                                                                                                                                  |
| Point out `actionGuidance` | "Die Guidance ist directive-aware: `export evidence` ist `recommended` — die Directive verlangt hier `/export` als Completion-Commit. `create PR` und `keep branch` stehen auf `not_recommended`, weil die Session vor dem Export noch nicht abgeschlossen ist. Das sind reine Präsentations-Hinweise — keine Freigabe. Die eigentliche Fail-Closed-Durchsetzung bleibt beim `/export`-Rail und den Gates. `abandon` erscheint als Exit-Option, nie als verboten." |

---

### Step 11 — Export and Complete

> Completion is possible only after `/export` (`flowguard_export`) materializes
> and verifies the required package and persists `ExportCompletionEvidence`. A
> blocked or failed export stays in `EXPORT_READY`; only `EXPORT_MATERIALIZED`
> reaches `COMPLETE`.

| Action                | What I Say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/export`             | "Erst `/export` materialisiert und verifiziert das erforderliche Paket und persistiert `ExportCompletionEvidence` — genau dieser Übergang führt `EXPORT_READY → COMPLETE`. Die Antwort trägt die typisierte `exportCompletion`-Projektion mit Paket-Digest, `purpose`, `integrityCapability: verifiable` und `verificationStatus: passed`; die Werte sind damit direkt aus dem Tool-Ergebnis ablesbar, nicht nur im State. Ein blockierter oder fehlgeschlagener Export bleibt in EXPORT_READY und darf nicht als complete beschrieben werden." |
| `/archive` (optional) | "Optional danach: `/archive` ist **kein** Synonym fur `/export`. Es archiviert die bereits terminale Session und erzeugt das redigierte Sharing-Archiv (`integrityCapability: not_verifiable`, `verificationStatus: not_run`). Nur terminale Sessions konnen archiviert werden."                                                                                                                                                                                                                                                                |
| Show archive location | "Das Archiv liegt in `~/.config/opencode/workspaces/.../archive/` — außerhalb des Projektverzeichnisses. Es überlebt Workspace-Resets und ist unabhängig von der aktiven MCP-Session."                                                                                                                                                                                                                                                                                                                                                          |

---

### Summary Slide

Ich habe den Regressionstest im Seed bewusst disabled, weil FlowGuard zurecht keinen
fehlschlagenden Baseline-Check in die Implementierung durchlässt. Der Fix besteht deshalb
aus zwei Teilen: Bug beheben und Regressionstest aktivieren. Am Ende beweist der grüne
Testlauf, dass der zuvor dokumentierte Bug wirklich geschlossen wurde. Die Session ist
erst nach `/export` COMPLETE — der Export ist der Commit-Schritt, nicht das Archivieren.

---

## Part 3 — Peer Review Flow (5–10 min)

> Content-aware peer review of an external branch. The Peer Review Flow uses a
> branch diff, not the working tree — it operates independently of the
> Development changes on `main`. No separate workspace is needed. The reviewer
> is host-orchestrated and host-observed: the human never submits review
> findings, and there is no approval gate.

### Precondition

```bash
# Same workspace — no additional setup required.
cd /tmp/flowguard-java-demo
git branch --list
# Expected: feature/add-due-date, *main
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

| Step | Action                                       | Phase                              | What I Say                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | `/start`                                     | READY                              | "Neue Session. `/review` startet den Peer Review Flow direkt aus READY — alle drei Flows laufen im selben Workspace."                                                                                                                                                                                                                                                                                              |
| R2   | `/review` with `branch=feature/add-due-date` | READY → PEER_REVIEW                | "FlowGuard erkennt content-aware review und startet den Peer Review Flow als autonome Systemarbeit — keine User-Action, kein Approval-Gate. Der Host orchestriert die Reviewer-Child-Session (`reviewInvocation`); die strukturierten Findings werden erfasst und an Obligation, Attempt und Subject-Digest gebunden. Der Mensch reicht nichts ein."                                                               |
| R3   | Host-observed reviewer child session         | PEER_REVIEW                        | "Der Reviewer analysiert den gefrorenen Diff. `dueDate` ist im Model und im Request-DTO — aber es ist _nirgends verdrahtet_: `TaskService.createTask()` schreibt es nicht (nutzt weiter den 4-arg-Konstruktor), und `TaskResponse` gibt es nicht aus. Ein neu gesetztes Fälligkeitsdatum verschwindet also lautlos. Der Reviewer muss diese strukturelle Lücke semantisch erkennen — sie ist kein Compile-Fehler." |
| R4   | `reviewDispatch.completed` → review report   | PEER_REVIEW → PEER_REVIEW_COMPLETE | "FlowGuard bindet das Reviewer-Verdikt (`reviewDispatch.verdict`) und schreibt den Review Report. `changes_requested` ist ein gültiges Review-Ergebnis, keine Workflow-Anweisung. Der Flow endet terminal in PEER_REVIEW_COMPLETE — ohne Approval-Gate."                                                                                                                                                           |

### Expected Flow

1. `/review` with `branch=...` starts READY → PEER_REVIEW as autonomous system
   work: no user action is required while the review runs.
2. The host orchestrates the independent reviewer child session. FlowGuard
   captures and binds the structured findings (obligation, attempt, subject
   digest); the reviewer dispatch contract is
   `reviewDispatch: { required, completed?, verdict? }` plus `reviewInvocation`.
   There is no legacy `next` field.
3. The reviewer analyses the frozen branch diff. It should infer the omission
   from the changed model/request surface against the unchanged service and
   response: the new `dueDate` field is neither persisted by `createTask()` nor
   exposed in the API response, so it is effectively dead — accepted from the
   client but silently dropped.
4. When `reviewDispatch.completed` is reported, FlowGuard binds the verdict,
   writes the review report, and auto-advances to the terminal
   PEER_REVIEW_COMPLETE. The human never submits review findings.

### Review Report Card — Target Coverage

The review report card shows explicit target coverage; every field is persisted
with the peer review report:

- Target resolved
- Target frozen
- Repository identity
- Base SHA
- Head SHA
- Changed paths
- Objectives covered
- Review assurance
- Missing verification

The card also shows the findings grouped by severity and the evidence block
(obligation ID, invocation source and mode, reviewer session, review assurance).

### What This Proves

- FlowGuard governiert **nicht nur eigene Änderungen** (Development Flow),
  sondern auch **externe Contributions** (Peer Review Flow) — ein PR-like
  Branch-Diff wird durch denselben unabhängigen Reviewer-Mechanismus geprüft.
- Der Reviewer findet **echte strukturelle Probleme**, nicht nur oberflächliche
  Checks.
- Drei Sessions im **selben Workspace** sind unabhängig — jede mit eigenem
  Audit-Trail und Evidence. Die Branch-Diff-basierte Peer Review ist immun gegen
  Working-Tree-Änderungen auf `main`.

### Notes

- The base branch is auto-detected by FlowGuard's Git detection path
  (`origin/HEAD` → local `main` → local `master` fallback). In this local demo
  there is no remote, so detection falls through to local `main`.
- FlowGuard's branch-diff adapter resolves and freezes base and head commits and
  materializes the canonical diff; the local demo needs no remote.
- The human never submits review findings. The review is host-orchestrated and
  host-observed, and the only verdict the agent relays is the bound
  `reviewDispatch.verdict`.
- `/review` is terminal orientation, not a decision gate; `changes_requested`
  is a valid outcome. After PEER_REVIEW_COMPLETE the session may optionally be
  `/archive`d.
- The diff between `main` and `feature/add-due-date` contains only the dueDate
  changes. The 404 bug is identical on both branches and does not appear.

---

## Command Reference Notes

FlowGuard ships near-synonym commands; the script picks one of each on purpose.
If someone in the audience knows the other name, this is why both exist:

- **`/check` vs `/validate`:** both are compatibility-only surfaces that call
  `flowguard_run_check` (`/check` is the generic surface, `/validate` the
  phase-specific variant). The canonical walkthrough does not type them:
  validation runs automatically in-flow through the `flowguard_run_check`
  evidence path.
- **`/export` vs `/archive`:** `/export` is the canonical completion step at
  EXPORT_READY (tool `flowguard_export`). It materializes and verifies the
  required package, persists `ExportCompletionEvidence`, and only then reaches
  COMPLETE; a blocked or failed export stays in EXPORT_READY. `/archive` is an
  operational action for **terminal** sessions only and defaults to a redacted
  sharing archive (`integrityCapability: not_verifiable`,
  `verificationStatus: not_run`). They are **not** synonyms.
- **`/finish` vs `/status`:** both are read-only and call `flowguard_status`.
  `/status` returns the status projection; `/finish` additionally derives the
  pre-export Finish Card (`overallStatus`, non-normative `actionGuidance`, exit
  options). Neither approves anything.
- **`/approve` vs `/override-approve`:** a normal gate offers `/approve`,
  `/request-changes`, and `/reject`. An **exhausted** review gate blocks plain
  `/approve` with `GOVERNANCE_OVERRIDE_REQUIRED`: the only approval path is
  `/override-approve` (plus `/request-changes` and `/reject`), and the override
  binds the exact reviewed subject digest. Compatibility surface:
  `/review-decision` submits an explicit verdict.

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
  workspace ready. If the host hangs during `/implement`, `/architecture`, or
  `/review`, switch to the recording — it shows the same workspace, same flow,
  same artefacts.
- **Snapshots are VISUAL ONLY:** every snapshot label ends in `-visual-only`
  (`00-seed-visual-only`, `01-plan-approved-visual-only`,
  `02-implemented-visual-only`, `03-export-ready-visual-only`,
  `04-exported-visual-only`, `A02-adr-reviewed-visual-only`,
  `A03-arch-complete-visual-only`). A snapshot restores workspace files only and
  **never** restores or resumes FlowGuard session authority: session state,
  review obligations, audit chain, review cycles, and human decisions live
  outside the workspace. Live recovery = start a fresh session or use the
  prerecorded reference run.
- **Transition between Part 1 and Part 2:** Close OpenCode Desktop, reopen the same
  workspace. No snapshot restore is needed — the Architecture Flow does not modify files.
  A fresh MCP transport gives a clean READY session for the Development Flow.
- **Verified auditor export:** Development completion via `/export` materializes
  the required verifiable package (no arguments; `integrityCapability: verifiable`,
  `verificationStatus: passed`) and persists `ExportCompletionEvidence`. A manual
  raw-evidence **archive** for auditors additionally requires global
  `archive.redaction.allowRawExport=true` and the explicit archive invocation with
  `redactionMode=none` and `includeRaw=true`. It contains unredacted evidence and
  must be handled as confidential material. The default redacted sharing archive
  reports `integrityCapability: not_verifiable` and `verificationStatus: not_run` —
  intentional redaction, not a failed integrity check.
