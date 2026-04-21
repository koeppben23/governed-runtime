# Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases. No build step required.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that repository snapshot.

## Prerequisites

- Node.js 20+
- npm
- OpenCode

## Installation Steps

### 1. Download the Release Artifact

Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

Verify the checksum:

```bash
sha256sum flowguard-core-{version}.tgz
```

### 2. Initialize OpenCode Integration (Standard)

The approved local tarball is the authoritative package source. npm/npx may use an internal cache, but no global installation is required.

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz
cd ~/.config/opencode && npm install

# Verify
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

### 3. Verify Installation

```bash
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

Expected output:

```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (10 command files total)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json
  [ok] config.json — config valid (defaults only)

  N/N checks passed
```

## Project-Bound Installation (Recommended for Teams)

For teams that want FlowGuard integrated into their project workflow:

```json
{
  "scripts": {
    "flowguard:install": "npx --package ./vendor/flowguard-core-1.1.0.tgz flowguard install --core-tarball ./vendor/flowguard-core-1.1.0.tgz",
    "flowguard:doctor": "npx --package ./vendor/flowguard-core-1.1.0.tgz flowguard doctor"
  }
}
```

Then run:

```bash
npm run flowguard:install
npm run flowguard:doctor
```

## Installation Options

| Option                                         | Description                                          |
| ---------------------------------------------- | ---------------------------------------------------- |
| `--install-scope global`                       | Install to `~/.config/opencode/` (default)           |
| `--install-scope repo`                         | Install to `.opencode/` (committed to repo)          |
| `--policy-mode solo\|team\|team-ci\|regulated` | Set default policy mode (persisted to `config.json`) |
| `--core-tarball <path>`                        | **Required.** Path to `flowguard-core-{version}.tgz` |

## How It Works

FlowGuard integrates with OpenCode via a two-level command surface:

### User-Facing Commands (OpenCode Workflow)

Use these commands in OpenCode chat to drive workflows:

| Command                            | Description       |
| ---------------------------------- | ----------------- |
| `/hydrate`                         | Bootstrap session |
| `/ticket <text>`                   | Record task       |
| `/plan`                            | Generate plan     |
| `/continue`                        | Auto-advance      |
| `/validate`                        | Run checks        |
| `/implement`                       | Execute plan      |
| `/review-decision approve\|reject` | Human approval    |
| `/review`                          | Generate report   |
| `/abort`                           | Terminate session |
| `/archive`                         | Archive session   |

### Internal Tool Bindings (OpenCode Infrastructure)

These are the underlying tool names that FlowGuard installs into OpenCode:

| Tool Name                 | Purpose                    |
| ------------------------- | -------------------------- |
| `flowguard_status`        | Check session state        |
| `flowguard_hydrate`       | Session bootstrap          |
| `flowguard_ticket`        | Task recording             |
| `flowguard_plan`          | Plan generation            |
| `flowguard_decision`      | Record review verdict      |
| `flowguard_validate`      | Validation runner          |
| `flowguard_implement`     | Plan executor              |
| `flowguard_review`        | Generate compliance report |
| `flowguard_abort_session` | Session termination        |
| `flowguard_archive`       | Session archival           |

## Uninstall

```bash
npx --package ./flowguard-core-{version}.tgz flowguard uninstall
```

## Local Development

For development on FlowGuard itself:

```bash
# Clone repository
git clone https://github.com/koeppben23/governed-runtime.git
cd governed-runtime

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run check
```

## Headless Operation

FlowGuard runs within the OpenCode host runtime. Headless operation is achieved by using OpenCode's headless modes.

### Non-Interactive Mode (opencode run)

For scripting and automation without the TUI:

```bash
# Start a headless server (avoids MCP cold boot on each run)
opencode serve &
SERVER_PID=$!

# Run FlowGuard commands via the API
opencode run "Run /hydrate with policyMode=team-ci"

# Or use the HTTP API directly
curl -X POST http://localhost:4096/session/{sessionId}/message \
  -H "Content-Type: application/json" \
  -d '{"message": {"role": "user", "parts": [{"type": "text", "text": "/validate"}]}}'

# Stop the server
kill $SERVER_PID
```

### HTTP API Mode (opencode serve)

Start the OpenCode HTTP server for API access:

```bash
# With optional basic auth
OPENCODE_SERVER_PASSWORD=secret opencode serve --port 4096
```

Then use the REST API directly:

```bash
# Create session
curl -X POST http://localhost:4096/session -H "Content-Type: application/json" \
  -d '{"title": "flowguard-session"}'

# Send message
curl -X POST http://localhost:4096/session/{sessionId}/message \
  -H "Content-Type: application/json" \
  -d '{"message": {"role": "user", "parts": [{"type": "text", "text": "/hydrate policyMode=team-ci"}]}}'
```

See the [OpenCode Server Documentation](https://opencode.ai/docs/server/) for the full API reference.

### ACP Mode (Experimental)

For STDIN/STDOUT-based integration:

```bash
opencode acp
```

This uses nd-JSON for communication via stdin/stdout.

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: npx --package ./flowguard-core-1.1.0.tgz flowguard install --core-tarball ./flowguard-core-1.1.0.tgz
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
