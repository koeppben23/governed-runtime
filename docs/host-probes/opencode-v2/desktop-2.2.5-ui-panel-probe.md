# OpenCode Desktop 2.2.5: native Panel / Slot proof (#1196)

**Status:** `NOT_VERIFIED` — implementation committed as an optional, read-only capability probe. No installed Desktop visual acceptance has been attached.

**Owning PR:** #1207. **Purpose:** establish whether the exact installed OpenCode Desktop build paints a native side `Panel`, a `session.header` `Slot`, and safely updates session-specific state. This is **not** the final Review Workbench.

## What has been implemented

The existing optional `plugins/flowguard/gui-experimental.cjs` companion retains the proven `/choose-workflow` command. It adds a strictly opt-in `flowguard-ui-probe` GUI command and a side Panel with tab `workbench-probe`. The command registers a header Slot only when invoked, and calls `ctx.layout.open(ctx.id + ':workbench-probe', session, { tab: 'select' })`.

Panel and Slot display the existing read-only `GetNextAction` snapshot. The panel provides a manual Refresh control. The session is read via reactive host props; older RPC responses are discarded on subsequent requests, session changes or teardown. Neither renderer executes `SubmitDecision`, a session command, hydrate or other mutation. No background chooser, modal or automatic governance activation is introduced.

**Important limitations:** The manual Refresh is intentional: a live notification/event source for automatic status refresh is **not yet proven**. The header Slot only appears after explicit probe activation. The probe is a diagnostic capability experiment, not a visual-quality milestone or persistent production status implementation.

## Installation and acceptance procedure

Use a disposable test workspace / profile. Record:

- Exact OpenCode Desktop version (expected `2.2.5`), OS/architecture, and exact Git SHA.
- Installed `@flowguard/core` package tarball SHA-256 and the `guiPluginBundle` SHA-256 from `scripts/template-hashes.json`.
- Redacted screenshot or screen recording showing the Panel **and** the Slot. Include window width and theme.

1. Install the package produced from the PR SHA using the normal packed native installer. Do **not** assume the edited source tree is the installed bundle.
2. Restart/reload OpenCode Desktop, open a governed `READY` session and verify the existing `/choose-workflow` still works.
3. Find and invoke the native GUI command **FlowGuard: inspect native UI (experimental)** (slash registration `/flowguard-ui-probe`). Verify the `FlowGuard UI Probe` side tab opens and that the header displays `FlowGuard` with the exact READY phase. Record whether the registration/command is discoverable in the host.
4. Move through a canonical READY → TICKET transition using the existing host command, click **Refresh FlowGuard status** and confirm the panel shows the actual `TICKET` state and canonical next action. **Do not** claim automatic refresh without a separate live-event proof. Note whether the header Slot updates automatically.
5. Open another session (one ACTIVE, one INACTIVE or a different phase). Verify the panel/Slot show the new session's data, never the old session's state. Switch rapidly and capture evidence that an older, delayed response cannot overwrite a newer view.
6. Narrow the Desktop window and toggle the host theme; verify the panel is visible, text is readable, no action appears as an authorization, and the session header does not clip critical host controls.
7. Reload the plugin/host and confirm the probe does not register duplicate commands/Slots and does not leave stale or privileged controls behind.
8. Close/reopen the panel; press Escape or use the host Close control. Verify no workflow phase or audit authority changed, and the portable Markdown/chooser fallback still works.
9. Run the exact native install, doctor and uninstall sequence against the same package. Verify the optional GUI companion and its template hash match installed bytes.

## Evidence table — fill only with actually observed results

| Capability                                 | Status                       | Evidence                            |
| ------------------------------------------ | ---------------------------- | ----------------------------------- |
| GUI companion resolves from packed install | `NOT_VERIFIED` for new probe | Attach install/log excerpt          |
| GUI command appears and launches           | `NOT_VERIFIED`               | Screenshot/trace                    |
| Panel visible and session-specific         | `NOT_VERIFIED`               | Screenshot and session-switch trace |
| `session.header` Slot visible              | `NOT_VERIFIED`               | Screenshot                          |
| Manual refresh after transition            | `NOT_VERIFIED`               | READY → TICKET screenshots          |
| Automatic refresh after transition         | `NOT_IMPLEMENTED`            | Deliberately outside probe          |
| Narrow/light/dark layout                   | `NOT_VERIFIED`               | Screenshots                         |
| Reload/teardown and installed uninstall    | `NOT_VERIFIED`               | Redacted trace                      |
| Native production Review Workbench         | `NOT_IMPLEMENTED`            | Tracked by #1196                    |

**PASS criterion:** Pinned installed build proves real visibility and basic interaction for Panel + Slot, with all failures and unsupported surfaces recorded separately. Unit tests of `ctx.add`, mock component rendering or `GetNextAction` do not count as visible-host evidence.

**If either extension point is missing or does not paint:** report `NOT_SUPPORTED` for the observed pinned host; do not imply the chooser proves Panel/Slot capability. The product must select a supported native route or explicitly revise host requirements before proceeding.
