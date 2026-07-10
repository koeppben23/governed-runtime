#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 save <label> <workspace>
       $0 restore <label> <workspace>

Create or restore demo workspace checkpoints for pitch recovery.

Labels:
  00-seed, 01-plan-approved, 02-implemented, 03-complete, 04-exported

Examples:
  $0 save 02-implemented /tmp/flowguard-java-demo
  $0 restore 01-plan-approved /tmp/flowguard-java-demo
EOF
    exit 1
}

# ─── Config ───────────────────────────────────────────────────────────────────

CHECKPOINT_ROOT="/tmp/flowguard-demo-checkpoints"
RSYNC_EXCLUDES=('target/' 'node_modules/' '.m2/' '.npm/')
RSYNC_FLAGS="-a --delete"

# ─── Parse args ───────────────────────────────────────────────────────────────

if [[ $# -lt 3 ]]; then
    usage
fi

ACTION="$1"
LABEL="$2"
WORKSPACE="$3"

shift 3

# ─── Validate action ──────────────────────────────────────────────────────────

if [[ "$ACTION" != "save" && "$ACTION" != "restore" ]]; then
    echo "Error: action must be 'save' or 'restore', got '$ACTION'." >&2
    usage
fi

# ─── Validate label ──────────────────────────────────────────────────────────

ALLOWED_LABELS=('00-seed' '01-plan-approved' '02-implemented' '03-complete' '04-exported')
LABEL_VALID=0
for allowed in "${ALLOWED_LABELS[@]}"; do
    if [[ "$LABEL" == "$allowed" ]]; then
        LABEL_VALID=1
        break
    fi
done
if [[ "$LABEL_VALID" -eq 0 ]]; then
    echo "Error: unknown label '$LABEL'. Allowed: ${ALLOWED_LABELS[*]}" >&2
    exit 1
fi

# ─── Validate workspace path ──────────────────────────────────────────────────

if [[ ! -d "$WORKSPACE" ]]; then
    echo "Error: workspace not found: $WORKSPACE" >&2
    exit 1
fi

WORKSPACE="$(cd "$WORKSPACE" && pwd)"

# Guard: workspace must be under an expected demo workspace prefix
if [[ "$WORKSPACE" != /tmp/flowguard-java-* ]]; then
    echo "Error: workspace must be under /tmp/flowguard-java-* (got: $WORKSPACE)" >&2
    exit 1
fi

# Guard: workspace path must not contain traversal components after resolution
if [[ "$WORKSPACE" == *".."* ]]; then
    echo "Error: workspace path contains traversal components: $WORKSPACE" >&2
    exit 1
fi

# ─── Restore safety guards ───────────────────────────────────────────────────

if [[ "$ACTION" == "restore" ]]; then
    # Guard: workspace is not /
    if [[ "$WORKSPACE" == "/" ]]; then
        echo "Error: will not restore to /" >&2
        exit 1
    fi

    # Guard: workspace is not $HOME
    if [[ "$WORKSPACE" == "$HOME" ]]; then
        echo "Error: will not restore to \$HOME" >&2
        exit 1
    fi

    # Guard: workspace is not empty
    if [[ -z "$(ls -A "$WORKSPACE" 2>/dev/null)" ]]; then
        echo "Error: workspace is empty, refusing to restore: $WORKSPACE" >&2
        exit 1
    fi

    # Guard: workspace contains expected markers
    if [[ ! -f "$WORKSPACE/.git" && ! -d "$WORKSPACE/.git" ]]; then
        echo "Error: workspace does not contain .git marker: $WORKSPACE" >&2
        exit 1
    fi
    if [[ ! -f "$WORKSPACE/pom.xml" ]]; then
        echo "Error: workspace does not contain pom.xml marker: $WORKSPACE" >&2
        exit 1
    fi
fi

# ─── Validate checkpoint ──────────────────────────────────────────────────────

CHECKPOINT_DIR="$CHECKPOINT_ROOT/$LABEL"

# Guard: label is validated against an explicit allow-list above, so
# CHECKPOINT_DIR is guaranteed to be a safe path under CHECKPOINT_ROOT.

if [[ "$ACTION" == "restore" ]]; then
    if [[ ! -d "$CHECKPOINT_DIR" ]]; then
        echo "Error: checkpoint not found: $CHECKPOINT_DIR" >&2
        echo "Available checkpoints:" >&2
        ls -1 "$CHECKPOINT_ROOT" 2>/dev/null || echo "  (none)" >&2
        exit 1
    fi

    # Guard: checkpoint contains expected markers
    if [[ ! -f "$CHECKPOINT_DIR/.git" && ! -d "$CHECKPOINT_DIR/.git" ]]; then
        echo "Error: checkpoint does not contain .git marker: $CHECKPOINT_DIR" >&2
        exit 1
    fi
    if [[ ! -f "$CHECKPOINT_DIR/pom.xml" ]]; then
        echo "Error: checkpoint does not contain pom.xml marker: $CHECKPOINT_DIR" >&2
        exit 1
    fi
fi

# ─── Execute ──────────────────────────────────────────────────────────────────

mkdir -p "$CHECKPOINT_ROOT"

case "$ACTION" in
    save)
        echo "Saving checkpoint: $LABEL"
        echo "  Source: $WORKSPACE"
        echo "  Target: $CHECKPOINT_DIR"

        # Build exclude arguments for rsync
        EXCLUDE_ARGS=()
        for pattern in "${RSYNC_EXCLUDES[@]}"; do
            EXCLUDE_ARGS+=(--exclude "$pattern")
        done

        rsync $RSYNC_FLAGS "${EXCLUDE_ARGS[@]}" "$WORKSPACE/" "$CHECKPOINT_DIR/"
        echo "  Done. Checkpoint saved: $CHECKPOINT_DIR"
        ;;
    restore)
        echo "Restoring checkpoint: $LABEL"
        echo "  Source: $CHECKPOINT_DIR"
        echo "  Target: $WORKSPACE"

        # Remove build artefacts that rsync --delete does not cover
        # (excluded dirs are skipped, so leftover target/node_modules survive)
        echo "  Cleaning excluded build artefacts..."
        rm -rf "$WORKSPACE/target" "$WORKSPACE/node_modules"

        EXCLUDE_ARGS=()
        for pattern in "${RSYNC_EXCLUDES[@]}"; do
            EXCLUDE_ARGS+=(--exclude "$pattern")
        done

        rsync $RSYNC_FLAGS "${EXCLUDE_ARGS[@]}" "$CHECKPOINT_DIR/" "$WORKSPACE/"
        echo "  Done. Workspace restored from checkpoint."
        echo "  Reopen $WORKSPACE in OpenCode Desktop to continue."
        ;;
esac
