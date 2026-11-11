# Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases. No build step required.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that repository snapshot.

## Prerequisites

- Node.js 20+
- npm
- OpenCode V2 (native API candidate: 2.2.5; complete product acceptance remains NO-GO)

## Installation Steps

### 1. Download the Release Artifact

Download `flowguard-core-{version}.tgz` and `checksums.sha256` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

The installer verifies the tarball by default. Keep `checksums.sha256` next to
the tarball, or pass its location with `--checksums-file`. Missing or mismatched
checksum evidence blocks installation before any FlowGuard artifacts are written.

You can also verify the checksum manually before install:

```bash
sha256sum -c checksums.sha256
```

For automated integrity verification with an explicit checksum path, use the
`--checksums-file` flag:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz \
  --checksums-file ./checksums.sha256
```

If `--checksums-file` is omitted, FlowGuard uses `checksums.sha256` in the same
directory as `flowguard-core-{version}.tgz`.

The explicit supply-chain opt-out is `--allow-unverified-tarball`. It is not
recommended; the installer warns and logs the opt-out. Use it only when an
operator has verified the artifact through another controlled channel.

## Host Selection Matrix

Before installing, choose the host platform. Enforcement and activation guarantees
differ per host.

| Host        | Enforcement   | Global Target                 | Repo Target            | Activation                                                              | Key Limitation                    |
| ----------- | ------------- | ----------------------------- | ---------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| OpenCode V2 | `synchronous` | `~/.config/opencode/`         | `./.opencode/`         | Installer verifies/restarts the running host; not governance activation | Installed acceptance NOT_VERIFIED |
| Claude Code | `hook_gated`  | `~/.claude/`                  | `./.claude/`           | Restart Claude                                                          | Hook timeout = tool proceeds      |
| Codex       | `hook_gated`  | `~/.codex/plugins/flowguard/` | `./plugins/flowguard/` | Restart Codex                                                           | `NOT_VERIFIED_NATIVE_LOAD`        |

OpenCode provides the strongest enforcement path through its synchronous plugin.
Claude Code and Codex are supported through MCP, hooks, and native packaging with
hook-gated, platform-limited guarantees. See
[Platform Limitations](./platform-limitations.md) for details.

The native V2 installer is an implementation checkpoint, not a support
certification. The V2 port is merged. Installed INACTIVE parity, interactive and
authorized autonomous activation, policy-required human origin, reviewer
assurance and recovery acceptance are tracked in #1196. Installation does not
authorize either start path.
V1 capabilities/governance guarantees and policy-permitted fully automatic
operation must be preserved; see [ADR-010](./decisions/010-host-neutral-opt-in-governance.md#explicit-parity-and-autonomous-activation-amendment-2026-11-02).

### Native V2 layout and fresh-install boundary

The installer writes the server plugin at `plugins/flowguard/index.ts`, an
optional TUI companion at `plugins/flowguard/tui.ts`, and an optional prebuilt
Desktop GUI bundle at `plugins/flowguard/gui-experimental.cjs` under the selected
OpenCode directory. The server plugin owns native tool registrations; the TUI
and Desktop companions are progressive-enhancement workflow choosers and never a
governance authority.
No `tools/flowguard.ts` or V1 plugin wrapper is installed. Existing OpenCode
JSON/JSONC, comments, instructions, model/variant selection and permissions are
preserved byte-for-byte. An absent config remains absent.
`flowguard-mandates.md` is a passive managed artifact, **not** registered in
`instructions[]`; installing files does not activate a session. A host without
TUI/Desktop support or without the companion wrapper uses the complete Markdown
chooser. Desktop visual acceptance remains `NOT_VERIFIED` until an installed
pinned-host proof is recorded.

The installer publishes the watched native plugin entrypoint only after its
dependency tree is live. This prevents a running host from importing the fresh
entrypoint before `@flowguard/core` is available; publication failures still
restore the previous dependency tree and managed artifacts.

OpenCode watches configuration/plugin changes; use `/reload` for normal
rediscovery. Installation additionally verifies the **actual running service**:
it reads the loopback service record at `~/.local/state/opencode/service.json`,
checks the installed target's location-scoped `/api/plugin` state and
`/api/command` for native `/start`.

- After an applied install, the installer restarts the exact running service
  and verifies the replacement even when the previously loaded plugin still
  reports `active`; an active module can be stale after package files change.
  Non-interactive installs restart by default. `--no-restart-host` opts out and
  keeps verification read-only.
- If the installer runs inside the service (for example an agent-hosted
  terminal), it schedules a detached restart of the exact service executable
  after the installer exits. The current host session is interrupted; a failed
  schedule is reported as `HOST_RESTART_FAILED`.
- If automatic restart is disabled (`--no-restart-host`) or the installer cannot
  prove it is outside the service, it reports `HOST_RESTART_REQUIRED` with the
  exact `'<service-executable>' service restart` command.
- Only a loopback `http(s)` service URL, a live `opencode`/`opencode-cli`
  process whose command is `serve --service`, and the PID from the service
  record are accepted. Malformed, stale or non-loopback records never authorize
  a process kill or receive the service password.
- If no service is running or its loopback API is unreachable, artifacts remain
  installed and host verification is `NOT_VERIFIED`; no restart is guessed. A
  restart failure does not roll back installed artifacts.
- Host lifecycle verification and restart are implemented for macOS and Linux
  when the service runs a native `opencode`/`opencode-cli` executable. A
  Node-launched service is reported stale and is never signalled because the
  exact restart target cannot be proven. Windows reports that automatic host
  lifecycle verification is unsupported and leaves the restart to the operator.

The retained-import failure in older installations is thus handled by the
installer when it can safely identify and replace the service process. If the
installer is hosted by that process, finish active work and run the reported
command from an external terminal. Do not delete configuration, databases or
governance evidence. Verify plugin status `active` and native `/start`
availability afterwards. Do not create `start.md` or use `/hydrate` as an
activation substitute. See the official [plugin reload caveat](https://opencode.ai/v2/docs/plugins/#reload)
for changes to unwatched local dependencies.

Old FlowGuard wrappers, global mandate registrations, duplicate configured
FlowGuard plugins and obsolete installer ownership manifests are rejected before
artifact writes, including with `--force`. There is no format migration or V1
fallback. Archive the old installation, configuration, state and evidence
byte-for-byte; verify archive integrity; remove only confirmed obsolete FlowGuard
registrations, preserving customer settings, then install fresh. Do not delete
audit evidence or use the new uninstaller to migrate an obsolete manifest.
Current ownership manifests use `schemaVersion: 2`; unsupported formats fail
explicitly. `--force` only reinstalls the current format and does not prove
ownership of a modified plugin file.

### 2. Initialize OpenCode Integration (Standard)

The approved local tarball is the authoritative package source. npm/npx may use an internal cache, but no global installation is required.

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz

# Verify
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

### 2b. Initialize Claude Code Or Codex Plugin

For detailed Claude Code and Codex installation, activation, trust, verification,
and uninstall guidance, see [Host Installation](./host-installation.md).

### 3. Verify Installation

```bash
npx --package ./flowguard-core-{version}.tgz flowguard doctor
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host claude-code
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host codex
```

`doctor --host opencode|claude-code|codex` reports host-specific installation files plus a projection-only trust/capability report. This report is diagnostic evidence only; it does not create a new runtime, approval, review, policy, or risk authority. File presence can mean `configured`, but it never proves native plugin load, active governance, trust approval, or review approval.

`doctor` also validates the shipped executable surface: every command declared in the package `bin` map (`flowguard`, `flowguard-mcp`, and the `flowguard-hook-*` binaries) must exist, be a regular file, and carry the Node shebang. A missing or corrupt runtime binary — or a missing/invalid `bin` manifest — is reported as a failure and makes `doctor` exit non-zero (fail-closed).

The trust report surfaces:

- Expected host capability shape and enforcement level from FlowGuard's Host Adapter contract.
- Runtime activation as `NOT_VERIFIED_RUNTIME` unless a runtime probe has actually executed.
- Claude/Codex reviewer agents/subagents as transport/isolation only.
- Approval primitive as FlowGuard `/review-decision` / `flowguard_decision` with validated obligation-bound `ReviewFindings`.
- Receipt-preservation fields, explicitly marking values not preserved by host transport instead of fabricating them.

For Codex, `doctor --host codex` also reports `NOT_VERIFIED_NATIVE_LOAD`, requires `[features].plugin_hooks = true`, reminds operators to review `/hooks` trust prompts, and calls out that `PreToolUse` is a guardrail for `Bash` and `apply_patch`, not a complete security boundary.

Expected output:

```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/plugins/flowguard/index.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (installed command files)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [warn] OpenCode V2 runtime load, INACTIVE parity, operator UI and reviewer assurance NOT_VERIFIED
  [ok] flowguard.json — config valid (defaults only)

  N/N checks passed
```

`/start` is registered natively by the FlowGuard plugin and is never installed as
a command file. Install and `doctor` refuse a target that contains
`commands/start.md`, whoever owns it, with `MANAGED_ARTIFACT_CONFLICT`: such a
file would collide with the native command. Move or rename it, then retry;
`--force` does not remove it.

## Install from Local Source Checkout

Dogfood installation from a source checkout is owned by the
[Development and Debugging guide](./development/debugging.md#10-dogfood-installation-from-source).
Use `npm ci` there for reproducible installation from the committed lockfile;
use `npm install` only when intentionally changing dependencies.

## Project-Bound Installation (Recommended for Teams)

For teams that want FlowGuard integrated into their project workflow:

```json
{
  "scripts": {
    "flowguard:install": "npx --package ./vendor/flowguard-core-1.2.0 flowguard install --core-tarball ./vendor/flowguard-core-1.2.0",
    "flowguard:doctor": "npx --package ./vendor/flowguard-core-1.2.0 flowguard doctor"
  }
}
```

Then run:

```bash
npm run flowguard:install
npm run flowguard:doctor
```

## Installation Options

| Option                                         | Description                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--install-scope global`                       | Install to `~/.config/opencode/` (default)                                         |
| `--install-scope repo`                         | Install to `.opencode/` (committed to repo)                                        |
| `--host opencode\|claude-code\|codex`          | Host alias for `--platform` during install; runtime host for `flowguard run/serve` |
| `--platform opencode\|claude-code\|codex`      | Select host integration target                                                     |
| `--policy-mode solo\|team\|team-ci\|regulated` | Set default policy mode (persisted to `flowguard.json`); defaults to `team`        |
| `--core-tarball <path>`                        | **Required.** Path to `flowguard-core-{version}.tgz`                               |
| `--checksums-file <path>`                      | Optional explicit checksum file. Defaults to `checksums.sha256` next to tarball    |
| `--allow-unverified-tarball`                   | Explicit supply-chain opt-out; not recommended and logged                          |
| `--restart-host`                               | Restart the exact running OpenCode service after an applied install (default)      |
| `--no-restart-host`                            | Verify read-only; never restart the host automatically                             |

## Malformed JSON Recovery

Malformed OpenCode JSON/JSONC blocks installation without changing the file.
For installer-managed `package.json` recovery, FlowGuard writes a timestamped
`.flowguard-backup-*` before replacement; a failed backup blocks the write.

Inspect the backup, repair the malformed JSON if needed, then rerun `flowguard install --force`.

## Headless Runtime Host Selection

Headless host selection, wrapper status, and direct-host operation are owned by
[Distribution Model](./distribution-model.md#headless-operation).

## How It Works

In OpenCode chat, use the normal product sequence `/start`, `/task`, `/plan`,
`/approve`, `/implement`, and `/export`. FlowGuard runs validation automatically;
use `/check` only for manual recovery or explicit evidence recording.

The complete user-command, compatibility, and internal-tool reference is
[Commands](./commands.md). It is the canonical command surface.

### User-Facing Commands (OpenCode Workflow)

See [Commands](./commands.md#daily-workflow) for the normal workflow and its
complete product-command reference.

### Internal Tool Bindings (OpenCode Infrastructure)

See [Command Surface](./commands.md#command-surface) for the installed internal
tool bindings.

### Active-host and unproven-configuration safeguards

An uninstall deletes provably managed files; it does **not** guarantee that
an already running OpenCode service has unloaded its prior plugin instance.
If a native plugin entry was removed, the CLI prints an explicit next-step
notice: finish active work, reload that location or restart the service, and
verify the live plugin list no longer contains FlowGuard. Never interpret
file deletion alone as proof of host unload.

When a valid, scope-matched ownership manifest is absent, an existing
`flowguard.json` is preserved byte-for-byte instead of being deleted:
its ownership cannot be inferred from its filename. A partial/orphaned
installation may therefore require explicit operator cleanup after the
remaining artifacts are independently verified.

## Uninstall

```bash
npx --package ./flowguard-core-{version}.tgz flowguard uninstall
```

Uninstall removes the proven managed OpenCode entrypoint and restores recorded
package-declaration changes. Removing an installer-created `package.json` does
not prove ownership of the contents of `node_modules`: a nonempty dependency
directory is preserved and reported, including any later-added files inside
`@flowguard/core`. Symlinks and non-directory dependency roots are also preserved;
only an empty directory is removed. Retained dependency bytes do not register the
removed plugin. Inspect them before any manual cleanup; do not delete a shared
dependency tree merely because FlowGuard was installed there.

## Local Development

Use the [Development Guide](./development/index.md) for contributor setup,
debugging, and dogfooding. `npm ci` installs exactly from the lockfile for a
reproducible checkout. Use `npm install` when deliberately changing
dependencies; it is the repository's required lockfile update command.

## Headless Operation

Headless operation is available through the selected host's native CLI. The
complete OpenCode, Claude Code, Codex, wrapper, and ACP guidance is in
[Distribution Model](./distribution-model.md#headless-operation).

### Non-Interactive Mode (opencode run)

Use the [central headless guide](./distribution-model.md#headless-operation)
for the supported host CLI commands and their fail-closed input behavior.

### HTTP API Mode (opencode serve)

Use the [central headless guide](./distribution-model.md#http-api-mode-opencode-serve)
for OpenCode server authentication, session creation, and message examples.

### ACP Mode (Experimental)

Use the [central headless guide](./distribution-model.md#acp-mode-experimental)
for ACP's experimental STDIN/STDOUT integration path.

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: npx --package ./flowguard-core-1.2.0 flowguard install --core-tarball ./flowguard-core-1.2.0
Download from: https://github.com/koeppben23/governed-runtime/releases
```

Ensure you have downloaded `flowguard-core-{version}.tgz` from the releases page.

### Tools not discovered

```bash
# Reinstall tools (requires --core-tarball again)
npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz --force

# Check OpenCode config
opencode doctor
```

### Permission errors

```bash
# Check write permissions
ls -la ~/.config/opencode/

# Fix permissions if needed
chmod 755 ~/.config/opencode/
```
