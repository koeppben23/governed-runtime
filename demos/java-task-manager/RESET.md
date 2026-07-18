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

## Reset Between Parts

Part 1 (Architecture) and Part 2 (Implementation) share the same workspace.
Reset between them:

```bash
# 1. Close OpenCode Desktop
# 2. Restore the 00-seed snapshot
./demos/java-task-manager/snapshot-demo.sh restore 00-seed /tmp/flowguard-java-demo
# 3. Reopen /tmp/flowguard-java-demo in OpenCode Desktop
#    (creates a fresh MCP transport with a new sessionId)
# 4. /start → fresh READY session for Part 2
```

The architecture export archive survives the reset. It is stored in
`~/.config/opencode/workspaces/.../archive/`, outside the workspace directory.

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
