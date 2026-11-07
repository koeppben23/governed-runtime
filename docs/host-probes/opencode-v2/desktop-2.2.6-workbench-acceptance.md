# OpenCode Desktop 2.2.6 — Review Workbench installed acceptance

**Status:** NOT_VERIFIED — required installed-host evidence for the new workbench.
The prior Desktop 2.2.6 Panel/Slot capability evidence on #1207 applies only to the
earlier artifact `52d0a3bd`, not to the Review Workbench implementation.

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

| Evidence category                             | Status       |
| --------------------------------------------- | ------------ |
| Version-pinned installed Workbench screenshot | NOT_VERIFIED |
| READY + Review + BLOCKED interaction captures | NOT_VERIFIED |
| Bound decision and stale-denial negative run  | NOT_VERIFIED |
| Layout, theme and keyboard tests              | NOT_VERIFIED |
| Installed package lifecycle and hashes        | NOT_VERIFIED |

**Accept only with artifact-bound, redacted installed evidence.** CI unit tests
and older Panel/Slot screenshots do not close this checklist. The complete
#1196 product also requires independent visual/accessibility/usability and
governance-security acceptance, not just this slice.
