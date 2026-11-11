# Desktop GUI Companion

FlowGuard ships an optional OpenCode Desktop companion as a prebuilt CommonJS
bundle at `plugins/flowguard/gui-experimental.cjs`. It is a progressive
enhancement over the portable Markdown surface. It is not a server, headless,
TUI, MCP or decision authority, and it does not activate governance.

The Desktop companion is optional. A build without it, or without the optional
GUI APIs it uses, keeps the complete portable fallback: `/start`, `/status`,
`/help`, `/commands` and the Markdown workflow chooser.

## Desktop commands

These commands are registered by the Desktop GUI bundle. They are documented in
the capability-aware command catalogue with the `desktop` surface only.

| Command               | Purpose                                                                                     | Availability                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/choose-workflow`    | Opens the canonical Next Action chooser or review-decision dialog.                          | TUI or Desktop, depending on the loaded companion; never a server authority. |
| `/flowguard-ui-probe` | Opens the read-only review, evidence and recovery Workbench.                                | Desktop only; experimental and conditionally registered.                     |
| `/flowguard-inline`   | Refreshes the read-only FlowGuard status beside the chat composer. Never inserts a message. | Desktop only; experimental and requires the `ComposerPill` API.              |

`/choose-workflow` is shared with the optional TUI companion. The command can
request a canonical workflow command or submit a review decision through the
existing server-side binding checks; it never approves, overrides or mutates
governance by itself.

These commands require an OpenCode **host session**, which is not the same as an
activated FlowGuard **governance session**. The help projection can document the
host-session precondition but cannot verify it; it only blocks on the FlowGuard
session state where the command actually requires one.

`/flowguard-ui-probe` and `/flowguard-inline` are experimental. The Workbench
may be unavailable when the host lacks the optional `Panel` or `Slot` APIs; the
composer command is not registered when `ComposerPill` is unavailable. A
missing optional API degrades that surface only and must not disable the rest of
FlowGuard.

The Desktop palette is the runtime registration authority. The server-side help
catalogue documents these commands, but it cannot prove that the GUI or every
optional GUI API is loaded. Therefore, without a trusted host capability
snapshot, Desktop commands remain `not_verified` in `/commands --all` rather
than being reported as available.

In this document, `read-only` means **no persistent FlowGuard data changes**.
Opening a panel or refreshing visible UI state is allowed; the command must not
write session, review, policy, decision or audit data.

## ComposerPill

The optional ComposerPill appears above the OpenCode Desktop chat composer, not
in the conversation transcript. It is a live, read-only diagnostic view.

- It renders a session-bound status label and an explicit Inspect/Refresh row.
- It reads only canonical `GetNextAction` and, at review gates,
  `GetWorkbenchReview`. It never starts a workflow, hydrates a session, submits
  a decision, writes audit events or asks the model to continue.
- Nothing is fetched at plugin registration or first render. A user refresh or
  an observed current-session `session.execution.succeeded` event triggers a
  read. A best-effort 30-second reconciler refreshes only the visible current
  session while the GUI is connected.
- A completion event is an optimization, not a durable audit feed. Missed
  events, a stale read, an unavailable sidecar or an unsupported host surface
  remain `NOT_VERIFIED` or `STALE`; `/status` remains the fallback.
- The pill never inserts a synthetic message into model context. The earlier
  synthetic-message prototype was removed.
- The pill exposes named accessibility regions with polite, atomic status
  announcements. Static accessibility hardening is installed-verified; an
  independent VoiceOver/screenreader acceptance remains open.

The pill is not a human-approval claim. Any decision still requires the
canonical command path, the server-side revision binding and the configured
policy. The channel remains `host_command` and never raises actor assurance.

## Workbench

The Desktop Workbench is a read-only projection over existing authorities:

- review subject, findings and reviewer evidence;
- bounded review transport timeline and ProofGraph claims;
- session lineage and verified audit-chain chronology;
- diagnostics and recovery views.

It reuses the canonical diagnostics and review projections. It does not create
a second review authority, a second audit store or an approval control. Missing,
stale or truncated data is shown as `NOT_VERIFIED` or `PARTIAL`, never smoothed
over.

## Installed evidence and remaining gates

The GUI implementation is pinned by the installed Desktop evidence for OpenCode
Desktop 2.2.6 artifact `f9c53e8f` and GUI bundle hash
`bb8c8cd2…b06ff81e`. That evidence applies to the unchanged GUI artifact only. A
package rebuild that changes the command catalogue or server-side help does not
extend the installed GUI acceptance to the rebuilt package.

The following gates remain open and are not implied by this document:

- independent VoiceOver/screenreader acceptance;
- zero-restart host upgrade;
- live-profile uninstall;
- automatic refresh across every governance transition.

See [Desktop UX product slice](./ux/1196-desktop-product-slice.md) and the
[installed acceptance records](./host-probes/opencode-v2/desktop-2.2.6-workbench-acceptance.md)
for the evidence scope.

## Fallback

When the Desktop companion is absent or an optional GUI API is unavailable:

- use `/status`, `/help` and `/commands` in the chat;
- use the portable Markdown workflow chooser from `/start` and `/status`;
- use `/debug-export` and `/diagnostics` for read-only diagnostics;
- use the canonical command or decision path for any governance action.

Desktop availability never implies availability on TUI, headless, MCP, Claude
Code or Codex.
