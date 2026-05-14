# Debugging FlowGuard inside OpenCode with IntelliJ IDEA Ultimate

## Prerequisites

- `opencode` CLI installed and available
- Node.js 20+
- IntelliJ IDEA Ultimate
- Local FlowGuard checkout (this repository)

## 1. Build and package FlowGuard

```bash
npm ci
npm run build

TARBALL="$(npm pack --silent | tail -n 1)"
```

## 2. Install FlowGuard globally for OpenCode

```bash
npx --yes --package "./$TARBALL" flowguard install \
  --core-tarball "./$TARBALL" \
  --install-scope global \
  --force

npx --yes --package "./$TARBALL" flowguard doctor \
  --install-scope global
```

## 3. Start OpenCode with the Node.js inspector

```bash
NODE_OPTIONS="--inspect-brk=9229" opencode
```

Use `--inspect=9229` instead of `--inspect-brk=9229` if OpenCode should not pause on startup.

> **Note:** This works when the installed OpenCode runtime honors Node.js `NODE_OPTIONS`. If no inspector port opens, verify how your OpenCode binary is launched.

## 4. Attach IntelliJ IDEA Ultimate

1. Open **Run** > **Edit Configurations...**
2. Add **Attach to Node.js/Chrome**
3. Set **Host** to `localhost`
4. Set **Port** to `9229`
5. Start the configuration
6. Trigger a FlowGuard command in OpenCode (e.g. `/start`, `/task`, `/plan`, `/status`)

## 5. Breakpoint locations

Useful starting points:

- `src/integration/plugin.ts`
- `src/integration/plugin-task-evidence.ts`
- `src/integration/tools/review-validation.ts`
- `src/integration/tools/simple-tools.ts`
- `src/adapters/persistence.ts`
- `src/config/policy-resolver.ts`

If TypeScript source breakpoints do not bind, run `npm run build` again and reinstall the tarball so source maps match the installed dist files.

As a fallback, set breakpoints directly in the compiled output under the OpenCode configuration directory:

```
~/.config/opencode/node_modules/@flowguard/core/dist/
```
