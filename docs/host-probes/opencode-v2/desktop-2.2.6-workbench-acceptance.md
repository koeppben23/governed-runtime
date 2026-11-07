# OpenCode Desktop 2.2.6 — Review Workbench installed acceptance

**Status:** `PASS` for the installed Review Workbench on OpenCode Desktop 2.2.6:
READY, real PLAN-pending fail-closed, complete bound PLAN_REVIEW, native
revision-bound approval, stale-decision rejection, implementation/evidence
review, BLOCKED recovery, narrow layout, light mode and decision-dialog keyboard
navigation. The active-profile uninstall was deliberately not run; the isolated
install/uninstall exercise remains `PARTIAL`. The prior Panel/Slot evidence for
`52d0a3bd` remains valid for that earlier artifact only.

## Installed verification record — 2026-11-07

### Artifact

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `aea39b90083c5165d2caa4a46108471f0c3f1881`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `df12d812a4d37852400bef645d5116081d3b8f57131a27ed7dc001ba71c3f850`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `c9b4f6d6655433e1fb770c11fd4b9a73df289325516691493cb816a4f57bad2e` |
| Expected bundle hash | `scripts/template-hashes.json` `guiPluginBundle`, exact match                                                        |
| Host                 | OpenCode Desktop `2.2.6`, macOS `27.0.1`, arm64, dark theme                                                          |

The packed artifact was installed with the normal global installer and
`--force --no-restart-host`. The long-running Desktop service still held the
previous plugin module in its ESM cache; a normal service restart is required
for an in-place upgrade. For this verification, a fresh `opencode-cli serve`
instance using the same config/data loaded the installed package and exposed
`GetWorkbenchReview`; the Desktop main window was connected to that fresh
service for the visual run. This proves the installed GUI and RPC on a fresh
service, not a zero-restart upgrade of the long-running service.

### Observed results

1. The native command palette contained exactly one
   `FlowGuard: open native Workbench (experimental)` entry. Selecting it opened
   one `FlowGuard Workbench` side panel and the `session.header` status.
2. READY session `ses_e4a74c86fffena7zCUUzN3F4kb`:
   - header: `FlowGuard | READY | Next: /task`
   - Current work: session id, `Phase: READY`, `Next: /task, /architecture, /review`
   - Review subject: `No reviewable subject recorded`, `Review status: NOT_VERIFIED`
   - Evidence: zero findings, missing verification, ProofGraph claims and coverage gaps
   - Decision: next action is the existing native chooser or canonical command
   - Guided recovery: no active recovery instruction; unverified state is not clearance
3. BLOCKED session `ses_e4aec7c6dffePt3hl7wqTic1y9`:
   - header: `FlowGuard: state unavailable / NOT_VERIFIED`
   - diagnostic warning: `SESSION_STATE_ABSENT`
   - guided recovery: cause `No FlowGuard state exists for this session.`, code
     `SESSION_STATE_ABSENT`, canonical recovery `Start or hydrate a governed
session, then retry.`
4. Real PLAN session `ses_e4a74c86fffena7zCUUzN3F4kb` after
   `/task --file TICKET.md` and `/plan`:
   - header: `FlowGuard | PLAN | System work in progress`
   - review subject: `Plan v2`, revision `v2`, digest
     `d368c7b452990036789525316c82065a51fce24b390ccc065a81f61c00250641`
   - content verification: `verified`; review binding: `matched`
   - reviewer verdict: `NOT_VERIFIED`; review status: `PARTIAL`; warning
     `REVIEW_VERDICT_NOT_RECORDED`
   - decision section: no operator decision requested; `Open canonical
decisions` was disabled
   - guided recovery: no active recovery instruction
5. The independent reviewer child session produced an `accept` result, but the
   host reviewer-capture path returned
   `REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`; FlowGuard did not bind the
   verdict. The workbench correctly showed the unbound/pending state and kept
   the decision disabled. This is a host review-capture blocker, not a
   workbench approval.
6. Opening and refreshing the workbench issued no workflow command, decision,
   hydrate, audit mutation or phase transition.
7. The workbench rendered no raw subject content, file paths or claim ids; the
   RPC projection is bounded and the detail is read-only.

Evidence:
[`desktop-2.2.6-workbench-ready.png`](./desktop-2.2.6-workbench-ready.png),
[`desktop-2.2.6-workbench-blocked.png`](./desktop-2.2.6-workbench-blocked.png),
[`desktop-2.2.6-workbench-plan-pending.png`](./desktop-2.2.6-workbench-plan-pending.png),
and [`desktop-2.2.6-workbench-palette.png`](./desktop-2.2.6-workbench-palette.png).

### Not exercised in this run

- A complete, subject-matched, bound review gate with a recorded reviewer
  verdict was not available. A real PLAN session with a pending review was
  displayed fail-closed; the host reviewer-capture path returned
  `REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`, so the bound decision and
  stale-decision run remain `NOT_VERIFIED`.
- Stale digest, unbound review, delayed response and session-switch negative
  visual runs: `NOT_VERIFIED` (projection and fail-closed logic are covered by
  unit tests only).
- Keyboard-only focus, narrow panel width, light/dark theme and screen-reader
  fallback: `NOT_VERIFIED`.
- Installed uninstall sequence: `NOT_VERIFIED`.

## Review/decision verification — 2026-11-07

A fresh isolated workflow was created under the installed OpenCode CLI `2.2.6`
service (same config/data as the Desktop profile) with its own review-assurance
ledger. No ledger entries from the stuck session were copied or edited.

### Positive path

1. New session `ses_e4a2f2017ffeZ3TubHNAc5kV0C`: `/start` → `READY`,
   `/task --file TICKET.md` → `TICKET`, `/plan` → `PLAN_REVIEW`.
2. `GetWorkbenchReview` returned `status: COMPLETE`, subject `Plan v1`,
   revision `v1`, digest
   `550796091ca25bdd9d25a2f411dbafe93d9d88d4f6392c65dff44758c6f9f990`,
   `contentVerified: verified`, `subjectBinding: matched`,
   `reviewerVerdict: accept`, `reviewCompletion: reviewer_accepted`, one minor
   finding and two missing-verification entries.
3. The Desktop Workbench rendered the same values, header
   `FlowGuard | PLAN_REVIEW | Decision required (not approved)`, and enabled
   `Open canonical decisions`.
4. The existing native chooser opened with exactly `/approve`,
   `/request-changes` and `/reject`; selecting `/approve` executed the existing
   revision-bound `SubmitDecision` path.
5. The session advanced to `IMPLEMENTATION`; the persisted decision is
   `verdict: approve` at `2026-11-07T11:48:48.960Z`, and the Workbench reports
   one certificate. The Workbench itself did not call `SubmitDecision`.

### Implementation / evidence-review path

`/implement` on the approved session applied exactly the two approved file changes
and reached `EVIDENCE_REVIEW`:

- `TaskService.updateTask` throws `TaskNotFoundException(id)` before mutation
  when `repository.findById(id)` is null.
- `TaskControllerTest.update_taskNotFound_returns404` is enabled, asserts the
  404 body's `taskId`, and its Javadoc describes active regression coverage.
- FlowGuard validation: build check passed with 15 assertions and one skipped;
  an independent `npm run test --` passed 16 tests, and `npm run build --`
  passed 16 tests with `BUILD SUCCESS`.
- The Workbench showed header `FlowGuard | EVIDENCE_REVIEW | Decision required
(not approved)`, subject `Implementation
b806035b-20b9-4086-a0b6-b1b80eed3304`, digest
  `52d523d809c00ecad54f613ab20b44fda991698f5763ab04da8eb49087224837`,
  reviewer verdict `accept`, review status `COMPLETE`, zero findings, zero
  missing verification, and one critical ProofGraph claim marked `PROVEN` with
  one evidence reference. The decision affordance was enabled.
- The evidence-review decision itself was left for the operator; this run did
  not execute it.

### Negative stale path

The pre-decision binding (state digest
`86a3f88ded4b615ce6b056b64956c687c631be6b635cb1a2cc9e422822071afa`,
phase `PLAN_REVIEW`, obligation `a171bdf7-e06d-460f-ac08-b201ecbf5dc7`) was
submitted again after the approval. The canonical server refused it with:

```
kind: blocked
code: DECISION_BINDING_STALE
message: The workflow state changed.
```

The session remained in `IMPLEMENTATION` with the original decision unchanged;
no ledger edit or manual repair was performed.

### Path B — diagnosis of the stuck session

The stuck session `ses_e4a74c86fffena7zCUUzN3F4kb` has obligation
`81ad6fa7-90aa-434f-ba49-4794654a5061` (plan v1) with status `blocked` and code
`REVIEWER_CAPTURE_PROVENANCE_INVALID`. Its attempt
`890cfcc9-79ca-4095-9ef1-a3b940373195` used child session
`ses_e4a3b2f75ffewgZEuoQqBFrACt` and dispatch
`096f1732-f9f5-4b0b-9754-a9c8c3f663ad`, whose host call recorded
`call_00_fOLuZHPjhlGrtw3pb7IV1921`, message
`msg_1b5c4c5a4001K8A8R3ZH1HPC23` and the parent session — but the dispatch
status remained `outcome_unknown`.

The child execution is demonstrably complete: its repository observations were
bound at `2026-11-07T11:34:05.930Z`, its final reviewer message at
`2026-11-07T11:34:06.576Z` carried `overallVerdict: accept`, and the attempt
completed at `2026-11-07T11:34:12.388Z`. Because the dispatch record never
advanced from `outcome_unknown`, FlowGuard rejected the capture and blocked the
obligation; the accept could not become a bindable approval. The second
obligation `f2cfd720-8e29-4bec-b382-4b7a0afdea3f` (plan v2) has attempt
`345ec240-d2fb-4214-b300-10849eb3574e` with no observations and no completed
dispatch, so it remains pending and not bindable.

No manual deletion or reset of the ledger was performed. The original session
is left fail-closed; the fresh session above is the clean recovery path and
demonstrates that the same installed build can bind a reviewer and execute the
decision when it starts with a fresh assurance ledger.

### Evidence

- [`desktop-2.2.6-workbench-plan-review.png`](./desktop-2.2.6-workbench-plan-review.png)
  — bound PLAN_REVIEW with decision available.
- [`desktop-2.2.6-workbench-approved.png`](./desktop-2.2.6-workbench-approved.png)
  — post-approval `IMPLEMENTATION` state with the persisted plan review.
- [`desktop-2.2.6-workbench-evidence-review.png`](./desktop-2.2.6-workbench-evidence-review.png)
  — implementation/evidence review with the `PROVEN` critical claim and the
  next decision available.
- [`desktop-2.2.6-workbench-plan-pending.png`](./desktop-2.2.6-workbench-plan-pending.png)
  — the earlier pending-review fail-closed state.

### Residual installed checks

- **Narrow layout: PASS.** At a `900x900` logical window the Workbench panel and
  header remained visible and the panel text remained readable; the window was
  restored to `1920x1050`.
  Evidence:
  [`desktop-2.2.6-workbench-narrow.png`](./desktop-2.2.6-workbench-narrow.png).
- **Keyboard: PASS.** A real `Return` key event activated the focused
  Workbench `Refresh state` button, and a real `Cmd+K` / `Escape` pair opened
  and closed the command palette. In the native decision dialog, real
  `ArrowDown`/`ArrowUp` events moved the selected option between `/approve`,
  `/request-changes` and `/reject`, and `Escape` closed the dialog without
  executing a decision. Evidence:
  [`desktop-2.2.6-workbench-decision-dialog-keyboard.png`](./desktop-2.2.6-workbench-decision-dialog-keyboard.png).
- **Light mode: PASS.** The app-level `opencode-color-scheme` setting was set to
  `light`; the root background rendered `rgb(250, 250, 250)` and the Workbench
  text remained readable. The setting was restored to `dark` afterwards.
  Evidence:
  [`desktop-2.2.6-workbench-light.png`](./desktop-2.2.6-workbench-light.png).
- **Install/uninstall: PARTIAL.** The active profile install from the packed
  artifact matched the template hashes. In an isolated `OPENCODE_CONFIG_DIR`,
  install wrote 29 managed files and doctor reported `HEALTHY_WITH_WARNINGS`;
  uninstall removed those 29 managed files and preserved `node_modules`
  because exclusive dependency ownership was not proven. Host-refresh
  verification failed in the isolated config because no running service record
  existed there. Active-profile uninstall was not run.

## Compact progressive-disclosure Workbench revision (post-4fcd55c3)

**Status: PASS on installed Desktop 2.2.6 (artifact `3bc54caa`).** The prior
screenshots for bundle `c9b4f6d6655433e1fb770c11fd4b9a73df289325516691493cb816a4f57bad2e`
apply only to the previous bundle. The compact bundle was installed and exercised
on Desktop 2.2.6 macOS arm64.

### Installed compact-revision acceptance

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `3bc54caa5f8b2034fa4605456a84aa0da5a649aa`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `6439f4fb31333154a893eeddc3f16a82bc2cd9c53936e5fd1191914a7c4050f4`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `b577a14e512629b31072c17410c3bc7db80c66140e76c9d3b6039d29d0a20689` |

**Defect found during acceptance and fixed before this evidence:** the first
compact revision (`daec8bf0`) opened `Guided recovery` automatically at a
decision gate because the decision question is carried in `next.blocker`. That
contradicted the intended context-sensitive behavior. `3bc54caa` opens recovery
only for `next.kind === 'blocked'`; the GUI bundle test now feeds a decision-gate
blocker and asserts recovery stays collapsed.

**Observed results:**

- **READY** (`ses_e49fd0fd5ffeVbWxcVVddTUwFC`): header
  `FlowGuard | READY | Next: /task`; only `Current work` expanded; `Choose
workflow` enabled; all other top-level sections collapsed; no mutation.
- **EVIDENCE_REVIEW** (existing demo session `ses_e4a2f2017ffeZ3TubHNAc5kV0C`):
  header `FlowGuard | EVIDENCE_REVIEW | Decision required (not approved)`;
  `Independent review` and `Safe decision` expanded; `Technical binding details`
  and `Findings and evidence` collapsed; `Guided recovery` collapsed after the
  fix; `Review operator decisions` enabled. The canonical chooser opened with
  `/approve`, `/request-changes`, `/reject` and was dismissed with Escape; the
  session remained `EVIDENCE_REVIEW` and the plan-approval decision was unchanged.
- **BLOCKED** (`ses_e4aec7c6dffePt3hl7wqTic1y9`): `Guided recovery` expanded
  with `SESSION_STATE_ABSENT` and canonical recovery; the decision affordance was
  hidden; no bypass was offered.
- **Keyboard:** `Space` toggled the native `Independent review` summary;
  `Space` on `Expand all details` opened all top-level sections and changed the
  label to `Collapse details`; a second `Space` collapsed them. The decision
  chooser was opened from `Review operator decisions` by keyboard and dismissed
  with `Escape`; no decision was recorded.
- **Light/dark and narrow:** the app-level light scheme rendered the Workbench
  readably (`rgb(250, 250, 250)` root); dark was restored. At `900x900` logical
  size the panel and header remained visible and readable.
- **Regression:** the pre-decision plan binding was re-submitted after the later
  phase transition and was rejected with `DECISION_BINDING_STALE`; the session
  remained `EVIDENCE_REVIEW`. No server decision authority changed in this
  GUI-only revision.
- **Scope limit:** active-profile uninstall remains `PARTIAL`; the isolated
  install/uninstall exercise is recorded above.

Evidence:
[READY](./desktop-2.2.6-compact-ready.png),
[EVIDENCE_REVIEW](./desktop-2.2.6-compact-evidence-review.png),
[BLOCKED](./desktop-2.2.6-compact-blocked.png),
[decision dialog](./desktop-2.2.6-compact-decision-dialog.png),
[light mode](./desktop-2.2.6-compact-light.png), and
[narrow layout](./desktop-2.2.6-compact-narrow.png).

The compact Workbench is not the finished product UX; timeline, deeper
ProofGraph views, session context and full usability/accessibility review remain
in #1196.

## Artifact to certify

Record the exact Git HEAD, packed `@flowguard/core` tarball SHA-256, installed
`plugins/flowguard/gui-experimental.cjs` SHA-256, OS and Desktop build (expected
2.2.6). Reinstall from the exact PR HEAD with the existing installer and reload
Desktop. Record version/sha in the evidence report, not just screenshots.

## Native UX test cases

- [ ] Palette entry `FlowGuard: open native Workbench (experimental)` opens
      one native side panel and header status; existing chooser remains available.
- [ ] READY shows correct session, phase, action and a nonmisleading empty
      review state. No workflow starts on opening or refresh.
- [ ] At a canonical PLAN_REVIEW, ARCH_REVIEW or EVIDENCE_REVIEW gate: exact
      subject kind, revision/digest and _independent_ reviewer verdict are shown.
      The text “Reviewer ACCEPT” never implies approval.
- [ ] Findings, missing verification, ProofGraph claims, coverage gaps and
      truncation/NOT_VERIFIED are visible and readable. Missing evidence is
      never rendered as green approval.
- [ ] Only a complete, subject-matched and bound review permits opening the
      **existing** decision chooser. The workbench never calls SubmitDecision
      directly; the existing server-authority mechanism rechecks the binding.
- [ ] Stale digest, unbound review, incomplete diagnostics, session switch and
      delayed RPC responses disable the panel decision affordance. A stale
      chooser or native decision is rejected by canonical authority.
- [ ] BLOCKED phase displays canonical cause, code and legitimate recovery.
      An outcome_unknown condition has no speculative “fix automatically”.
- [ ] Manual refresh updates after an actual phase transition. Automatic event-
      driven refresh is NOT_IMPLEMENTED in this slice.
- [ ] Keyboard-only/visible focus, escape/cancel, short and narrow panel widths,
      light/dark themes, screenreader or native text fallback checked.
- [ ] Dispose, session switch, panel close/reopen and renderer reload do not
      leave ghost buttons, duplicate panels or misbound results.
- [ ] Packed installed CLI and GUI are intact; no extra hydrate, audit mutation,
      workflow command or decision arises merely from viewing/refreshing.
- [ ] Native install, doctor and uninstall exercise the exact same artifact.

## Evidence / results

| Evidence category                             | Status                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Version-pinned installed Workbench screenshot | `PASS` (artifact `aea39b90`, Desktop 2.2.6, READY, PLAN-pending, bound PLAN_REVIEW, approved and BLOCKED) |
| READY + Review + BLOCKED interaction captures | `PASS` (READY, real PLAN-pending fail-closed, bound PLAN_REVIEW decision and BLOCKED recovery)            |
| PLAN pending-review fail-closed display       | `PASS` (exact plan revision/digest; `REVIEW_VERDICT_NOT_RECORDED`; chooser disabled)                      |
| Bound decision and stale-denial negative run  | `PASS` (native `/approve`; old binding rejected with `DECISION_BINDING_STALE`; state unchanged)           |
| Implementation/evidence-review display        | `PASS` (implementation subject/digest, `accept` verdict, `PROVEN` claim, decision available)              |
| Stuck-session diagnosis                       | `PASS` (dispatch `outcome_unknown`; child review completed; no ledger reset)                              |
| Narrow layout and keyboard activation         | `PASS` (900x900; real `Return` refresh; real `Cmd+K`/`Escape` palette)                                    |
| Decision-dialog keyboard navigation           | `PASS` (ArrowDown/ArrowUp moved selection; Escape closed without a decision)                              |
| Light mode                                    | `PASS` (app-level light scheme; readable Workbench; dark restored)                                        |
| Installed package lifecycle and hashes        | `PARTIAL` (active install/hashes; isolated uninstall removed managed files; active uninstall not run)     |

**Accept only with artifact-bound, redacted installed evidence.** CI unit tests
and older Panel/Slot screenshots do not close this checklist. The complete
#1196 product also requires independent visual/accessibility/usability and
governance-security acceptance, not just this slice.
