# Installation

## Prerequisites

- Node.js 20+
- Bun (recommended) or npm
- OpenCode

## Global Installation

```bash
# Install the FlowGuard package
npm install -g @flowguard/core

# Set up OpenCode integration
npx @flowguard/core install
```

### Options

| Option | Description |
|--------|-------------|
| `--install-scope global` | Install to `~/.config/opencode/` (default) |
| `--install-scope repo` | Install to `.opencode/` (committed to repo) |
| `--policy-mode solo\|team\|regulated` | Set default policy mode |

## Verify Installation

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

## Uninstall

```bash
flowguard uninstall
```

## Local Development

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

## OpenCode Integration

FlowGuard integrates with OpenCode via custom tools. After installation:

1. OpenCode discovers tools in `~/.config/opencode/tools/`
2. FlowGuard tools are installed there automatically
3. Use `/flowguard_<command>` to invoke

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
