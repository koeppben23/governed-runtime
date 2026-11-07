# OpenCode Desktop 2.2.6 — Review Workbench installed acceptance

**Status:** `PARTIAL` — installed Desktop 2.2.6 visual proof exists for the READY
workbench and a BLOCKED recovery state on artifact `aea39b90`. Review-gate
subject/verdict, stale-decision denial, layout/theme and installed uninstall
remain `NOT_VERIFIED`. The prior Panel/Slot evidence for `52d0a3bd` remains valid
for that earlier artifact only.

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

| Evidence category                             | Status                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Version-pinned installed Workbench screenshot | `PASS` (artifact `aea39b90`, Desktop 2.2.6, READY, PLAN-pending and BLOCKED captures) |
| READY + Review + BLOCKED interaction captures | `PARTIAL` (READY, real PLAN-pending review and BLOCKED; no bound review-gate result)  |
| PLAN pending-review fail-closed display       | `PASS` (exact plan revision/digest; `REVIEW_VERDICT_NOT_RECORDED`; chooser disabled)  |
| Bound decision and stale-denial negative run  | `NOT_VERIFIED` (host reviewer capture failed; no bound verdict was fabricated)        |
| Layout, theme and keyboard tests              | `NOT_VERIFIED`                                                                        |
| Installed package lifecycle and hashes        | `PARTIAL` (install and hashes passed; uninstall not run)                              |

**Accept only with artifact-bound, redacted installed evidence.** CI unit tests
and older Panel/Slot screenshots do not close this checklist. The complete
#1196 product also requires independent visual/accessibility/usability and
governance-security acceptance, not just this slice.
