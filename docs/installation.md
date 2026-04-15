# Installation

FlowGuard is distributed via GitHub Releases. This ensures controlled, auditable distribution.

## Prerequisites

- Node.js 20+
- Bun (recommended) or npm
- OpenCode

## Installation Steps

### 1. Download the Release

Download the latest release from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

The release contains:
- Source code snapshot
- Built artifacts
- Installation instructions
- Version information

### 2. Install the Package

```bash
# From the release directory
npm install -g ./

# Or with Bun
bun add -g ./
```

### 3. Set Up OpenCode Integration

```bash
# Initialize FlowGuard in your OpenCode environment
npx flowguard install

# Or with the installed CLI
flowguard install
```

### 4. Verify Installation

```bash
flowguard doctor
```

Expected output:
```
✓ FlowGuard installed
✓ Version: 1.3.0
✓ OpenCode tools directory found
✓ Configuration valid
```

## Installation Options

| Option | Description |
|--------|-------------|
| `--install-scope global` | Install to `~/.config/opencode/` (default) |
| `--install-scope repo` | Install to `.opencode/` (committed to repo) |
| `--policy-mode solo\|team\|regulated` | Set default policy mode |

## How It Works

FlowGuard integrates with OpenCode via custom tools:

1. OpenCode discovers tools in `~/.config/opencode/tools/`
2. FlowGuard tools are installed there automatically
3. Use `/<command>` to invoke FlowGuard commands

### Available Commands

| Command | Description |
|---------|-------------|
| `/hydrate` | Bootstrap session |
| `/ticket <text>` | Record task |
| `/plan` | Generate plan |
| `/continue` | Auto-advance |
| `/validate` | Run checks |
| `/implement` | Execute plan |
| `/review-decision` | Human approval |
| `/review` | Generate report |
| `/abort` | Terminate session |
| `/archive` | Archive session |

## Uninstall

```bash
flowguard uninstall
```

## Local Development

For development on FlowGuard itself:

```bash
# Clone repository
git clone https://github.com/koeppben23/governed-runtime.git
cd governed-runtime

# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

## Troubleshooting

### Tools not discovered

```bash
# Reinstall tools
flowguard install --force

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
