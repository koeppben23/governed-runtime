# OpenCode Desktop: native Panel / Slot proof (#1196)

**Pinned target:** OpenCode Desktop `2.2.5`.

**Installed acceptance (2026-11-07):** `PASS` on OpenCode Desktop `2.2.6` (macOS arm64). The pinned `2.2.5` Desktop build was not available for this run and remains `NOT_VERIFIED`.

**Owning PR:** #1207. **Purpose:** establish whether the exact installed OpenCode Desktop build paints a native side `Panel`, a `session.header` `Slot`, and safely updates session-specific state. This is **not** the final Review Workbench.

## What has been implemented

The existing optional `plugins/flowguard/gui-experimental.cjs` companion retains the proven `/choose-workflow` command. It adds a strictly opt-in `flowguard-ui-probe` GUI command and a side Panel with tab `workbench-probe`. The command registers a header Slot only when invoked, and calls `ctx.layout.open(ctx.id + ':workbench-probe', session, { tab: 'select' })`.

Panel and Slot display the existing read-only `GetNextAction` snapshot. The panel provides a manual Refresh control. The session is read via reactive host props; older RPC responses are discarded on subsequent requests, session changes or teardown. Neither renderer executes `SubmitDecision`, a session command, hydrate or other mutation. No background chooser, modal or automatic governance activation is introduced.

**Important limitations:** The manual Refresh is intentional: a live notification/event source for automatic status refresh is **not yet proven**. The header Slot only appears after explicit probe activation. The probe is a diagnostic capability experiment, not a visual-quality milestone or persistent production status implementation.

## Installed acceptance record — 2026-11-07

### Environment and artifact

| Field                | Observed value                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Desktop host         | OpenCode Desktop `2.2.6` (bundled `opencode-cli` `2.2.6-arm64`)                                                      |
| OS / architecture    | macOS `27.0.1`, arm64                                                                                                |
| Theme / window       | Dark theme, `1920x1050` logical window (`3840x2100` Retina capture)                                                  |
| PR head              | `52d0a3bd08a7dba630d60eda70e2eab0103db71d`                                                                           |
| Packed tarball       | `flowguard-core-2.0.0-tp.2.tgz`, SHA-256 `e272cfd7aa01630b6e2abef6747644960e819deaccf8514905f02e3796093154`          |
| Installed GUI bundle | `plugins/flowguard/gui-experimental.cjs`, SHA-256 `cca01b21221a598d8aad5ec23fe1db56869a02e3e567275fc2b964412912776c` |
| Expected bundle hash | `scripts/template-hashes.json` `guiPluginBundle`, exact match                                                        |
| Installed session    | `ses_e4a74c86fffena7zCUUzN3F4kb` (`READY`, `java-task-manager`)                                                      |
| Native command       | `FlowGuard: inspect native UI (experimental)`, palette id `command:flowguard.ui-probe`                               |

The bundle was installed from the packed artifact with
`node dist/cli/install.js install --install-scope global --core-tarball <tarball> --force --no-restart-host`,
then the Desktop renderer was reloaded so that the plugin bridge fetched the new
GUI bundle. The installer reported the expected pending-host-refresh state; no
service restart was performed while the session was active.

### Observed results

1. After the renderer reload, the native command palette contained exactly one
   `FlowGuard: inspect native UI (experimental)` command and the existing
   `FlowGuard: choose workflow or decision` command.
2. Selecting the probe opened the `FlowGuard UI Probe` side tab and registered
   one `session.header` status element.
3. The panel rendered `FlowGuard | Desktop UI capability probe`, the read-only
   `GetNextAction` caption, `FlowGuard | READY | Next: /task`, and the
   `Refresh FlowGuard status` button.
4. The session header rendered `FlowGuard | READY | Next: /task`.
5. A MutationObserver around the panel status observed
   `FlowGuard | Loading ses_e4a74c86fffena7zCUUzN3F4kb...` followed by
   `FlowGuard | READY | Next: /task` after pressing Refresh.
6. Switching to session `ses_e4aec7c6dffePt3hl7wqTic1y9` changed the header to
   `FlowGuard: state unavailable / NOT_VERIFIED`; that session has no canonical
   FlowGuard state (`SESSION_STATE_ABSENT`). Switching back restored the panel
   and the `READY` header.
7. Closing the panel left the header registered. Reopening the probe produced
   exactly one panel and one header. A renderer reload followed by a fresh probe
   invocation again produced exactly one command, one panel and one header.
8. The probe issued only `GetNextAction` reads. It issued no workflow command,
   `SubmitDecision`, hydrate, audit mutation or phase transition; the session
   remained `READY`.

Evidence:
[`desktop-2.2.6-ui-command-palette.png`](./desktop-2.2.6-ui-command-palette.png)
shows the native palette entry `FlowGuard: inspect native UI (experimental)`.
[`desktop-2.2.6-ui-probe-ready.png`](./desktop-2.2.6-ui-probe-ready.png) shows
the native `FlowGuard UI Probe` side tab and the `FlowGuard | READY | Next:
/task` session header. Both images are cropped to the relevant UI; no chat
content is included.

### Not exercised in this run

- OpenCode Desktop `2.2.5`: `NOT_VERIFIED` (the installed Desktop had already
  updated to `2.2.6`).
- READY → TICKET transition followed by refresh: not exercised, because it would
  mutate the active user session. Manual refresh on unchanged `READY` passed.
- Narrow layout and light/dark theme: `NOT_VERIFIED`.
- Installed uninstall sequence: `NOT_VERIFIED`. The run used the active user
  profile rather than a disposable profile; no governance state changed.
- Automatic refresh after a state transition: `NOT_IMPLEMENTED` by design.

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

| Capability                                 | Status            | Evidence                                                                   |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------- |
| GUI companion resolves from packed install | `PASS` (2.2.6)    | Tarball and bundle SHA-256 above; `plugin.list` active                     |
| GUI command appears and launches           | `PASS` (2.2.6)    | Native command palette contained exactly one `flowguard.ui-probe`          |
| Panel visible and session-specific         | `PASS` (2.2.6)    | Panel screenshot; session switch changed the header and restored on return |
| `session.header` Slot visible              | `PASS` (2.2.6)    | Header screenshot; one header across close/reopen and reload               |
| Manual refresh after transition            | `PARTIAL`         | Refresh on unchanged `READY` passed; READY → TICKET not exercised          |
| Automatic refresh after transition         | `NOT_IMPLEMENTED` | Deliberately outside probe                                                 |
| Narrow/light/dark layout                   | `NOT_VERIFIED`    | Not exercised                                                              |
| Reload/teardown and installed uninstall    | `PARTIAL`         | Reload and idempotent re-open passed; uninstall not run                    |
| Pinned OpenCode Desktop 2.2.5              | `NOT_VERIFIED`    | Observed host was 2.2.6                                                    |
| Native production Review Workbench         | `NOT_IMPLEMENTED` | Tracked by #1196                                                           |

**PASS criterion:** Pinned installed build proves real visibility and basic
interaction for Panel + Slot, with all failures and unsupported surfaces
recorded separately. Unit tests of `ctx.add`, mock component rendering or
`GetNextAction` do not count as visible-host evidence. The observed `2.2.6` run
meets the Panel + Slot visibility/interaction criterion, but it does not certify
the pinned `2.2.5` build.

**If either extension point is missing or does not paint:** report `NOT_SUPPORTED` for the observed pinned host; do not imply the chooser proves Panel/Slot capability. The product must select a supported native route or explicitly revise host requirements before proceeding.
