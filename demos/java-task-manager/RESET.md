# Reset the Demo

## Real Reset (recommended)

A real reset is a **fresh workspace plus an exact tarball install plus a fresh
`/start`**. Only this produces a clean FlowGuard session; restoring workspace
files never does.

```bash
# Option A: Delete and recreate with setup script (recommended)
rm -rf /tmp/flowguard-java-demo
./demos/java-task-manager/run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo

# Then open the workspace in OpenCode Desktop and start a fresh session:
# /start
```

```bash
# Option B: Prepare-only, then install manually
rm -rf /tmp/flowguard-java-demo
./demos/java-task-manager/run-demo-setup.sh --prepare-only /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
npx --package /path/to/flowguard-core-*.tgz flowguard install --install-scope repo --policy-mode team --core-tarball /path/to/flowguard-core-*.tgz --force

# Then open the workspace in OpenCode Desktop and start a fresh session:
# /start
```

```bash
# Option C: Git-based reset (if already in the demo directory)
cd /tmp/flowguard-java-demo
git checkout -- .
git clean -fd
rm -rf .flowguard/ .opencode/

# Then run the exact tarball install and start a fresh session:
npx --package /path/to/flowguard-core-*.tgz flowguard install --install-scope repo --policy-mode team --core-tarball /path/to/flowguard-core-*.tgz --force
# /start
```

The seed is a standalone git repository. The setup script copies it, runs
`git init && git add -A && git commit -m "Initial"` to create a clean
starting point.

```bash
# Verify clean state
./mvnw test                  # 16 tests, 0 failures, 1 skipped
git status --short           # Expected: no output
```

## Snapshots and Authority

Workspace snapshots (see `snapshot-demo.sh`) are **visual only**. Restoring a
snapshot **never** restores or resumes FlowGuard authority:

- session state, review obligations, audit chain, review cycles, and human
  decisions all live outside the workspace (under `~/.config/opencode/`);
- a restored workspace is a visual exhibit, not a resumable governed session.

After any snapshot restore, start a fresh session with `/start`, or present the
snapshot as prerecorded evidence. For a clean governed run, use the real reset
above.

## Transition Between Flows

All three flows run in the same workspace. Between Part 1 (Architecture) and
Part 2 (Development), close OpenCode Desktop and reopen the workspace —
the Architecture Flow does not modify files, so no snapshot restore is needed.
A fresh MCP transport creates a new sessionId and a fresh `/start`.

## Snapshot Recovery

Restore a saved visual-only workspace checkpoint instead of starting fresh:

```bash
./demos/java-task-manager/snapshot-demo.sh restore 01-plan-approved-visual-only /tmp/flowguard-java-demo
```

All snapshot labels end in `-visual-only`
(`00-seed-visual-only`, `01-plan-approved-visual-only`,
`02-implemented-visual-only`, `03-export-ready-visual-only`,
`04-exported-visual-only`, `A02-adr-reviewed-visual-only`,
`A03-arch-complete-visual-only`). They restore workspace files only and never
FlowGuard authority. See `FALLBACK.md` for recovery strategy.

See `snapshot-demo.sh` for labels and usage.

## Pre-flight

Run pre-flight checks before a live pitch:

```bash
demos/java-task-manager/run-demo-preflight.sh \
  --tarball <tgz> \
  /tmp/flowguard-java-demo
```
