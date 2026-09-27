# Reduced-Ceremony Demo — A/B Comparison on the Java Task Manager

**Audience:** Technical decision makers, engineering leads

This scenario adds a risk-based comparison to the existing Java Task Manager
demo. It reuses the same Maven project, the same quality checks, and the same
documentation task for both runs — the only difference is the frozen policy:

| Scenario               | Change                        | Policy                              | Expected outcome                                                 |
| ---------------------- | ----------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| **A** (DEMO_SCRIPT.md) | Java bugfix + regression test | team, reduced ceremony disabled     | full independent implementation review                           |
| **B** (`reduced-on`)   | `docs/usage-notes.md`         | team, `allowReducedCeremony: true`  | complete post-impl checks → review waiver → human evidence gate  |
| **C** (`reduced-off`)  | `docs/usage-notes.md`         | team, `allowReducedCeremony: false` | complete post-impl checks → full independent review → human gate |

B and C are a controlled comparison: same seed commit, same team policy, same
active checks (`build`, `test`), same TRIVIAL risk claim, same task. Only
`policy.allowReducedCeremony` differs.

> Reduced ceremony (#819, PR #963) never skips post-implementation validation.
> `IMPL_VALIDATION` always runs every active check. Only the **independent
> implementation review** (`IMPL_REVIEW`) is waived — and only after FlowGuard
> has runtime evidence that the delivered change is TRIVIAL. The human
> `EVIDENCE_REVIEW` gate and the `/export` completion commit remain mandatory.
> See `docs/configuration.md` (`policy.allowReducedCeremony`) for the exact
> conditions.

---

## Prerequisites

Same as `README.md`, plus:

- **Until PR #963 is merged**, build the demo tarball from that PR head:

  ```bash
  # from the governed-runtime repository root
  git fetch origin pull/963/head:pr-963-reduced-ceremony
  git checkout pr-963-reduced-ceremony
  npm ci
  npm run build
  npm run pack:checksums
  # use the produced flowguard-core-*.tgz with the setup script below —
  # pack:checksums also writes the checksums.sha256 required next to it
  ```

  After the merge, build the tarball from `develop` as usual.

- JDK 21+, Node.js 22+, OpenCode CLI (`opencode`) in PATH.

## Setup — Two Workspaces, One Seed

```bash
cd demos/java-task-manager
./run-reduced-ceremony-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-reduced-demo
```

The script reuses `run-demo-setup.sh` and creates two fresh workspaces from the
same seed:

| Workspace                                 | `.opencode/flowguard.json`                                       |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `/tmp/flowguard-reduced-demo/reduced-on`  | `policy.defaultMode: team`, `policy.allowReducedCeremony: true`  |
| `/tmp/flowguard-reduced-demo/reduced-off` | `policy.defaultMode: team`, `policy.allowReducedCeremony: false` |

Both configurations are written **explicitly** (not left to preset defaults)
and the script fails closed unless the two workspaces are identical except for
`policy.allowReducedCeremony`: same committed seed tree, same `package.json`
checks (`build` → `./mvnw verify`, `test` → `./mvnw test`), same
`TICKET_DOCS.md`.

The policy must be configured **before** `/start` — it is frozen into the
session snapshot at session start.

Open the two workspaces in OpenCode Desktop (one at a time is fine) and follow
the scenarios below.

---

## Scenario B — Reduced Ceremony Enabled

### Step B1 — Start the Session

| Action   | Phase | What I Say                                                                                                                                                                 |
| -------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start` | READY | "`/start` meldet Policy `team` — human-gated. Zusätzlich ist in `.opencode/flowguard.json` `allowReducedCeremony: true` gesetzt; das ist die einzige Differenz zu Lauf C." |

### Step B2 — Verify the Runtime Selection (preflight)

```bash
./run-reduced-ceremony-demo-setup.sh --verify-session /tmp/flowguard-reduced-demo/reduced-on
# Expected:
#   activeChecks: [build, test]
#   PASS  activeChecks selected as build + test
```

Only with this PASS may the demonstration speak of "2/2" later. The setup
script proves the static preconditions; this read-only check proves FlowGuard
actually selected both checks in the running session.

### Step B3 — Declare the Risk Claim

Reduced ceremony requires an explicit `claimedTaskClass: "TRIVIAL"`; the
runtime still computes the minimum class independently and never lets the
claim choose pipeline depth by itself.

| Action                                                    | Phase | What I Say                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call `flowguard_hydrate({ claimedTaskClass: "TRIVIAL" })` | READY | "Ich melde die Risikoklasse explizit als TRIVIAL — Voraussetzung für die reduzierte Ceremony. FlowGuard übernimmt den Claim nicht blind: Der Runtime-Risikoclassifier berechnet das Minimum unabhängig aus den geänderten Dateien." |

A follow-up hydrate call on an existing session may only update
`claimedTaskClass` — the frozen policy from `/start` is not re-resolved.

### Step B4 — Record the Docs Task

| Action                                                           | Phase  | What I Say                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/task Read TICKET_DOCS.md and create the requested usage notes` | TICKET | "Der Task ist bewusst nicht-trivialem Code entgegengesetzt: nur eine neue `docs/usage-notes.md`, keine Java-Quelle, keine Tests. Die Akzeptanzkriterien kommen explizit aus `TICKET_DOCS.md`." |

### Step B5 — Plan, Plan Review, Approval, Baseline Checks

| Action                            | Phase                                     | What I Say                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan`                           | PLAN                                      | "Der Plan beschreibt ausschließlich die neue Doku-Datei."                                                                                                                         |
| Automatic independent plan review | PLAN_REVIEW                               | "Der Plan-Review läuft **immer** — Reduced Ceremony betrifft nur den Implementierungs-Review."                                                                                    |
| `/approve`                        | PLAN_REVIEW → VALIDATION → IMPLEMENTATION | "Mit der Plan-Freigabe führt FlowGuard die aktiven Checks automatisch gegen den Baseline-Stand aus: `./mvnw verify` (build) und `./mvnw test` (test). Kein Code wurde angerührt." |

### Step B6 — Implement the Docs Change

| Action       | Phase          | What I Say                                                                                                                                                         |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/implement` | IMPLEMENTATION | "Der Agent erstellt `docs/usage-notes.md` — die einzige Änderung. Danach laufen die Post-Implementation-Checks automatisch erneut, jetzt gegen die Doku-Revision." |

FlowGuard runs both active checks automatically in `IMPL_VALIDATION`. When every
check has a latest decisive PASS bound to the current implementation, the
runtime evaluates the reduced-ceremony decision, re-attests the frozen bytes and
advances via the explicit `REDUCED_CEREMONY` transition directly to the human
`EVIDENCE_REVIEW` gate.

### Step B7 — The Four Proofs

#### Proof 1 — Complete Post-Implementation Checks (never skipped)

```text
/status --evidence
```

Expect the completeness slot `implValidation` with detail
`post-impl 2/2 passed`. The `IMPL_VALIDATION` phase always ran — no shortcut.

#### Proof 2 — Applied Decision and Projected Waiver

```text
/status
```

Expect `reducedCeremony: { status: "applied", reason: "POST_IMPL_VERIFIED_TRIVIAL" }`
and `evidenceSummary.waived: 1`. In `/status --evidence`, the `implReview` slot
reports status `waived` with detail
`waived by reduced ceremony (POST_IMPL_VERIFIED_TRIVIAL)`.

There is **no synthetic review**: `state.implReview` stays `null`; the waiver is
a projection of the validated reduced-ceremony decision, never a fabricated
review verdict.

#### Proof 3 — Human Gate and Export Still Required

| Action     | Phase                          | What I Say                                                                                                                                                        |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | EVIDENCE_REVIEW → EXPORT_READY | "Der Waiver ersetzt nur den unabhängigen Implementierungs-Review. Das menschliche Evidence-Gate bleibt Pflicht — hier genehmige ich explizit."                    |
| `/export`  | EXPORT_READY → COMPLETE        | "Erst `/export` materialisiert und verifiziert das Paket und persistiert `ExportCompletionEvidence`. Reduced Ceremony verkürzt den Review, nicht die Completion." |

### Step B8 — Proof 4: Durable Audit Event

After `/export`, the canonical audit trail in the export package contains
`reduced_ceremony_applied`. Locate the actual archive in the session workspace
and determine the real member name first:

```bash
SESSION_ID="<session id from /status>"
PKG=$(find "$HOME/.config/opencode/workspaces" -type f -name "$SESSION_ID.tar.gz" -print -quit)
MEMBER=$(tar -tzf "$PKG" | grep '/audit/audit.jsonl$' | head -n 1)
tar -xOzf "$PKG" "$MEMBER" | grep reduced_ceremony_applied
```

The member is prefixed with the session id (e.g.
`<session-id>/audit/audit.jsonl`); the `tar -tzf` step resolves it instead of
assuming a layout. Optionally cross-check the whole package offline:

```bash
node demos/java-task-manager/verify-evidence-package.mjs "$PKG" --expect-session "$SESSION_ID"
```

Result of scenario B:

- Phase: `COMPLETE` (after `/export`).
- `implReview`: `null` (waived, never synthesized).
- `reducedCeremony.status`: `applied`, reason `POST_IMPL_VERIFIED_TRIVIAL`.
- Audit: `reduced_ceremony_applied` in the export package.

---

## Scenario C — Reduced Ceremony Disabled

Identical until the post-implementation checks; the claim is also `TRIVIAL`, so
the only difference is the frozen policy value.

### Step C1 — Start + Claim

| Action                                               | Phase | What I Say                                                                                                                               |
| ---------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`                                             | READY | "Dieser Workspace hat `allowReducedCeremony: false` — explizit gesetzt, damit der Vergleich nicht von späteren Preset-Defaults abhängt." |
| `flowguard_hydrate({ claimedTaskClass: "TRIVIAL" })` | READY | "Derselbe TRIVIAL-Claim wie in Lauf B. Die Policy verbietet die Reduktion trotzdem — genau das ist der Vergleichspunkt."                 |

### Step C2 — Same Task, Same Checks

`/task Read TICKET_DOCS.md and create the requested usage notes`, `/plan`,
`/approve`, automatic baseline checks — identisch zu B.

### Step C3 — Full Implementation Review

After `/implement`, the automatic post-implementation checks run, but the
reduced-ceremony decision is statically ineligible (`POLICY_REDUCED_CEREMONY_DISABLED`).
The machine takes the normal `IMPL_VALIDATION → IMPL_REVIEW` transition; while
still in `IMPL_VALIDATION`, `/status` reports
`reducedCeremony.status: "ineligible"`.

| Action                                                | Phase                         | What I Say                                                                                                      |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Host-orchestrated reviewer child session              | IMPL_REVIEW                   | "Dieselben Checks, dieselbe Evidence — aber jetzt prüft eine unabhängige Reviewer-Session den Doku-Diff."       |
| `reviewDispatch.completed` → submit the bound verdict | IMPL_REVIEW → EVIDENCE_REVIEW | "Der Agent trägt nur das gebundene Reviewer-Verdikt nach. Danach das menschliche Gate und wie in B der Export." |

`/status --evidence` now shows the `implReview` slot with a real iteration and
verdict instead of `waived`.

### Step C4 — Approval and Export

`/approve` at `EVIDENCE_REVIEW` → `EXPORT_READY`, then `/export` →
`COMPLETE`. Identisch zu B.

---

## Comparison Summary

| Observable                      | B (`reduced-on`)                         | C (`reduced-off`)               |
| ------------------------------- | ---------------------------------------- | ------------------------------- |
| Post-implementation checks      | `post-impl 2/2 passed`                   | `post-impl 2/2 passed`          |
| Reduced-ceremony decision       | `applied` (`POST_IMPL_VERIFIED_TRIVIAL`) | `ineligible` (policy)           |
| Completeness slot `implReview`  | `waived` (no synthetic verdict)          | real reviewer iteration/verdict |
| Audit events                    | `reduced_ceremony_applied`               | normal full-ceremony trail      |
| Human evidence gate + `/export` | mandatory                                | mandatory                       |
| Runtime-owned checks / evidence | identical                                | identical                       |

The message: FlowGuard removes review ceremony **only** where the runtime can
prove the delivery is TRIVIAL — and never removes verification, the human gate,
or the export commit. The Java bugfix in scenario A keeps the full review.

## Known Limitations

- The live B/C runs require OpenCode Desktop and an LLM backend; they are
  **NOT_VERIFIED** until actually executed. The documentation contract is
  covered by `src/documentation/__tests__/demo-contract.test.ts` and
  `java-demo-contract.test.ts`.
- The plan review is never waived; only the implementation review can be.
- The prose of `docs/usage-notes.md` varies per model run; the governance
  outcomes (classification, checks, decision, gates) are deterministic.
- Without the explicit TRIVIAL claim, reduction is denied with
  `TASK_CLASS_CLAIM_MISSING` — the claim is a visible operator statement, not an
  implicit assumption.
- The setup script verifies the static preconditions and the parity of both
  workspaces; `--verify-session` verifies the runtime `activeChecks` selection.
