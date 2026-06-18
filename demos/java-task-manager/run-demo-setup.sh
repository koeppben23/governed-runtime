#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 [--prepare-only | --install --tarball <tgz>] <target-dir>

Modes:
  --prepare-only               Copy seed, git init, commit (default).
  --install --tarball <tgz>    Prepare + install FlowGuard from tarball.

Examples:
  $0 /tmp/flowguard-java-demo
  $0 --install --tarball /tmp/flowguard-core-1.2.0.tgz /tmp/flowguard-java-demo
EOF
    exit 1
}

# ─── Parse args ───────────────────────────────────────────────────────────────

MODE="prepare-only"
TARBALL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prepare-only) MODE="prepare-only"; shift ;;
        --install)      MODE="install"; shift ;;
        --tarball)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --tarball requires a path argument." >&2
                usage
            fi
            TARBALL="$2"; shift 2 ;;
        -h|--help)      usage ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            TARGET_DIR="$1"
            shift
            ;;
    esac
done

if [[ -z "${TARGET_DIR:-}" ]]; then
    echo "Error: <target-dir> is required." >&2
    usage
fi

if [[ "$MODE" == "install" && -z "$TARBALL" ]]; then
    echo "Error: --install requires --tarball <path>." >&2
    usage
fi

# ─── Locate seed ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_DIR="$SCRIPT_DIR/seed"

if [[ ! -d "$SEED_DIR" ]]; then
    echo "Error: seed directory not found at $SEED_DIR" >&2
    exit 1
fi

if [[ "$MODE" == "install" && ! -f "$TARBALL" ]]; then
    echo "Error: tarball not found: $TARBALL" >&2
    exit 1
fi

# Resolve tarball to absolute path before cd, so relative paths survive the cd into TARGET_DIR
if [[ "$MODE" == "install" ]]; then
    TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
fi

# ─── Prepare ──────────────────────────────────────────────────────────────────

echo "=== FlowGuard Demo Setup ==="
echo "Source: $SEED_DIR"
echo "Target: $TARGET_DIR"

if [[ -d "$TARGET_DIR" ]]; then
    echo "Error: target directory already exists: $TARGET_DIR" >&2
    echo "Run 'rm -rf $TARGET_DIR' first, or see RESET.md." >&2
    exit 1
fi

echo ""
echo "--- Copying seed ---"
cp -R "$SEED_DIR" "$TARGET_DIR"

echo "--- Initializing git repository ---"
cd "$TARGET_DIR"
git init --initial-branch main
git config user.email "demo@flowguard"
git config user.name "FlowGuard Demo"
git add -A
git commit -m "Initial: Java Task Manager with known bug"

echo ""
echo "--- Creating demo review branch ---"
git checkout -b feature/add-due-date
cp "$SCRIPT_DIR/review-fixtures/Task.java" \
   "$TARGET_DIR/src/main/java/com/example/taskmanager/model/Task.java"
cp "$SCRIPT_DIR/review-fixtures/CreateTaskRequest.java" \
   "$TARGET_DIR/src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java"
git add -A
git commit -m "Add dueDate field"
git checkout main

echo ""
echo "--- Git status ---"
git status --short
# Expected: no output (clean working tree)

# ─── Install FlowGuard (optional) ─────────────────────────────────────────────

if [[ "$MODE" == "install" ]]; then
    echo ""
    echo "--- Installing FlowGuard ---"
    npx --package "$TARBALL" flowguard install \
        --install-scope repo \
        --policy-mode team \
        --core-tarball "$TARBALL" \
        --force

    echo ""
    echo "--- Verifying FlowGuard install ---"
    # Fail closed: the demo must not proceed to `opencode serve` on a broken
    # install. Assert the artifacts the OpenCode installer writes for repo scope.
    install_ok=1

    if [[ -f opencode.json || -f opencode.jsonc ]]; then
        echo "  ok: opencode config present"
    else
        echo "  MISSING: opencode.json / opencode.jsonc" >&2
        install_ok=0
    fi

    if [[ -f .opencode/agents/flowguard-reviewer.md ]]; then
        echo "  ok: .opencode/agents/flowguard-reviewer.md"
    else
        echo "  MISSING: .opencode/agents/flowguard-reviewer.md" >&2
        install_ok=0
    fi

    if [[ -d .opencode/commands ]]; then
        echo "  ok: .opencode/commands/ ($(ls .opencode/commands 2>/dev/null | wc -l | tr -d ' ') commands)"
    else
        echo "  MISSING: .opencode/commands/ (FlowGuard slash commands)" >&2
        install_ok=0
    fi

    if [[ "$install_ok" -ne 1 ]]; then
        echo "" >&2
        echo "Error: FlowGuard install verification failed. Do not start the demo." >&2
        echo "Check the 'flowguard install' output above and the tarball path." >&2
        exit 1
    fi
    echo "--- FlowGuard install verified ---"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== Setup complete ==="
echo ""
echo "--- Prepared branches ---"
git branch --list
echo ""
echo "--- Branch history ---"
git log --oneline --decorate --all --graph
echo ""
echo "Next steps:"
echo "  cd $TARGET_DIR"
echo "  ./mvnw test           # Verify: 16 tests, 0 failures, 1 skipped"
if [[ "$MODE" == "prepare-only" ]]; then
    echo "  # Install FlowGuard and start OpenCode Desktop:"
    echo "  npx --package <tarball> flowguard install --install-scope repo --policy-mode team --core-tarball <tarball> --force"
fi
echo "  # Open $TARGET_DIR in OpenCode Desktop"
echo "  # Then follow DEMO_SCRIPT.md"
