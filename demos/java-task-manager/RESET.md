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

## Resetting the Regulated Walkthrough

The regulated four-eyes walkthrough uses its own workspace and environment. Reset
both:

```bash
# 1. Discard the regulated workspace (its policy mode is baked into
#    .opencode/flowguard.json, and any tamper-evidence exhibit leaves a broken
#    audit.jsonl — do not reuse it in place).
rm -rf /tmp/flowguard-java-regulated-demo

# 2. Remove the live working-copy identity file used for the four-eyes swap.
rm -f "$HOME/flowguard-demo-actor.json"

# 3. Clear the actor identity so it does not leak into the next session.
#    bash / zsh:
unset FLOWGUARD_ACTOR_CLAIMS_PATH FLOWGUARD_ACTOR_ID FLOWGUARD_ACTOR_TOKEN_PATH
```

```text
# PowerShell:
Remove-Item "$HOME\flowguard-demo-actor.json" -ErrorAction SilentlyContinue
Remove-Item Env:FLOWGUARD_ACTOR_CLAIMS_PATH -ErrorAction SilentlyContinue
Remove-Item Env:FLOWGUARD_ACTOR_ID -ErrorAction SilentlyContinue
Remove-Item Env:FLOWGUARD_ACTOR_TOKEN_PATH -ErrorAction SilentlyContinue
```

> `Remove-Item Env:...` and `unset` only clear the **current shell**. If you made
> the variable persistent (e.g. `setx` on Windows or a shell profile on
> macOS/Linux), remove it there too, otherwise the next launched OpenCode inherits
> it.

Because the policy mode lives in the workspace config, never switch a workspace
between `team` and `regulated` in place — always use a fresh target directory.
