# Reset the Demo

To reset for a fresh presentation:

```bash
# Option A: Delete and recreate with setup script (recommended)
rm -rf /tmp/flowguard-java-demo
./demos/java-task-manager/run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo

# Option B: Prepare-only, then install manually
rm -rf /tmp/flowguard-java-demo
./demos/java-task-manager/run-demo-setup.sh --prepare-only /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
npx --package /path/to/flowguard-core-*.tgz flowguard install --install-scope repo --policy-mode team --core-tarball /path/to/flowguard-core-*.tgz --force

# Option C: Git-based reset (if already in the demo directory)
cd /tmp/flowguard-java-demo
git checkout -- .
git clean -fd
rm -rf .flowguard/ .opencode/

# Verify clean state
./mvnw test                  # 16 tests, 0 failures, 1 skipped
git status --short           # Expected: no output
```

The seed is a standalone git repository. The setup script copies it, runs
`git init && git add -A && git commit -m "Initial"` to create a clean
starting point.

## Transition Between Flows

All three flows run in the same workspace. Between Part 1 (Architecture) and
Part 2 (Implementation), close OpenCode Desktop and reopen the workspace —
the Architecture flow does not modify files, so no snapshot restore is needed.
A fresh MCP transport creates a new sessionId.

For a full reset to the initial state, use Option A above or restore the
`00-seed` snapshot:

```bash
./demos/java-task-manager/snapshot-demo.sh restore 00-seed /tmp/flowguard-java-demo
```

## Snapshot Recovery

Restore a saved workspace checkpoint instead of starting fresh:

```bash
./demos/java-task-manager/snapshot-demo.sh restore 01-plan-approved /tmp/flowguard-java-demo
```

Architecture snapshots (`A02-adr-reviewed`, `A03-arch-complete`) restore
workspace evidence only. They do **not** restore FlowGuard session state
(stored in `~/.config/opencode/`). See `FALLBACK.md` for recovery strategy.

See `snapshot-demo.sh` for labels and usage.

## Pre-flight

Run pre-flight checks before a live pitch:

```bash
demos/java-task-manager/run-demo-preflight.sh \
  --tarball <tgz> \
  /tmp/flowguard-java-demo
```
