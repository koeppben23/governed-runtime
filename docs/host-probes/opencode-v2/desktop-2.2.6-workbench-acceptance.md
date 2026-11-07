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

## Bounded reviewer timeline and ProofGraph provenance (new PR #1207 revision)

**Status: PASS on installed Desktop 2.2.6** for the bounded review-transport
timeline and the enriched ProofGraph claim display. The previous compact
Workbench acceptance on `3bc54caa` remains valid only for that artifact. This
revision adds a read-only `Review transport timeline` disclosure from existing
review-assurance links (attempt creation/completion, dispatch authorization/
completion, invocation start/binding, obligation fulfillment/consumption).
Events use persisted timestamps, sort chronologically, and are capped at the
most recent 32; truncation and unavailable history are visible. The timeline is
**not** a complete workflow/audit timeline and never implies a host capture or
approval from a reviewer verdict alone.

ProofGraph claim cards now show criticality, recorded verification state,
positive evidence count, counterexample count, and certificate binding
(`current`, `stale_or_unbound`, `not_recorded`). The UI does not infer proof
from zero gaps or from an unverified claim. Existing server-side decision checks
and stale-binding safeguards remain unchanged.

### Installed acceptance record (artifact `3e72f1f8`)

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `8ef2cc11e8455c4c8465f0ca3165ba24120dd185`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `9b0a4af57f5f0d1e68a74bdc82895e39d8546b17c18408debc0325b538075633`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `460eb485b67a2a5165a9c1f84d47cc4eb3608a2b5e823c9e2d4759607127c0f9` |

**Quality findings fixed before acceptance:** the submitted revision had three
unformatted files, `projectWorkbenchReview` exceeded the repository complexity
budget (14 > 12), the wrapper file exceeded the 650-LOC production budget
(657 LOC), and the pinned GUI bundle hash `1615f16a…` did not match the actual
built bundle. The projection was split into bounded helpers, the GUI bundle was
extracted to `gui-plugin-bundle.ts` (byte-identical bundle hash `460eb485…`),
formatting was applied, and the manifest now pins the installed bytes. The GUI
bundle, projection and architecture/file-size tests pass after the fix.

**Observed installed results:**

- Fresh `opencode-cli` 2.2.6 service loaded the installed package; the Desktop
  window connected to it as the explicit HTTP server `127.0.0.1:50284`.
- `GetWorkbenchReview` returned `timeline.source: review_assurance`,
  `status: available`, `total: 16`, with attempts, dispatches, invocations and
  obligations in chronological order. The section is collapsed by default and
  labels itself as persisted review assurance, **not the full workflow audit**.
- The implementation review claim displayed `PROVEN`, one positive evidence
  reference, one counterexample reference and certificate binding `current`.
- READY (`ses_e49fd0fd5ffeVbWxcVVddTUwFC`): with no linked review-assurance
  history, the timeline displayed `NOT_VERIFIED` with no invented events; the
  `Choose workflow` action remained the canonical entry point.
- Opening, expanding and refreshing the view issued no workflow command,
  decision, hydrate or audit mutation. The demo session remained
  `EVIDENCE_REVIEW` with the prior plan approval unchanged.
- Keyboard expand/collapse, light/dark and narrow rendering were exercised on
  the compact revision; the new timeline itself used the same native
  `details`/`summary` control and the global Expand/Collapse control.

Evidence:
[default compact state with timeline collapsed](./desktop-2.2.6-timeline-default.png),
[expanded timeline and proof details](./desktop-2.2.6-timeline-expanded.png), and
[READY timeline NOT_VERIFIED](./desktop-2.2.6-timeline-ready-not-verified.png).

**Limitation:** this is a review-transport timeline, not a complete audit
timeline for every workflow phase. Timeline truncation is explicit and capped at
32 newest events; the projection never invents events from the current clock.

**Keep PR Draft** until the updated CI is green. No merge or demo-session
decision is authorized by this revision.

## Session Explorer and audit-chain chronology — PR #1207 continuation

**Status: PASS on installed OpenCode Desktop 2.2.6** for the Session Explorer
and verified audit-chain chronology. The previous timeline/proof screenshots
remain valid only for the earlier bundle. The new `GetWorkbenchDiagnostics` RPC
composes the existing canonical Explorer (including unverified lineage) with
read-only `audit-chain.v3` verification.

Each positively linked session audit is bounded to 2 MiB before reading and
checked through the canonical integrity verifier. The projection has a
24-session cap and displays up to the newest 100 verified audit events. It
does not display raw event detail, actor identities, file paths or unverifiable
child audit records. It distinguishes `verified`, `invalid` and
`not_verified` integrity, and does not equate chronological ordering with
causality. A missing/truncated/invalid event chain never becomes a positive
assurance statement. Audit-chain events are not host transcript events.

### Installed acceptance record (artifact `9ea01ae8`)

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `9ea01ae8e1984becc92409d91eb63cae743280a2`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `8e23c7474fb465d9844df8c9b99fcf2dd0f6fecad3329e6459150390bdd38f36`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `122994ba21db690bcd0c1de58ff416ce6984961fc92b0c8aaabc00d4bcd22cc3` |

**Quality finding fixed before acceptance:** `workbench-diagnostics-projection.ts`
was not Prettier-formatted in the submitted revision; the format job failed.
The file was formatted in `9ea01ae8`, after which all 37 CI jobs passed.

**Observed installed results:**

- The managed OpenCode `2.2.6` service loaded the installed package; the Desktop
  Workbench opened the existing demo session through that service.
- `GetWorkbenchDiagnostics` returned `explorer.status: PARTIAL`,
  `lineage: complete`, `canonicalState: partial`, three sessions (root
  `captured / verified`; two reviewer children `absent / verified`), two review
  attempts with child IDs and dispatch/obligation summaries, and explicit
  `SESSION_STATE_ABSENT` warnings.
- `audit.status: PARTIAL`, `source: verified_audit_chain_v3`, 72 verified
  persisted events, no truncation. The root chain was `verified`; the two child
  chains were `not_verified` with
  `SESSION_LINEAGE_OR_BINDING_NOT_VERIFIED`, and the UI preserved that
  distinction instead of reading them as trusted evidence.
- The default compact state left `Session explorer` and `Verified audit
chronology` collapsed; the global `Expand all details` control revealed the
  real session/audit data. No raw actor identities, file paths or event details
  were shown.
- Opening, expanding and refreshing issued no hydrate, workflow command,
  decision or audit mutation. The demo session remained `EVIDENCE_REVIEW` with
  the prior plan approval unchanged.

Evidence:
[default compact state with diagnostics collapsed](./desktop-2.2.6-diagnostics-default.png)
and [expanded Session Explorer / verified audit chronology](./desktop-2.2.6-diagnostics-sections.png).

**Scope:** This is a verified persisted audit-chain chronology for the Explorer
sessions, not host transcript replay or causal proof of multi-agent execution.
The 24-session and 100-event caps remain enforced; this run used three sessions
and 72 events. The previously noted active-profile uninstall limitation remains
`PARTIAL`.

## Inline chat and composer status — PR #1207 continuation

**Status: PASS on installed OpenCode Desktop 2.2.6** for the native
`ComposerPill` status surface and the `flowguard-live` `CodeBlock` renderer.
This section supersedes the earlier "not installed-verified" note for these
contributions. The earlier Workbench evidence remains valid only for its own
artifact.

### Installed acceptance record (artifact `e054159a`)

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `e054159a00f6b61dc631983efbf95c042c7511d3`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `1ae6d10acae2fd95fb7f801c6201cb39e3feb08e4bf77b755bf019c5f3f48c0a`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `8468c4c2af6ed90153ffff167f47e19851fc953a7dfb7ed9e79f31ac8325f98c` |
| Host                 | managed Desktop service, OpenCode `2.2.6`, loopback port `49374`                                                     |

**Install/refresh boundary:** `flowguard install --no-restart-host` wrote 26
managed files, merged 3 and installed the exact GUI bundle hash above. Its
post-install host-refresh verification then returned an explicit `failed`
outcome because the installer was running inside the service and could not
prove an out-of-service restart; it did not rewrite governance authority. The
running Desktop host hot-reloaded the plugin, and a renderer reload confirmed
the pill was registered. No automatic restart was performed. This is not a
zero-restart upgrade proof.

**Observed installed results:**

- **Placement and registration:** the pill appears in the host's
  `session-plugin-pills` group immediately above the composer with
  `aria-label="FlowGuard · chat status (read-only)"`. Plugin registration shows
  only `FlowGuard · inspect`; no status RPC is issued until the user acts.
- **Manual refresh:** opening the pill and choosing `Inspect canonical status`
  reads `GetNextAction`; at a decision gate it additionally reads
  `GetWorkbenchReview`. The label then ends in `· last read`. There is no
  polling or event-driven refresh in this slice.
- **EVIDENCE_REVIEW** (`ses_e4a2f2017ffeZ3TubHNAc5kV0C`): pill
  `FlowGuard · EVIDENCE_REVIEW · last read`; the menu shows
  `Independent review: accept · Findings: 0 · Operator decision still required (not approved).`
  It offers only status and refresh rows, never a decision action.
- **READY** (`ses_e49fd0fd5ffeVbWxcVVddTUwFC`): pill
  `FlowGuard · READY · last read`; menu `Choose a workflow` with
  `/task, /architecture, /review`.
- **PLAN** (`ses_e4a74c86fffena7zCUUzN3F4kb`): pill
  `FlowGuard · PLAN · last read`; menu `Independent plan review in progress.`
- **Unavailable state:** an ordinary/ungoverned session and the disposable
  renderer fixture both displayed `NOT_VERIFIED · Canonical state is unavailable. Use /status.`
- **Session switching:** snapshots are keyed by server and session. Switching
  sessions resets the pill to `FlowGuard · inspect`; no stale value crosses
  sessions, and a switched-away read is discarded.
- **Plugin reload:** a renderer reload re-registered the pill and menu. No
  `[FlowGuard]` warning was logged; the only console error was a transient host
  transport error during reconnect.
- **Light/dark:** the app-level light color scheme and the restored dark scheme
  both rendered the pill and menu readably.
- **Keyboard and accessibility:** the pill is a native button with an ARIA
  label, `aria-haspopup` and `aria-expanded`. Focus plus `Return` opened the
  menu, focus moved into the menu, and `Escape` closed it. No separate
  screenreader session was available.
- **`CodeBlock` renderer:** in a disposable fixture session, an assistant
  message containing a fenced `flowguard-live` `v1` block rendered the live
  status card. A `v2` block fell back to an ordinary code block. The renderer
  created no session message, prompt or decision. The fixture session was
  deleted after the run; the product path never creates that message.
- **No governance or model mutation:** the demo session message count remained
  44, its `reviewDecision` (`approve`, `2026-11-07T11:48:48.960Z`) was
  unchanged, activation generation remained `1`, the phase remained
  `EVIDENCE_REVIEW`, and the verified audit chronology remained 72 events under
  `PARTIAL`. Only `GetNextAction` and `GetWorkbenchReview` were read.
- **Not induced on the live host:** a mid-read phase/state change (`STALE`).
  The renderer fails closed on that path and the bundled GUI tests cover
  inconsistent review data, but no live transition was executed because the
  outstanding evidence-review decision must remain unexecuted.

**Residual model-context note:** this chat/composer display path inserts no
synthetic message. A separate pre-existing path, the autonomous
`StartGovernance` RPC in `src/integration/plugin-start-command.ts`, still posts
a non-resuming synthetic host status report. It is not this display and does not
create review authority, but because synthetic messages can reach later model
context it remains an explicitly scoped exposure for a separate product
decision. The interactive `/start` prompt path is unchanged.

Evidence:
[pill above the composer](./desktop-2.2.6-chat-pill-initial.png),
[EVIDENCE_REVIEW with reviewer summary](./desktop-2.2.6-chat-pill-review.png),
[READY](./desktop-2.2.6-chat-pill-ready.png),
[PLAN](./desktop-2.2.6-chat-pill-plan.png),
[light scheme](./desktop-2.2.6-chat-pill-light.png),
[`flowguard-live` v1 card](./desktop-2.2.6-chat-codeblock-v1.png), and
[unsupported v2 fallback](./desktop-2.2.6-chat-codeblock-v2.png).

## Event-driven composer refresh and autonomous transcript removal

**Status: PASS on installed Desktop 2.2.6 (artifact `2651c0cb`) for the
current-session completion refresh.** The autonomous `StartGovernance`
transcript removal is verified by code inspection and the product-composition
regression suite; no installed autonomous Start was run because it would mutate
governance. The older chat/composer acceptance applies only to artifact
`e054159a`.

### Installed acceptance record (artifact `2651c0cb`)

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `2651c0cb7dade1292f332f1ed76be6d203527995`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `110571af91e0020cbc9b2fc87a3e834cc30a9abf0878036eee438e5637c97407`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `36b8f6f1cdcb42b781977f1df5c0bf3164ca994e4336cbc5942d9c50e9cd4f36` |
| Host                 | managed Desktop service, OpenCode `2.2.6`, loopback port `49374`                                                     |

**Host API finding:** the installed 2.2.6 GUI context exposes
`ctx.servers` with `ctx.servers.get('sidecar').data.on(...)`. The checked-in
`@opencode/plugin` typings name the same lookup `ctx.serverEndpoints`. An
installed attempt that used only `ctx.serverEndpoints` did not subscribe; the
final bundle prefers the documented name when present and falls back to
`ctx.servers`, which the installed host exposes. This is a host-version adapter,
not a change to FlowGuard governance semantics.

**Observed installed results:**

- A disposable fixture session (`ses_e48fe17e…`) opened at
  `FlowGuard · inspect`. A normal user prompt completed with
  `session.execution.succeeded`; **without any pill click**, the label changed
  to `FlowGuard · NOT_VERIFIED · last read`. The fixture contained exactly the
  user, assistant and idle messages; the pill created no message, prompt,
  decision or audit write. The fixture was deleted.
- **Foreign-session isolation:** while the demo session was open at
  `FlowGuard · inspect`, a completion in the disposable fixture session did not
  change the demo pill. It remained `FlowGuard · inspect`.
- **Generation fence:** each `inspect` call increments a generation and only
  the newest read may update the signal; a live out-of-order race was not
  induced. The bundled GUI test covers the stale-response guard.
- **Manual fallback:** the demo session still refreshes manually to
  `FlowGuard · EVIDENCE_REVIEW · last read`, shows reviewer `accept`, zero
  findings and “operator decision still required (not approved)”, and offers no
  decision action.
- **No governance mutation:** the demo session remained at 44 messages (zero
  synthetic), the existing `approve` decision (`2026-11-07T11:48:48.960Z`),
  activation generation `1`, phase `EVIDENCE_REVIEW`, and 72 verified
  `audit-chain.v3` events under `PARTIAL`.
- **Autonomous Start:** `plugin-start-command.ts` returns the authoritative RPC
  result before building the interactive status report. Production no longer
  calls `ctx.session.synthetic` or `ctx.session.prompt` on the autonomous path.
  The product-composition regression exercises first and repeated autonomous
  Start and asserts neither callback is called. Interactive `/start` still
  publishes its existing prompt report.
- **Install/refresh boundary:** the installer wrote the exact GUI bundle hash
  above and then returned its explicit host-refresh failure because it ran
  inside the managed service. No automatic restart was performed; the running
  host hot-reloaded the plugin and a renderer reload re-registered the pill.
  This is not a zero-restart upgrade proof.

Evidence:
[before completion](./desktop-2.2.6-chat-event-before.png) and
[after automatic current-session refresh](./desktop-2.2.6-chat-event-after.png);
[manual EVIDENCE_REVIEW refresh on the new bundle](./desktop-2.2.6-chat-pill-event-bundle.png).

**Still open:** independent VoiceOver/screenreader testing, automatic refresh
proof across every governance transition (the completion event is an
incremental read-only signal, not an audit feed), zero-restart upgrade proof,
and the active-profile uninstall (`PARTIAL`). No merge or Ready action is
authorized.

## Desktop host/RPC adapter isolation — artifact `e8e1e90d`

**Status: PASS on installed Desktop 2.2.6** for the host-bridge and typed RPC
client split. The architecture change is source-layer isolation inside the
single GUI bundle; it introduces no new governance authority, decision path or
host-independent UI runtime. The code/architecture head is `e0b2faae`; the
format-fix and evidence head is `e8e1e90d`.

### Installed acceptance record (artifact `e8e1e90d`)

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Git HEAD             | `e8e1e90db4728f4c67336a24b496b36c101d7029`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `30885cfa70e7e2114fde8699c72868728cd9a5ad28f9491c461c26ba832124b3`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `28bb61b2471617e50364ea62b8f455f6db3bb8c593c9bfe5913f8f39ca0da810` |
| Host                 | managed Desktop service, OpenCode `2.2.6`, loopback port `49374`                                                     |

**Observed installed results:**

- **Workbench through the typed client:** the native Workbench opened the demo
  session at `FlowGuard | EVIDENCE_REVIEW | Decision required (not approved)`,
  with reviewer `accept`, zero findings, one `PROVEN` critical claim and
  certificate binding `current`. Expanding all details loaded the 16-event
  review-assurance timeline, three Session Explorer sessions, two review
  attempts and 72 verified `audit-chain.v3` events under `PARTIAL`.
- **Decision boundary:** `Review operator decisions` opened the canonical
  chooser with exactly `/approve`, `/request-changes` and `/reject`; Escape
  closed it and no `SubmitDecision` was issued. The demo session stayed in
  `EVIDENCE_REVIEW`.
- **Pill:** manual refresh on the demo produced
  `FlowGuard · EVIDENCE_REVIEW · last read` with reviewer `accept`, zero
  findings and “operator decision still required (not approved)”; no decision
  action was offered.
- **Typed client / chat card:** a disposable fixture session received an
  assistant `flowguard-live` `v1` block. The CodeBlock renderer called the
  typed `getNextAction` path and rendered the live card; the fixture contained
  only user/assistant/idle messages and was deleted.
- **Completion event:** the same fixture opened at `FlowGuard · inspect` and,
  after its execution succeeded, changed to
  `FlowGuard · NOT_VERIFIED · last read` without a click. While the demo was
  the open session, a completion in the fixture left the demo pill at
  `FlowGuard · inspect`.
- **Contract coverage:** `src/cli/gui-bridges.test.ts` passed 3/3. It pins the
  four semantic client methods to the mounted session and the exact RPC
  envelope, and exercises both the installed `ctx.servers` and the newer
  `ctx.serverEndpoints` lookups, foreign-session/server rejection and cleanup.
- **Architecture:** placement tests passed 554/554; the frozen root matrix now
  has 59 files and eight `root-host-runtime` files, with the type-only
  `gui-rpc-client-contract.ts` explicitly listed. No `templates -> integration`
  dependency exists. The presentation layer no longer spells RPC method names
  or performs host endpoint compatibility checks; those remain in the two
  adapters.
- **No governance mutation:** the demo session remained at 44 messages (zero
  synthetic), the existing `approve` decision (`2026-11-07T11:48:48.960Z`),
  activation generation `1`, phase `EVIDENCE_REVIEW`, and 72 verified audit
  events under `PARTIAL`.

**Install/refresh boundary:** the installer wrote the exact GUI bundle hash
above and then returned its explicit host-refresh failure because it ran inside
the managed service. No automatic restart was performed; the running host
hot-reloaded the plugin and a renderer reload re-registered it. This is not a
zero-restart upgrade proof.

Evidence:
[Workbench and diagnostics through the typed client](./desktop-2.2.6-bridge-workbench.png),
[manual EVIDENCE_REVIEW pill](./desktop-2.2.6-bridge-pill-review.png), and
[`flowguard-live` card plus completion refresh](./desktop-2.2.6-bridge-chat-card.png).

**Still open:** independent VoiceOver/screenreader testing, automatic refresh
across every governance transition, zero-restart upgrade, and active-profile
uninstall (`PARTIAL`). This is a source-layer refactor, not a new host target or
authority path.

## Subsequent optional GUI reconciliation and accessibility revision

**NOT INSTALLED-VERIFIED for the new bundle hash.** The prior
`e8e1e90d` installed evidence and snapshots remain valid for their exact
artifact only. PR #1207 subsequently added a visible-session 30-second,
read-only reconciliation fallback, request coalescing, explicit accessibility
regions/status announcements and stricter isolated-host teardown checks.
The bundle must be repacked and reinstalled before asserting a new PASS.

See [remaining gate protocol](./desktop-2.2.6-remaining-gates.md) for
version-bound VoiceOver, all-phase reconciliation, distinct-revision
zero-restart upgrade and isolated active-uninstall verification.

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
- [ ] Manual refresh and current-session completion events update state;
      separately verify bounded, visible-session reconciliation for missed
      events. It does not guarantee all transitions when offline or hidden.
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
